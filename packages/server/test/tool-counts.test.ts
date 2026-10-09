import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import type { Config } from "../src/config.js";

/**
 * The tool counts written into README.md and docs/HANDOFF.md must equal what the
 * server actually advertises. Nothing enforced these before, so they drifted
 * (README said After Effects had 33 tools; the registry has 34). This test is the
 * guard: it counts the LIVE registry under the default config — what a user sees.
 * The raw-script tools (cc_eval_script, ps_batch_play) and cc_get_capabilities are
 * part of that default registry: since X-01 they are always listed and refuse while
 * their gate is closed. Only the Illustrator-delegate tools stay out (they register
 * only with a configured key). It fails, printing the right number, when a doc
 * disagrees. Prompt X-03.
 */
const config: Config = {
  bridgePort: 0,
  bridgeToken: "",
  bridgeInsecure: true,
  evalTimeoutMs: 2_000,
  heartbeatIntervalMs: 0,
  allowRawScripts: false,
  rawScriptApps: [],
  rawScriptIgnored: [],
  allowRemoteRawScripts: false,
  handshakeFilePath: "",
  allowedOrigins: [],
  illustratorMcpUrl: "http://localhost:18412/v1/mcp",
  illustratorMcpKey: "",
  illustratorApp: "",
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  ameWebServicePath: "",
  amePort: 0,
  ameIdleMs: 0,
  httpPort: 0,
  httpHost: "127.0.0.1",
  httpToken: "",
  enabledApps: ["photoshop", "after_effects", "premiere", "illustrator", "audition", "media_encoder"],
  logLevel: "error",
  defaultWait: true,
  preview: "both",
  jobWaitSeconds: 300,
};

function section(name: string): string {
  if (name.startsWith("ps_")) return "Photoshop";
  if (name.startsWith("ae_")) return "After Effects";
  if (name.startsWith("pp_")) return "Premiere Pro";
  if (name.startsWith("ai_beta_")) return "Delegate";
  if (name.startsWith("ai_")) return "Illustrator";
  if (name.startsWith("au_")) return "Audition";
  if (name.startsWith("ame_")) return "Media Encoder";
  if (name.startsWith("audio_")) return "Audio";
  if (name.startsWith("pipeline_")) return "Pipelines";
  if (name.startsWith("cc_job") || name === "cc_list_jobs") return "Jobs";
  if (name.startsWith("cc_")) return "CrossApp";
  return "Other";
}

async function liveCounts(): Promise<{ total: number; bySection: Record<string, number> }> {
  const built = buildServer(config);
  await built.bridge.ready();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "counts", version: "0" });
  await Promise.all([c.connect(ct), built.server.connect(st)]);
  const names = (await c.listTools()).tools.map((t) => t.name);
  await c.close();
  await built.server.close();
  await built.bridge.close();
  const bySection: Record<string, number> = {};
  for (const n of names) bySection[section(n)] = (bySection[section(n)] ?? 0) + 1;
  return { total: names.length, bySection };
}

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const readme = () => readFileSync(join(repoRoot, "README.md"), "utf8");
const handoff = () => readFileSync(join(repoRoot, "docs", "HANDOFF.md"), "utf8");

/** The number after an em-dash in a "### <Section> — N tools" README header. */
function headerCount(text: string, label: string): number | null {
  const m = new RegExp(`### ${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} — (\\d+) tools`).exec(text);
  return m ? Number(m[1]) : null;
}

describe("documented tool counts match the live registry", () => {
  it("README per-app section headers are correct", async () => {
    const { bySection } = await liveCounts();
    const r = readme();
    const checks: [string, number][] = [
      ["Photoshop", bySection["Photoshop"]!],
      ["After Effects", bySection["After Effects"]!],
      ["Premiere Pro", bySection["Premiere Pro"]!],
      ["Illustrator", bySection["Illustrator"]!],
      ["Audition", bySection["Audition"]!],
      ["Media Encoder", bySection["Media Encoder"]!],
    ];
    for (const [label, expected] of checks) {
      expect(headerCount(r, label), `README '### ${label} — N tools' should be ${expected}`).toBe(expected);
    }
    // "Pipelines and jobs — N tools" = pipeline_ + cc_job_
    const pipelinesAndJobs = (bySection["Pipelines"] ?? 0) + (bySection["Jobs"] ?? 0);
    const pj = /### Pipelines and jobs — (\d+) tools/.exec(r);
    expect(pj && Number(pj[1]), `README 'Pipelines and jobs' should be ${pipelinesAndJobs}`).toBe(pipelinesAndJobs);
  });

  it("README and HANDOFF totals match the advertised total", async () => {
    const { total } = await liveCounts();
    const rTotal = /\*\*(\d+) tools\*\* across/.exec(readme());
    expect(rTotal && Number(rTotal[1]), `README '**N tools** across' should be ${total}`).toBe(total);
    const hTotal = /Expect (\d+) tools/.exec(handoff());
    expect(hTotal && Number(hTotal[1]), `HANDOFF 'Expect N tools' should be ${total}`).toBe(total);
  });
});
