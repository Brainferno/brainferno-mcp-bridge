import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { WebSocket } from "ws";

import { buildRuntime, buildServer, createMcpServer } from "../src/server.js";
import type { BridgeServer } from "../src/bridge/socket.js";
import { PROTOCOL_VERSION } from "@brainferno/mcp-bridge-protocol";
import type { Config } from "../src/config.js";
import type { AppId } from "@brainferno/mcp-bridge-protocol";
import {
  MAC_RUNNER_PROFILE,
  NO_RESULT_MESSAGE,
  OsScriptBridge,
  WINDOWS_RUNNER_PROFILE,
  spawnRunner,
  type RunnerProfile,
  type ScriptRunner,
} from "../src/drivers/osscript.js";
import { log } from "../src/logging.js";
import {
  ILLUSTRATOR_RAW_NO_RESULT_MESSAGE,
  RAW_SCRIPTS_DISABLED_MESSAGE,
  REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE,
  asciiLiteral,
  rawScriptWrapper,
} from "../src/tools/raw-script.js";
import { SERVER_VERSION } from "../src/version.js";
import { hostEval, runJsxFile } from "./host-vm.js";

// Port 0 lets the OS pick a free one; insecure mode skips auth and the handshake
// file so tests never touch the real ~/.brainferno-mcp-bridge/bridge.json.
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

/**
 * Opens a fake panel, authenticates it, and resolves once the server welcomes it.
 * `hello` adds or overrides hello fields (panelVersion, hostVersion, capabilities).
 */
async function connectPanel(port: number, appId: AppId, hello: Record<string, unknown> = {}): Promise<WebSocket> {
  const panel = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => panel.once("open", () => resolve()));
  const welcomed = new Promise<void>((resolve) => {
    panel.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "welcome") resolve();
    });
  });
  panel.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, appId, capabilities: [], ...hello }));
  await welcomed;
  return panel;
}

interface CmdFrame {
  type: "cmd";
  id: string;
  name: string;
  params: { script?: string } & Record<string, unknown>;
  timeoutClass: string;
}

/** Records every cmd frame a fake panel receives, calling `answer` (if given) for each. */
function recordCmds(panel: WebSocket, answer?: (frame: CmdFrame) => void): CmdFrame[] {
  const seen: CmdFrame[] = [];
  panel.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type !== "cmd") return;
    seen.push(frame as CmdFrame);
    answer?.(frame as CmdFrame);
  });
  return seen;
}

/** Answer a cmd frame with a value (or a failure). */
function reply(panel: WebSocket, id: string, value: unknown, ok = true): void {
  panel.send(JSON.stringify(ok ? { type: "result", id, ok: true, value } : { type: "result", id, ok: false, error: value }));
}

const textOf = (r: unknown) => (r as { content: { type: string; text: string }[] }).content[0]!.text;
const settle = () => new Promise((r) => setTimeout(r, 50));

/** Work dirs the injected Illustrator lanes use; each is removed after its test. */
const tempDirs: string[] = [];

/** A fresh empty dir under the OS temp dir, removed after the current test. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * A runtime plus one MCP session on it. `remote` builds a remote-session server; `sessionId`
 * stands in for the HTTP transport's session id (what `via=` is derived from);
 * `illustratorBridge` replaces the os-script lane.
 *
 * The real os-script lane would launch Illustrator over COM/AppleScript, so a session ALWAYS
 * gets an injected lane: the test's own, or one whose runner counts calls and throws. With
 * the throwing one, `close()` asserts the lane was never reached.
 */
async function startSession(
  overrides: Partial<Config>,
  opts: { remote?: boolean; sessionId?: string; illustratorBridge?: OsScriptBridge } = {},
) {
  const rt = buildRuntime({ ...config, ...overrides });
  await rt.bridge.ready();
  let runnerCalls = 0;
  // Never created: OsScriptBridge makes its work dir only when a call runs (its sweep tolerates a
  // missing dir), and this lane must never run one.
  const noAiDir = join(tmpdir(), `acm-no-ai-${randomUUID()}`);
  const illustratorBridge =
    opts.illustratorBridge ??
    new OsScriptBridge({
      appId: "illustrator",
      defaultTimeoutMs: 1_000,
      workDir: noAiDir,
      runner: async () => {
        runnerCalls++;
        throw new Error("this test must not reach the Illustrator lane");
      },
    });
  const server = createMcpServer({ ...rt, illustratorBridge }, { remote: opts.remote });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  if (opts.sessionId !== undefined) st.sessionId = opts.sessionId;
  const c = new Client({ name: "raw", version: "0" });
  await Promise.all([c.connect(ct), server.connect(st)]);
  return {
    c,
    bridge: rt.bridge,
    /** Calls that reached the injected throwing lane (always 0 when the test supplied its own). */
    illustratorRunnerCalls: () => runnerCalls,
    close: async () => {
      await c.close();
      await server.close();
      await rt.bridge.close();
      const leftOnDisk = existsSync(noAiDir);
      rmSync(noAiDir, { recursive: true, force: true, maxRetries: 3 });
      if (opts.illustratorBridge === undefined) {
        expect(runnerCalls, "the Illustrator lane must stay untouched").toBe(0);
        expect(leftOnDisk, "the unused Illustrator lane must leave nothing on disk").toBe(false);
      }
    },
  };
}

/**
 * A runner that takes the .jsx (the script has reached the runner) and then fails the way a
 * real runner process does: a child process that prints `stderr` and exits 1, classified by
 * the real spawnRunner with a real platform profile.
 */
function exitingRunner(stderr: string, profile: RunnerProfile, seen: { jsx: string }): ScriptRunner {
  return async (jsxPath, signal) => {
    seen.jsx = readFileSync(jsxPath, "utf8");
    // exitCode, not process.exit(): stderr to a pipe is async on POSIX and exit() could cut it off.
    await spawnRunner(process.execPath, ["-e", `process.exitCode = 1; process.stderr.write(${JSON.stringify(stderr)});`], signal, profile);
  };
}

function illustratorLane(runner: ScriptRunner, workDir = tempDir("acm-raw-ai-")): OsScriptBridge {
  return new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: 1_000, runner, workDir });
}

/** The raw-script audit lines (not the startup gate line) the spy saw. */
function rawAuditLines(spy: MockInstance): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("raw-script "));
}

describe("brainferno-mcp-bridge server", () => {
  let client: Client;
  let bridge: BridgeServer;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const built = buildServer(config);
    bridge = built.bridge;
    await bridge.ready();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);

    close = async () => {
      await client.close();
      await built.server.close();
      await bridge.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it("advertises tools for all five applications", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("ae_list_compositions");
    expect(names).toContain("ae_set_comp_props");
    expect(names).toContain("pp_list_sequences");
    expect(names).toContain("ps_list_documents");
    expect(names).toContain("ai_list_documents");
    expect(names).toContain("au_document_info");
    expect(names).toContain("cc_connected_apps");
  });

  // Flipped by X-01: this test used to assert cc_eval_script was absent with the gate off.
  // The raw tools are now always listed and refuse, in plain text, without reaching any panel.
  it("advertises the raw-script tools with the gate off but refuses them without reaching the panel", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("cc_eval_script");
    expect(names).toContain("cc_get_capabilities");
    expect(names).toContain("ps_batch_play");

    const audit = vi.spyOn(log, "audit").mockImplementation(() => {});
    try {
      const ae = await connectPanel(bridge.port(), "after_effects");
      const ps = await connectPanel(bridge.port(), "photoshop");
      const aeCmds = recordCmds(ae, (f) => reply(ae, f.id, [{ name: "Main" }]));
      const psCmds = recordCmds(ps);

      const r = await client.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "/* raw-probe-7f3 */ app.project.numItems" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
      expect(textOf(r)).toContain("currently enabled for: none");

      const p = await client.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
      expect(p.isError).toBe(true);
      expect(textOf(p)).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);

      await settle();
      expect(aeCmds).toEqual([]);
      expect(psCmds).toEqual([]);
      // Control: the same panel does receive a typed tool's command, so the recorder works —
      // and that one is the typed tool's own script, not the raw wrapper.
      await client.callTool({ name: "ae_list_compositions", arguments: {} });
      expect(aeCmds).toHaveLength(1);
      expect(aeCmds[0]!.params.script).not.toContain("__src");
      expect(aeCmds[0]!.params.script).not.toContain("raw-probe-7f3");

      expect(rawAuditLines(audit)).toEqual([
        expect.stringMatching(/^raw-script tool=cc_eval_script app=after_effects .* via=stdio outcome=refused$/),
        expect.stringMatching(/^raw-script tool=ps_batch_play app=photoshop .* count=1 via=stdio outcome=refused$/),
      ]);
      ae.close();
      ps.close();
    } finally {
      audit.mockRestore();
    }
  });

  it("says in cc_eval_script's description both reasons bodyLine can be null", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "cc_eval_script");
    expect(tool?.description).toContain(
      "bodyLine is null when the error was raised outside your script's own text (for example in a $.evalFile'd " +
        "library, or in a helper an earlier call left as a global) or the host's line numbering cannot be calibrated.",
    );
  });

  it("does not advertise the Illustrator delegate tools without a key", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("ai_beta_status");
  });

  it("reports every panel-driven application as disconnected when no panel has dialed in", async () => {
    const result = await client.callTool({ name: "cc_connected_apps", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const apps = JSON.parse(text) as { lane: string; connected: boolean | null }[];

    expect(apps.filter((a) => a.lane === "socket").every((a) => a.connected === false)).toBe(true);
  });

  it("returns an actionable error, not a crash, when the panel is absent", async () => {
    const result = await client.callTool({ name: "ae_list_compositions", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No running host connected/);
  });

  it("round-trips a command through a connected panel", async () => {
    const panel = await connectPanel(bridge.port(), "after_effects");

    // Stand in for After Effects: answer every command with a fixed comp list.
    panel.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "cmd") return;
      panel.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: [{ name: "Main", width: 1920 }] }));
    });

    const result = await client.callTool({ name: "ae_list_compositions", arguments: {} });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text);

    expect(result.isError).toBeFalsy();
    expect(parsed).toEqual([{ name: "Main", width: 1920 }]);
    panel.close();
  });

  it("surfaces a script error from the panel as a tool error", async () => {
    const panel = await connectPanel(bridge.port(), "photoshop");
    panel.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "cmd") return;
      panel.send(
        JSON.stringify({
          type: "result",
          id: frame.id,
          ok: false,
          error: { code: "HOST_ERROR", message: "No open document", line: 3 },
        }),
      );
    });

    const result = await client.callTool({ name: "ps_list_documents", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No open document/);
    panel.close();
  });
});

describe("brainferno-mcp-bridge server with an Illustrator delegate key", () => {
  it("advertises the delegate tools when a key is configured", async () => {
    const built = buildServer({ ...config, illustratorMcpKey: "ilst_test" });
    await built.bridge.ready();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([c.connect(clientTransport), built.server.connect(serverTransport)]);

    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("ai_beta_status");
    expect(names).toContain("ai_beta_list_tools");
    expect(names).toContain("ai_beta_call");

    // cc_get_capabilities reports the delegate rows as enabled — from a boolean, never the key.
    const capsText = textOf(await c.callTool({ name: "cc_get_capabilities", arguments: {} }));
    expect(capsText).not.toContain("ilst_test");
    const caps = JSON.parse(capsText) as { tools: { tool: string; enabled: boolean; enableWith: string | null }[] };
    const delegate = caps.tools.filter((t) => t.tool.startsWith("ai_beta_"));
    expect(delegate.map((t) => t.tool)).toEqual(["ai_beta_status", "ai_beta_list_tools", "ai_beta_call"]);
    expect(delegate.every((t) => t.enabled && t.enableWith === null)).toBe(true);

    await c.close();
    await built.server.close();
    await built.bridge.close();
    await built.illustratorDelegate.close();
  });
});

describe("cc_eval_script with the gate open for After Effects", () => {
  const AE_ONLY: Partial<Config> = { allowRawScripts: true, rawScriptApps: ["after_effects"] };
  let audit: MockInstance;
  beforeEach(() => {
    audit = vi.spyOn(log, "audit").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the ES3 wrapper as an eval command, and the wrapper really runs (node:vm stands in for the host)", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    // The fake panel evaluates exactly what it received, the way host.jsx's __acmEval does.
    const cmds = recordCmds(panel, (f) => reply(panel, f.id, hostEval(f.params.script!)));
    const script = 'var comps = 3;\n__log("counting " + comps + " café");\ncomps * 2';

    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script } });

    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.name).toBe("eval");
    expect(cmds[0]!.params.script).toBe(rawScriptWrapper(script));
    expect(cmds[0]!.timeoutClass).toBe("slow");
    expect(r.isError).toBeFalsy();
    const env = JSON.parse(textOf(r));
    expect(Object.keys(env)).toEqual(["ok", "durationMs", "value", "logs"]);
    expect(env).toMatchObject({ ok: true, value: 6, logs: ["counting 3 café"] });
    expect(typeof env.durationMs).toBe("number");
    expect(rawAuditLines(audit)).toEqual([expect.stringMatching(/^raw-script tool=cc_eval_script app=after_effects sha256=[0-9a-f]{12} len=\d+ via=stdio outcome=run$/)]);
    panel.close();
    await s.close();
  });

  it("returns a script failure and a non-plain result as isError JSON envelopes", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    recordCmds(panel, (f) => reply(panel, f.id, hostEval(f.params.script!)));

    const thrown = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "var a = 1;\nnull.boom" } });
    expect(thrown.isError).toBe(true);
    const e1 = JSON.parse(textOf(thrown));
    expect(Object.keys(e1)).toEqual(["ok", "error", "durationMs", "value", "logs"]);
    expect(e1.ok).toBe(false);
    expect(e1.error.message).toMatch(/null/);
    expect(e1.error).not.toHaveProperty("lineBase");
    expect(e1.value).toBeNull();

    const host = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "new (function Comp() { this.id = 1; })()" } });
    expect(host.isError).toBe(true);
    expect(JSON.parse(textOf(host)).error.message).toContain("value is a host/class object");
    panel.close();
    await s.close();
  });

  it("maps a calibrated host line to bodyLine, and drops an uncalibrated one", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    let lineBase = 0;
    // Stand in for ExtendScript, which reports e.line: answer with the wrapper's raw error shape.
    recordCmds(panel, (f) =>
      reply(panel, f.id, { ok: false, error: { message: "undefined is not an object", line: 2, lineBase }, value: null, logs: ["a"], logsDropped: 0 }),
    );
    const script = "var a = 1;\nundefinedThing.x;\na";

    const calibrated = JSON.parse(textOf(await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script } })));
    expect(calibrated.error).toEqual({ message: "undefined is not an object", line: 2, bodyLine: 2 });
    expect(calibrated.logs).toEqual(["a"]);

    lineBase = 5;
    const shifted = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script } });
    expect(shifted.isError).toBe(true);
    expect(JSON.parse(textOf(shifted)).error).toEqual({ message: "undefined is not an object", line: 2, bodyLine: null });
    panel.close();
    await s.close();
  });

  it("turns a panel-side failure into an envelope that says the script was sent", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    recordCmds(panel, (f) => reply(panel, f.id, { code: "HOST_ERROR", message: "EvalScript error." }, false));
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "1" } });
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r));
    expect(env).toMatchObject({ ok: false, value: null, logs: [], error: { line: null, bodyLine: null } });
    expect(env.error.message).toBe("EvalScript error. — the script was sent; it may have partly run");
    panel.close();
    await s.close();
  });

  it("says plain-text 'not connected' when no panel is there (nothing was dispatched)", async () => {
    const s = await startSession(AE_ONLY);
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "1" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^No running host connected/);
    expect(() => JSON.parse(textOf(r))).toThrow();
    await s.close();
  });

  it("reports a panel that drops mid-call as 'may have partly run'", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    recordCmds(panel, () => panel.terminate());
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "1" } });
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r));
    expect(env.ok).toBe(false);
    expect(env.error.message).toContain("may have partly run");
    await s.close();
  });

  it("reports a timeout with the deadline it used", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const cmds = recordCmds(panel); // never answers
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "1", timeoutMs: 100 } });
    expect(cmds).toHaveLength(1);
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r));
    expect(env.error.message).toMatch(/^timed out after 100 ms — the script may still be running or have partly run/);
    panel.close();
    await s.close();
  });

  it("still refuses Audition and Photoshop, and an app whose tools are off", async () => {
    const s = await startSession(AE_ONLY);
    const ps = await connectPanel(s.bridge.port(), "photoshop");
    const au = await connectPanel(s.bridge.port(), "audition");
    const psCmds = recordCmds(ps);
    const auCmds = recordCmds(au);

    const a = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "audition", script: "1" } });
    expect(a.isError).toBe(true);
    expect(textOf(a)).toContain("(This call targets Audition; currently enabled for: after_effects.)");
    const p = await s.c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(p.isError).toBe(true);
    expect(textOf(p)).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
    await settle();
    expect(psCmds).toEqual([]);
    expect(auCmds).toEqual([]);
    ps.close();
    au.close();
    await s.close();

    // Gate open for everything, but Illustrator's tools are not enabled: refused before any lane.
    // (startSession injects a counting lane, so this cannot reach COM/AppleScript even if the
    // enabled-apps check regressed.)
    const t = await startSession({ allowRawScripts: true, rawScriptApps: ["after_effects", "photoshop", "illustrator", "audition"], enabledApps: ["after_effects"] });
    const i = await t.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "1" } });
    expect(i.isError).toBe(true);
    expect(textOf(i)).toBe(
      "Illustrator tools are not enabled on this server — rerun npm run install-cc and pick Illustrator, or set " +
        "BRAINFERNO_MCP_APPS to the full list of apps you want including illustrator (it replaces the installer's " +
        "choice), then restart.",
    );
    expect(t.illustratorRunnerCalls()).toBe(0);
    expect(rawAuditLines(audit).at(-1)).toMatch(/app=illustrator .* outcome=refused$/);
    await t.close();
  });
});

describe("cc_eval_script for Illustrator goes down the os-script lane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const AI_GATE: Partial<Config> = { allowRawScripts: true, rawScriptApps: ["illustrator"] };
  beforeEach(() => {
    vi.spyOn(log, "audit").mockImplementation(() => {});
  });

  it("splices the wrapper into the .jsx, never sends it to the hub, and cleans up", async () => {
    const workDir = tempDir("acm-raw-ai-");
    const script = 'var name = "Illüstrator \\"doc\\"";\n__log(name);\nname.length';
    let jsx = "";
    // Stands in for COM/AppleScript: checks the generated .jsx, then runs the whole of it in
    // node:vm the way $.evalFile would — prelude, wrapper, __acmJson and __acmWrite included.
    const fakeRunner: ScriptRunner = async (jsxPath) => {
      jsx = readFileSync(jsxPath, "utf8");
      runJsxFile(jsxPath);
    };
    const illustratorBridge = new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: 1_000, runner: fakeRunner, workDir });
    const s = await startSession(AI_GATE, { illustratorBridge });
    // A rogue socket panel claiming to be Illustrator must never see the script.
    const rogue = await connectPanel(s.bridge.port(), "illustrator");
    const rogueCmds = recordCmds(rogue);

    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script } });

    expect(jsx).toContain("var __acmValue = (function () {");
    expect(jsx).toContain("var __acmValue = " + rawScriptWrapper(script) + ";");
    // The caller's script is present only as the ASCII literal, once.
    expect(jsx.split(asciiLiteral(script)).length - 1).toBe(1);
    // Never spliced as code: no raw non-ASCII, and the script's real line breaks only exist escaped.
    expect(jsx).not.toContain("Illüstrator");
    expect(jsx).not.toContain("\n__log(name);\n");
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, value: 17, logs: ['Illüstrator "doc"'] });
    await settle();
    expect(rogueCmds).toEqual([]);
    expect(readdirSync(workDir)).toEqual([]);
    rogue.close();
    await s.close();
  });

  it("hands the runner the call's timeoutMs", async () => {
    const seen: (number | undefined)[] = [];
    const lane = illustratorLane(async (jsxPath, _signal, timeoutMs) => {
      seen.push(timeoutMs);
      runJsxFile(jsxPath);
    });
    const s = await startSession(AI_GATE, { illustratorBridge: lane });
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "40 + 2", timeoutMs: 4_321 } });
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, value: 42 });
    expect(seen).toEqual([4_321]);
    await s.close();
  });

  it("a runner that fails after the script was sent gives the JSON envelope, not plain text", async () => {
    // macOS: AppleScript gave up waiting (its own Apple-event timeout) while Illustrator kept running.
    const seen = { jsx: "" };
    const out = "0:61: execution error: Adobe Illustrator got an error: AppleEvent timed out. (-1712)";
    const s = await startSession(AI_GATE, { illustratorBridge: illustratorLane(exitingRunner(out, MAC_RUNNER_PROFILE, seen)) });
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "app.documents.length" } });
    expect(seen.jsx).toContain(rawScriptWrapper("app.documents.length"));
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r));
    expect(env).toMatchObject({ ok: false, value: null, logs: [], error: { line: null, bodyLine: null } });
    expect(env.error.message).toBe(
      `The script runner failed (${out}) — the script was sent; it may have partly run — check Illustrator before re-running`,
    );

    // Windows: Illustrator went away during DoJavaScript.
    const rpc = 'Exception calling "DoJavaScript" with "1" argument(s): "The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)"';
    const w = await startSession(AI_GATE, { illustratorBridge: illustratorLane(exitingRunner(rpc, WINDOWS_RUNNER_PROFILE, seen)) });
    const r2 = await w.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "1" } });
    expect(r2.isError).toBe(true);
    expect(JSON.parse(textOf(r2)).error.message).toContain("the script was sent; it may have partly run — check Illustrator");

    // A runner failure the lane cannot explain is treated as dispatched too (when in doubt).
    const odd = await startSession(AI_GATE, {
      illustratorBridge: illustratorLane(async (jsxPath) => {
        readFileSync(jsxPath, "utf8");
        throw new Error("pipe closed");
      }),
    });
    const r3 = await odd.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "1" } });
    expect(r3.isError).toBe(true);
    expect(JSON.parse(textOf(r3)).error.message).toContain("(pipe closed) — the script was sent");
    await s.close();
    await w.close();
    await odd.close();
  });

  it("a runner that never reached Illustrator stays plain text (nothing was dispatched)", async () => {
    const seen = { jsx: "" };
    const notRegistered =
      "New-Object : Retrieving the COM class factory for component with CLSID {00000000-0000-0000-0000-000000000000} " +
      "failed due to the following error: 80040154 Class not registered (Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG)).";
    const s = await startSession(AI_GATE, { illustratorBridge: illustratorLane(exitingRunner(notRegistered, WINDOWS_RUNNER_PROFILE, seen)) });
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "1" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`No running host connected for "illustrator". ${WINDOWS_RUNNER_PROFILE.notConnectedHint} (${notRegistered})`);
    expect(() => JSON.parse(textOf(r))).toThrow();

    const mac = await startSession(AI_GATE, {
      illustratorBridge: illustratorLane(exitingRunner("0:61: execution error: Not authorized to send Apple events to Adobe Illustrator. (-1743)", MAC_RUNNER_PROFILE, seen)),
    });
    const r2 = await mac.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "1" } });
    expect(textOf(r2)).toMatch(/^No running host connected for "illustrator"\. Could not reach Illustrator via AppleScript\./);
    await s.close();
    await mac.close();
  });

  it("no result file: a neutral message, not a hint at ES3 syntax (the wrapper reports syntax errors itself)", async () => {
    const s = await startSession(AI_GATE, { illustratorBridge: illustratorLane(async () => {}) });
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "app.documents.length" } });
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r));
    expect(env.error.message).toBe(ILLUSTRATOR_RAW_NO_RESULT_MESSAGE);
    expect(env.error.message).toBe(
      "Illustrator produced no result file — the script may not have run (a modal dialog, or the temp .jsx/result file " +
        "could not be read or written). Syntax errors in your script come back as ok:false with a message, not like " +
        "this — check Illustrator before re-running.",
    );
    expect(env.error.message).not.toMatch(/ES3|parse/);

    // A real syntax error in the caller's script does come back as ok:false with its own message.
    const real = await startSession(AI_GATE, { illustratorBridge: illustratorLane(async (jsxPath) => runJsxFile(jsxPath)) });
    const bad = JSON.parse(textOf(await real.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script: "var x = ;" } })));
    expect(bad.ok).toBe(false);
    expect(bad.error.message).not.toBe(ILLUSTRATOR_RAW_NO_RESULT_MESSAGE);
    await s.close();
    await real.close();
  });

  it("the typed ai_* tools keep their messages for the same runner failures", async () => {
    const seen = { jsx: "" };
    const rpc = 'Exception calling "DoJavaScript" with "1" argument(s): "The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)"';
    const s = await startSession({}, { illustratorBridge: illustratorLane(exitingRunner(rpc, WINDOWS_RUNNER_PROFILE, seen)) });
    const dispatched = await s.c.callTool({ name: "ai_list_documents", arguments: {} });
    expect(dispatched.isError).toBe(true);
    expect(textOf(dispatched)).toBe(`No running host connected for "illustrator". ${WINDOWS_RUNNER_PROFILE.notConnectedHint} (${rpc})`);

    const none = await startSession({}, { illustratorBridge: illustratorLane(async () => {}) });
    const noResult = await none.c.callTool({ name: "ai_list_documents", arguments: {} });
    expect(textOf(noResult)).toBe(`Script failed in illustrator: ${NO_RESULT_MESSAGE}`);
    expect(NO_RESULT_MESSAGE).toBe("The script produced no result — it probably failed to parse (ES3 syntax only).");
    await s.close();
    await none.close();
  });
});

describe("raw scripts in a remote (shared HTTP) session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses unless remote raw scripts are allowed, and audits the session it came from", async () => {
    const audit = vi.spyOn(log, "audit").mockImplementation(() => {});
    const gate: Partial<Config> = { allowRawScripts: true, rawScriptApps: ["after_effects"] };
    const s = await startSession(gate, { remote: true, sessionId: "a1b2c3d4-0000-4000-8000-000000000000" });
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const cmds = recordCmds(panel, (f) => reply(panel, f.id, hostEval(f.params.script!)));

    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "1" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE);
    await settle();
    expect(cmds).toEqual([]);
    expect(rawAuditLines(audit)).toEqual([expect.stringMatching(/ via=http:a1b2c3d4 outcome=refused$/)]);

    const caps = JSON.parse(textOf(await s.c.callTool({ name: "cc_get_capabilities", arguments: {} })));
    expect(caps.session).toBe("remote");
    const aeRow = caps.tools.find((t: { tool: string; app: string }) => t.tool === "cc_eval_script" && t.app === "after_effects");
    expect(aeRow).toMatchObject({ enabled: false, enableWith: REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE });
    panel.close();
    await s.close();

    const allowed = await startSession({ ...gate, allowRemoteRawScripts: true }, { remote: true, sessionId: "ffff0000-1111" });
    const p2 = await connectPanel(allowed.bridge.port(), "after_effects");
    const cmds2 = recordCmds(p2, (f) => reply(p2, f.id, hostEval(f.params.script!)));
    const ok = await allowed.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: "40 + 2" } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(textOf(ok)).value).toBe(42);
    expect(cmds2).toHaveLength(1);
    expect(rawAuditLines(audit).at(-1)).toMatch(/ via=http:ffff0000 outcome=run$/);
    p2.close();
    await allowed.close();
  });
});

describe("cc_get_capabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Caps = {
    serverVersion: string;
    protocolVersion: number;
    session: string;
    rawScriptGate: { env: string; apps: string[]; ignored: string[]; remoteAllowed: boolean };
    tools: { tool: string; app: string; enabled: boolean; enableWith: string | null; connected: boolean | null; panelSupports: boolean | null }[];
    panels: { appId: string; connected: boolean; panelVersion: string | null; hostVersion: string | null }[];
  };
  const row = (caps: Caps, tool: string, app: string) => caps.tools.find((t) => t.tool === tool && t.app === app);

  it("shows every raw tool disabled, with how to enable it, when the gate is off", async () => {
    const s = await startSession({ rawScriptIgnored: ["premiere"] });
    const r = await s.c.callTool({ name: "cc_get_capabilities", arguments: {} });
    expect(r.isError).toBeFalsy();
    const caps = JSON.parse(textOf(r)) as Caps;
    expect(caps.serverVersion).toBe(SERVER_VERSION);
    expect(caps.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(caps.session).toBe("stdio");
    expect(caps.rawScriptGate).toEqual({ env: "BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS", apps: [], ignored: ["premiere"], remoteAllowed: false });
    expect(caps.tools.map((t) => `${t.tool}:${t.app}`)).toEqual([
      "cc_eval_script:after_effects",
      "cc_eval_script:illustrator",
      "cc_eval_script:audition",
      "ps_batch_play:photoshop",
      "ai_beta_status:illustrator",
      "ai_beta_list_tools:illustrator",
      "ai_beta_call:illustrator",
    ]);
    for (const t of caps.tools.filter((x) => !x.tool.startsWith("ai_beta_"))) {
      expect(t.enabled, t.tool).toBe(false);
      expect(t.enableWith, t.tool).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
    }
    for (const t of caps.tools.filter((x) => x.tool.startsWith("ai_beta_"))) {
      expect(t).toMatchObject({ enabled: false, connected: null, panelSupports: null });
      expect(t.enableWith).toContain("BRAINFERNO_MCP_ILLUSTRATOR_KEY");
    }
    expect(row(caps, "cc_eval_script", "illustrator")).toMatchObject({ connected: null, panelSupports: null });
    expect(row(caps, "cc_eval_script", "after_effects")).toMatchObject({ connected: false, panelSupports: null });
    expect(caps.panels.map((p) => p.appId)).toEqual(["after_effects", "premiere", "photoshop", "audition"]);
    expect(caps.panels.every((p) => !p.connected && p.panelVersion === null && p.hostVersion === null)).toBe(true);
    await s.close();
  });

  it("reflects a gate open for After Effects only, with versions from the panels' hello", async () => {
    const s = await startSession({ allowRawScripts: true, rawScriptApps: ["after_effects"] });
    const ae = await connectPanel(s.bridge.port(), "after_effects", { panelVersion: "7.7.7", hostVersion: "26.1", capabilities: ["eval", "ae.host_info"] });
    const ps = await connectPanel(s.bridge.port(), "photoshop", { panelVersion: "", capabilities: ["ps.list_documents"] });

    const caps = JSON.parse(textOf(await s.c.callTool({ name: "cc_get_capabilities", arguments: {} }))) as Caps;
    expect(caps.rawScriptGate.apps).toEqual(["after_effects"]);
    expect(row(caps, "cc_eval_script", "after_effects")).toEqual({
      tool: "cc_eval_script",
      app: "after_effects",
      enabled: true,
      enableWith: null,
      connected: true,
      panelSupports: true,
    });
    const psRow = row(caps, "ps_batch_play", "photoshop");
    expect(psRow).toMatchObject({ enabled: false, connected: true, panelSupports: false });
    expect(psRow!.enableWith).toContain("(This call targets Photoshop; currently enabled for: after_effects.)");
    expect(row(caps, "cc_eval_script", "audition")).toMatchObject({ enabled: false, connected: false, panelSupports: null });
    expect(caps.panels.find((p) => p.appId === "after_effects")).toEqual({ appId: "after_effects", connected: true, panelVersion: "7.7.7", hostVersion: "26.1" });
    expect(caps.panels.find((p) => p.appId === "photoshop")).toEqual({ appId: "photoshop", connected: true, panelVersion: null, hostVersion: null });
    ae.close();
    ps.close();
    await s.close();
  });

  it("lists rows only for the apps whose tools are enabled", async () => {
    const s = await startSession({ enabledApps: ["photoshop", "media_encoder"] });
    const caps = JSON.parse(textOf(await s.c.callTool({ name: "cc_get_capabilities", arguments: {} }))) as Caps;
    expect(caps.tools.map((t) => t.tool)).toEqual(["ps_batch_play"]);
    expect(caps.panels.map((p) => p.appId)).toEqual(["photoshop"]);
    await s.close();
  });
});

describe("app choice", () => {
  it("registers only the chosen apps and the pipelines they allow", async () => {
    const built = buildServer({ ...config, enabledApps: ["photoshop", "after_effects"] });
    await built.bridge.ready();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "subset", version: "0" });
    await Promise.all([c.connect(ct), built.server.connect(st)]);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("ps_list_documents");
    expect(names).toContain("ae_list_compositions");
    expect(names).toContain("pipeline_ps_to_ae");
    expect(names).toContain("audio_probe");
    expect(names).not.toContain("pp_list_sequences");
    expect(names).not.toContain("au_document_info");
    expect(names).not.toContain("ame_encode");
    expect(names).not.toContain("pipeline_render_and_import");
    const apps = JSON.parse(((await c.callTool({ name: "cc_connected_apps", arguments: {} })).content as { type: string; text: string }[])[0]!.text) as { appId: string }[];
    expect(apps.map((a) => a.appId).sort()).toEqual(["after_effects", "photoshop"]);
    await c.close();
    await built.server.close();
    await built.bridge.close();
  });
});

describe("per-client defaults (BRAINFERNO_MCP_DEFAULT_WAIT, BRAINFERNO_MCP_JOB_WAIT_SECONDS)", () => {
  const LONG_TOOLS = ["ae_render_comp", "pp_export_sequence", "ame_encode", "pipeline_ps_to_ae", "pipeline_render_and_import", "pipeline_audio_roundtrip", "pipeline_ai_to_ps"];

  it("advertises the configured wait default in every long tool's schema", async () => {
    for (const defaultWait of [true, false]) {
      const built = buildServer({ ...config, defaultWait, jobWaitSeconds: 50 });
      await built.bridge.ready();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "waits", version: "0" });
      await Promise.all([c.connect(ct), built.server.connect(st)]);
      const { tools } = await c.listTools();
      for (const name of LONG_TOOLS) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, name).toBeDefined();
        const wait = (tool!.inputSchema["properties"] as Record<string, { description?: string }>)["wait"];
        expect(wait?.description, name).toContain("BRAINFERNO_MCP_DEFAULT_WAIT");
        expect(wait?.description, name).toContain(defaultWait ? "(default" : "Default false");
      }
      const jobWait = tools.find((t) => t.name === "cc_job_wait");
      expect((jobWait!.inputSchema["properties"] as Record<string, { description?: string }>)["timeoutSeconds"]?.description).toContain("Defaults to 50");
      await c.close();
      await built.server.close();
      await built.bridge.close();
    }
  });
});
