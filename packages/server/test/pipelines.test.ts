import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScriptError, type AppBridge, type JsonValue } from "../src/bridge/types.js";
import { JobRegistry } from "../src/jobs.js";
import { AE_PRELUDE_LINES } from "../src/tools/after-effects.js";
import { registerJobTools } from "../src/tools/jobs.js";
import { registerPipelineTools } from "../src/tools/pipelines.js";

type Call = { app: string; name: string; params?: JsonValue; script?: string };

function fakeBridge(appId: AppBridge["appId"], calls: Call[], answer: (c: Call) => JsonValue | Promise<JsonValue>): AppBridge {
  return {
    appId,
    isConnected: () => true,
    execute: async (name, params) => {
      const c = { app: appId, name, params };
      calls.push(c);
      return answer(c);
    },
    evaluate: async (script) => {
      const c = { app: appId, name: "eval", script };
      calls.push(c);
      return answer(c);
    },
    close: async () => {},
  };
}

describe("pipelines compose the single-app commands as one job", () => {
  let client: Client;
  let close: () => Promise<void>;
  let calls: Call[];
  let aeFails: boolean;
  let aeScriptFails: boolean;
  let psNoPath: boolean;
  let aeNoId: boolean;
  let jobs: JobRegistry;

  beforeEach(async () => {
    calls = [];
    aeFails = false;
    aeScriptFails = false;
    psNoPath = false;
    aeNoId = false;
    jobs = new JobRegistry({ workRoot: join(tmpdir(), `acm-pipe-${process.pid}`) });
    const server = new McpServer({ name: "t", version: "0" });
    const photoshop = fakeBridge("photoshop", calls, (c): JsonValue =>
      c.name === "ps.export" ? { path: psNoPath ? "" : (c.params as { path: string }).path, format: "png" } : { ok: true },
    );
    const afterEffects = fakeBridge("after_effects", calls, (c): JsonValue => {
      if (aeFails) throw new Error("AE said no");
      // The host's report for the import's `if (!f.exists)` line (body line 2).
      if (aeScriptFails) throw new ScriptError("after_effects", "No file at X", AE_PRELUDE_LINES + 3, { code: "HOST_ERROR" });
      if (c.script?.includes("importFile")) return aeNoId ? { name: "photoshop-export.png" } : { id: 42, name: "photoshop-export.png" };
      return { index: 1, name: "layer" };
    });
    const premiere = fakeBridge("premiere", calls, () => ({ ok: true }));
    const illustrator = fakeBridge("illustrator", calls, () => ({ ok: true }));
    registerJobTools(server, jobs);
    registerPipelineTools(server, { photoshop, afterEffects, premiere, illustrator, jobs, audio: { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[])[0]!.text;

  it("registers the pipeline and job tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["pipeline_ps_to_ae", "pipeline_render_and_import", "pipeline_audio_roundtrip", "pipeline_ai_to_ps", "cc_job_status", "cc_list_jobs", "cc_job_wait", "cc_job_cancel"]) expect(names, n).toContain(n);
  });

  it("ps → ae: exports to the work folder, imports, adds a layer, and reports every step", async () => {
    const r = await client.callTool({ name: "pipeline_ps_to_ae", arguments: { compId: 7, layerName: "art" } });
    expect(r.isError).not.toBe(true);
    const view = JSON.parse(text(r)) as { status: string; steps: { name: string; status: string }[]; result: { exportedPath: string; footage: { id: number }; layer: unknown }; artifacts: string[] };
    expect(view.status).toBe("succeeded");
    expect(view.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(view.result.footage.id).toBe(42);
    expect(view.result.exportedPath.endsWith("photoshop-export.png")).toBe(true);
    expect(calls.map((c) => `${c.app}:${c.name}`)).toEqual(["photoshop:ps.export", "after_effects:eval", "after_effects:eval"]);
    expect(calls[2]?.script).toContain('"footage"');
    expect(calls[2]?.script).toContain("itemByID(42)");
  });

  it("skips the layer step without a compId", async () => {
    const r = await client.callTool({ name: "pipeline_ps_to_ae", arguments: {} });
    const view = JSON.parse(text(r)) as { steps: { status: string }[] };
    expect(view.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded", "skipped"]);
  });

  it("names the failed step and its recovery tool", async () => {
    aeFails = true;
    const r = await client.callTool({ name: "pipeline_ps_to_ae", arguments: { compId: 1 } });
    expect(r.isError).toBe(true);
    const view = JSON.parse(text(r)) as { status: string; error: { step: string; recoveryTool: string; completedSteps: string[]; message: string } };
    expect(view.status).toBe("failed");
    expect(view.error).toMatchObject({ step: "Import into After Effects", recoveryTool: "ae_import_footage", completedSteps: ["Export from Photoshop"], message: "AE said no" });
  });

  it("an After Effects script failure in a step reads where it failed, with no tool echo (AE-16)", async () => {
    aeScriptFails = true;
    const r = await client.callTool({ name: "pipeline_ps_to_ae", arguments: { compId: 1 } });
    expect(r.isError).toBe(true);
    const view = JSON.parse(text(r)) as { error: { step: string; message: string } };
    expect(view.error.step).toBe("Import into After Effects");
    expect(view.error.message).toMatch(/^Script failed in After Effects at body line 2 \(script line \d+\): No file at X — /);
    expect(view.error.message).toContain(">>> 2: if (!f.exists)");
    expect(view.error.message).not.toContain("(pipeline_");
  });

  it("ps → ae: a step that gets nothing usable from the step before says what to do next (F8)", async () => {
    psNoPath = true;
    const noPath = JSON.parse(text(await client.callTool({ name: "pipeline_ps_to_ae", arguments: { compId: 1 } }))) as { error: { step: string; message: string } };
    expect(noPath.error.step).toBe("Import into After Effects");
    expect(noPath.error.message).toBe(
      "No export path from the previous step: Photoshop reported no file — export with ps_export, then import that file with ae_import_footage.",
    );
    psNoPath = false;
    aeNoId = true;
    const noId = JSON.parse(text(await client.callTool({ name: "pipeline_ps_to_ae", arguments: { compId: 1 } }))) as { error: { step: string; message: string } };
    expect(noId.error.step).toBe("Add layer to comp");
    expect(noId.error.message).toBe(
      "The imported footage has no id — find it with ae_list_footage, then add it with ae_add_layer (kind footage, itemId).",
    );
  });

  it("wait:false returns a jobId that cc_job_wait resolves", async () => {
    const r = await client.callTool({ name: "pipeline_ps_to_ae", arguments: { wait: false } });
    const view = JSON.parse(text(r)) as { jobId: string; hint: string };
    expect(view.jobId).toBeTruthy();
    const w = await client.callTool({ name: "cc_job_wait", arguments: { jobId: view.jobId, timeoutSeconds: 5 } });
    expect(JSON.parse(text(w)).status).toBe("succeeded");
    const l = await client.callTool({ name: "cc_list_jobs", arguments: {} });
    expect((JSON.parse(text(l)) as { jobId: string }[]).some((j) => j.jobId === view.jobId)).toBe(true);
  });
});
