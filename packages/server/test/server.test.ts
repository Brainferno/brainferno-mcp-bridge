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
import { ScriptError } from "../src/bridge/types.js";
import { setRedactionSecrets } from "../src/tools/echo.js";
import { scriptErrorText } from "../src/tools/result.js";
import { AE_PRELUDE_LINES, LIST_INSTALLED_EFFECTS, applyEffectScript, getCompScript, getLayerScript, runRawScript, wrapAe } from "../src/tools/after-effects.js";
import { aeHost, panelReply, type AeHost } from "./ae-host.js";
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

/** A fake panel that runs every eval cmd in `host`, the way host.jsx's __acmEval does. */
function vmPanel(panel: WebSocket, host: AeHost, delayMs = 0): CmdFrame[] {
  return recordCmds(panel, (f) => {
    const answer = () => {
      const r = host.eval(f.params.script!);
      if (r.ok) reply(panel, f.id, r.value);
      else reply(panel, f.id, panelReply(r), false);
    };
    if (delayMs > 0) setTimeout(answer, delayMs);
    else answer();
  });
}

/** An ae-host with a version and no-op dialog suppression (ae-host models neither), for ae_run_script (AE-01). */
function runScriptHost(): AeHost {
  const host = aeHost();
  host.app.version = "26.5";
  host.app.beginSuppressDialogs = () => {};
  host.app.endSuppressDialogs = () => {};
  return host;
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
    expect(names).toContain("ae_run_script");

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

      // AE-01 acceptance 1: ae_run_script is listed and refuses the same way.
      const a = await client.callTool({ name: "ae_run_script", arguments: { script: "/* raw-probe-7f3 */ 1" } });
      expect(a.isError).toBe(true);
      expect(textOf(a)).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
      expect(textOf(a)).toContain("currently enabled for: none");

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
        expect.stringMatching(/^raw-script tool=ae_run_script app=after_effects .* via=stdio outcome=refused$/),
      ]);
      ae.close();
      ps.close();
    } finally {
      audit.mockRestore();
    }
  });

  it("says in cc_eval_script's description both reasons bodyLine can be null", async () => {
    const tools = (await client.listTools()).tools;
    const sentence =
      "bodyLine is null when the error was raised outside your script's own text (for example in a $.evalFile'd " +
      "library, or in a helper an earlier call left as a global) or the host's line numbering cannot be calibrated.";
    expect(tools.find((t) => t.name === "cc_eval_script")?.description).toContain(sentence);
    // AE-01: ae_run_script repeats the sentence verbatim, in its script parameter (R1 keeps its description short).
    const run = tools.find((t) => t.name === "ae_run_script");
    expect((run?.inputSchema["properties"] as Record<string, { description?: string }>)["script"]?.description).toContain(sentence);
  });

  it("points cc_eval_script's After Effects callers at ae_run_script and warns about a bare object literal (AE-01, ES-7, K3, R11)", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "cc_eval_script");
    // K3: ae_run_script is listed only when After Effects' tools are; the pointer promises nothing about dialogs.
    expect(tool?.description).toContain("For After Effects (when its tools are enabled), ae_run_script runs a script as one undo step.");
    expect(tool?.description).not.toContain("dialogs suppressed");
    // R11: the object-literal clause lives in the script parameter, which keeps the description under the cut.
    const objectLiteral =
      "To return an object literal, wrap it in parentheses — ({ a: 1 }) — or return it from an IIFE; a bare { a: 1 } on the last line is a block and returns 1.";
    expect(tool?.description).not.toContain(objectLiteral);
    const script = (tool?.inputSchema["properties"] as Record<string, { description?: string }>)["script"]?.description;
    expect(script).toContain(objectLiteral);
    expect(script).toContain("var only — no let/const, arrow functions, template literals or JSON");
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
    // AE-16 changes After Effects' text only: other apps' script errors read exactly as before.
    expect((result.content as { text: string }[])[0]!.text).toBe("Script failed in photoshop (line 3): No open document");
    panel.close();
  });
});

describe("tool descriptions a client shows whole (AE-01 R1, R11)", () => {
  /** Claude Code cuts a tool description at 2,048 characters, so text past it never reaches the model. */
  const DESCRIPTION_CUT = 2048;

  it("keeps every tool's description, and each parameter's, within 2,048 characters as tools/list delivers them", async () => {
    // Every app, plus an Illustrator key: the full tool list, delegate tools included.
    const built = buildServer({ ...config, illustratorMcpKey: "ilst_test" });
    await built.bridge.ready();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([c.connect(clientTransport), built.server.connect(serverTransport)]);

    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    // The raw-script tools carry the longest descriptions and their safety text; they must be in the list measured.
    for (const raw of ["ae_run_script", "cc_eval_script", "ps_batch_play"]) expect(names).toContain(raw);
    expect(names).toContain("ai_beta_call");
    const over = tools.filter((t) => (t.description ?? "").length > DESCRIPTION_CUT).map((t) => `${t.name}: ${t.description!.length}`);
    expect(over).toEqual([]);
    const overParams = tools.flatMap((t) =>
      Object.entries((t.inputSchema["properties"] ?? {}) as Record<string, { description?: string }>)
        .filter(([, p]) => (p.description ?? "").length > DESCRIPTION_CUT)
        .map(([k, p]) => `${t.name}.${k}: ${p.description!.length}`),
    );
    expect(overParams).toEqual([]);
    // Each raw tool's gate sentence is inside the cut, so the model learns how the tool is enabled.
    for (const raw of ["ae_run_script", "cc_eval_script"]) {
      const d = tools.find((t) => t.name === raw)!.description!;
      expect(d.indexOf("cc_get_capabilities shows the gate"), raw).toBeGreaterThan(0);
    }

    await c.close();
    await built.server.close();
    await built.bridge.close();
    await built.illustratorDelegate.close();
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

  // AE-01 consent (CS-1): one consent path. An After Effects script that closes or replaces the open project goes
  // through ae_run_script, which asks the operator; cc_eval_script refuses it, sending nothing.
  const SWITCH = "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);\napp.open(new File(__args.p));\n1";
  const REFUSED_CC = /^raw-script tool=cc_eval_script app=after_effects sha256=[0-9a-f]{12} len=\d+ via=stdio outcome=refused$/;

  it("T29: refuses an After Effects script that closes or replaces the open project, and points to ae_run_script", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const cmds = recordCmds(panel, (f) => reply(panel, f.id, { ok: true, value: 1, logs: [], logsDropped: 0 }));
    const cases: [string, string][] = [
      [
        SWITCH,
        "cc_eval_script did not send this script: it calls app.project.close (line 1), app.open (line 2), which close or " +
          "replace the open After Effects project (a comment or string that names one counts) — run it with ae_run_script, " +
          "which asks the operator first and sends it only if they agree.",
      ],
      // A script that suppresses dialogs itself would get probe 10's silent save-over here.
      [
        "app.beginSuppressDialogs();\napp.open(new File(p));\n1",
        "cc_eval_script did not send this script: it calls app.open (line 2), which closes or replaces the open After " +
          "Effects project (a comment or string that names one counts) — run it with ae_run_script, which asks the " +
          "operator first and sends it only if they agree.",
      ],
    ];
    for (const [script, text] of cases) {
      audit.mockClear();
      const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe(text);
      expect(() => JSON.parse(textOf(r))).toThrow();
      expect(rawAuditLines(audit)).toEqual([expect.stringMatching(REFUSED_CC)]);
    }
    await settle();
    expect(cmds).toEqual([]);
    panel.close();
    await s.close();
  });

  it("T30: the project-switch refusal is After Effects only: Audition's app.open is sent as before", async () => {
    const s = await startSession({ allowRawScripts: true, rawScriptApps: ["audition"] });
    const au = await connectPanel(s.bridge.port(), "audition");
    const cmds = recordCmds(au, (f) => reply(au, f.id, { ok: true, value: 1, logs: [], logsDropped: 0 }));
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "audition", script: "app.open(f)" } });
    expect(r.isError).toBeFalsy();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.params.script).toBe(rawScriptWrapper("app.open(f)"));
    expect(rawAuditLines(audit)).toEqual([expect.stringMatching(/^raw-script tool=cc_eval_script app=audition .* outcome=run$/)]);
    au.close();
    await s.close();
  });

  it("T30b: Illustrator's app.open is not refused either: the script reaches the os-script lane (V3)", async () => {
    // In Illustrator app.open opens a document, not an After Effects project. The runner takes the .jsx and runs it in
    // node:vm, where `app` does not exist, so the script returns 1 without calling it.
    const jsx: string[] = [];
    const lane = illustratorLane(async (jsxPath) => {
      jsx.push(readFileSync(jsxPath, "utf8"));
      runJsxFile(jsxPath);
    });
    const s = await startSession({ allowRawScripts: true, rawScriptApps: ["illustrator"] }, { illustratorBridge: lane });
    const script = 'typeof app === "undefined" ? 1 : app.open(new File("~/a.ai"))';
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, value: 1 });
    expect(jsx).toHaveLength(1);
    expect(jsx[0]).toContain(rawScriptWrapper(script));
    expect(rawAuditLines(audit)).toEqual([expect.stringMatching(/^raw-script tool=cc_eval_script app=illustrator .* outcome=run$/)]);
    await s.close();
  });

  it("T31: with the gate closed, a project switch gets the gate text: the gate is checked first", async () => {
    const s = await startSession({});
    const r = await s.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script: SWITCH } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
    expect(textOf(r)).not.toContain("cc_eval_script did not send this script");
    expect(rawAuditLines(audit)).toEqual([expect.stringMatching(REFUSED_CC)]);
    await s.close();
  });

  it("T32: the description names the project-switch refusal as a plain-text cause and keeps the ae_run_script pointer", async () => {
    const s = await startSession(AE_ONLY);
    const d = (await s.c.listTools()).tools.find((t) => t.name === "cc_eval_script")!.description!;
    expect(d).toContain(
      "(raw scripts disabled, app not enabled, app not connected, or an After Effects script that closes or replaces the " +
        "open project, which only ae_run_script runs);",
    );
    expect(d).toContain("For After Effects (when its tools are enabled), ae_run_script runs a script as one undo step.");
    await s.close();
  });
});

describe("ae_run_script with the gate open for After Effects (AE-01)", () => {
  const AE_ONLY: Partial<Config> = { allowRawScripts: true, rawScriptApps: ["after_effects"] };
  let audit: MockInstance;
  beforeEach(() => {
    audit = vi.spyOn(log, "audit").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the built script as one slow eval command, and it really runs (A2)", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const cmds = vmPanel(panel, runScriptHost());
    const script = "(function(){ return app.version; })()";
    const r = await s.c.callTool({ name: "ae_run_script", arguments: { script } });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.name).toBe("eval");
    expect(cmds[0]!.timeoutClass).toBe("slow");
    expect(cmds[0]!.params.script).toBe(runRawScript(script, { args: "{}", undoGroupName: "Brainferno script", suppressDialogs: true }));
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, value: "26.5", logs: [] });
    expect(rawAuditLines(audit)).toEqual([expect.stringMatching(/^raw-script tool=ae_run_script app=after_effects sha256=[0-9a-f]{12} len=\d+ via=stdio outcome=run$/)]);
    panel.close();
    await s.close();
  });

  it("makes two layers in one undo group (A3)", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const host = runScriptHost();
    vmPanel(panel, host);
    const script = 'var c = app.project.itemByID(12);\nc.layers.addSolid([1,0,0], "A");\nc.layers.addText("B");\nc.numLayers';
    const r = await s.c.callTool({ name: "ae_run_script", arguments: { script, undoGroupName: "Two layers" } });
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, value: 5 });
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    expect(host.mutations).toEqual(["layers.addSolid", "layers.addText"]);
    panel.close();
    await s.close();
  });

  it("maps a calibrated host line to bodyLine, and drops an uncalibrated or out-of-range one (A4)", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    let error = { message: "x", line: 2, lineBase: 0 };
    recordCmds(panel, (f) => reply(panel, f.id, { ok: false, error, value: null, logs: ["a"], logsDropped: 0 }));
    const script = "var a = 1;\nundefinedThing.x;\na";
    const at = async () => JSON.parse(textOf(await s.c.callTool({ name: "ae_run_script", arguments: { script } }))).error;
    expect(await at()).toEqual({ message: "x", line: 2, bodyLine: 2 });
    error = { message: "x", line: 140, lineBase: 0 };
    expect(await at()).toEqual({ message: "x", line: 140, bodyLine: null });
    error = { message: "x", line: 2, lineBase: 5 };
    expect(await at()).toEqual({ message: "x", line: 2, bodyLine: null });
    panel.close();
    await s.close();
  });

  it("a throw outside the wrapper (beginSuppressDialogs) reaches the panel as a host error: dispatched envelope, no bodyLine (T6b, T6c)", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const host = runScriptHost();
    host.app.beginSuppressDialogs = () => {
      throw new host.VmError("Suppress failed");
    };
    const lines: (number | undefined)[] = [];
    recordCmds(panel, (f) => {
      const r = host.eval(f.params.script!);
      if (r.ok) return reply(panel, f.id, r.value);
      const frame = panelReply(r);
      lines.push(frame.line);
      reply(panel, f.id, frame, false);
    });
    const r = await s.c.callTool({ name: "ae_run_script", arguments: { script: "1" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r))).toMatchObject({
      ok: false,
      value: null,
      logs: [],
      error: { message: "Suppress failed — the script was sent; it may have partly run", line: null, bodyLine: null },
    });
    // The panel's own line is the begin call's, in the built script (computed, never typed).
    const src = runRawScript("1", { args: "{}", undoGroupName: "Brainferno script", suppressDialogs: true });
    expect(lines).toEqual([src.split("\n").findIndex((l) => l.includes("app.beginSuppressDialogs();")) + 1]);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    panel.close();
    await s.close();
  });

  it("a failing endUndoGroup comes back through the socket as an annotated envelope that keeps value and logs (ES-6)", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const host = runScriptHost();
    host.app.endUndoGroup = () => {
      throw new host.VmError("Undo group mismatch");
    };
    vmPanel(panel, host);
    const r = await s.c.callTool({ name: "ae_run_script", arguments: { script: '__log("kept?");\n5' } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r))).toMatchObject({
      ok: false,
      error: {
        message: "app.endUndoGroup() failed: Undo group mismatch — the script ran; check After Effects before re-running.",
        line: null,
        bodyLine: null,
      },
      value: 5,
      logs: ["kept?"],
    });
    panel.close();
    await s.close();
  });

  it("without suppression a modal dialog hangs the call until the timeout; with it (the default) the call returns (A5)", async () => {
    const s = await startSession(AE_ONLY);
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const host = runScriptHost();
    // Stand in for a dialog that blocks scripting: a script sent without suppression never answers.
    const cmds = recordCmds(panel, (f) => {
      if (!f.params.script!.includes("app.beginSuppressDialogs();")) return;
      const r = host.eval(f.params.script!);
      if (r.ok) reply(panel, f.id, r.value);
      else reply(panel, f.id, panelReply(r), false);
    });
    const hung = await s.c.callTool({ name: "ae_run_script", arguments: { script: "app.project.numItems", suppressDialogs: false, timeoutMs: 100 } });
    expect(hung.isError).toBe(true);
    expect(JSON.parse(textOf(hung)).error.message).toMatch(/^timed out after 100 ms — the script may still be running or have partly run/);
    const ok = await s.c.callTool({ name: "ae_run_script", arguments: { script: "app.project.numItems" } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(textOf(ok))).toMatchObject({ ok: true, value: 1 });
    expect(cmds).toHaveLength(2);
    panel.close();
    await s.close();
  });

  it("says plain-text 'not connected' when no panel is there (nothing was dispatched)", async () => {
    const s = await startSession(AE_ONLY);
    const r = await s.c.callTool({ name: "ae_run_script", arguments: { script: "1" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^No running host connected/);
    expect(() => JSON.parse(textOf(r))).toThrow();
    expect(rawAuditLines(audit)).toEqual([expect.stringMatching(/ outcome=run$/)]);
    await s.close();
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

    // AE-01 (T3): ae_run_script takes the same remote refusal, and sends nothing either.
    const ae = await s.c.callTool({ name: "ae_run_script", arguments: { script: "1" } });
    expect(ae.isError).toBe(true);
    expect(textOf(ae)).toBe(REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE);
    await settle();
    expect(cmds).toEqual([]);
    expect(rawAuditLines(audit).at(-1)).toMatch(/^raw-script tool=ae_run_script app=after_effects .* via=http:a1b2c3d4 outcome=refused$/);

    const caps = JSON.parse(textOf(await s.c.callTool({ name: "cc_get_capabilities", arguments: {} })));
    expect(caps.session).toBe("remote");
    const aeRow = caps.tools.find((t: { tool: string; app: string }) => t.tool === "cc_eval_script" && t.app === "after_effects");
    expect(aeRow).toMatchObject({ enabled: false, enableWith: REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE });
    const runRow = caps.tools.find((t: { tool: string; app: string }) => t.tool === "ae_run_script" && t.app === "after_effects");
    expect(runRow).toMatchObject({ enabled: false, enableWith: REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE });
    await rowsMatchCalls(s.c, caps);
    await settle();
    expect(cmds).toEqual([]);
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

    // AE-01 (T3): a second panel (it replaces p2) backed by ae-host, whose context has an `app` (hostEval's has none).
    const p3 = await connectPanel(allowed.bridge.port(), "after_effects");
    const cmds3 = vmPanel(p3, runScriptHost());
    const run = await allowed.c.callTool({ name: "ae_run_script", arguments: { script: "40 + 2" } });
    expect(run.isError).toBeFalsy();
    expect(JSON.parse(textOf(run)).value).toBe(42);
    expect(cmds3).toHaveLength(1);
    expect(rawAuditLines(audit).at(-1)).toMatch(/^raw-script tool=ae_run_script app=after_effects .* via=http:ffff0000 outcome=run$/);
    const caps2 = JSON.parse(textOf(await allowed.c.callTool({ name: "cc_get_capabilities", arguments: {} })));
    expect(caps2.tools.find((t: { tool: string; app: string }) => t.tool === "ae_run_script" && t.app === "after_effects")).toMatchObject({
      enabled: true,
      enableWith: null,
    });
    await rowsMatchCalls(allowed.c, caps2);
    p2.close();
    p3.close();
    await allowed.close();
  });

  /** For both After Effects raw rows: calling the tool answers with enableWith exactly when the row says disabled. */
  async function rowsMatchCalls(c: Client, caps: { tools: { tool: string; app: string; enabled: boolean; enableWith: string | null }[] }) {
    const calls: [string, Record<string, unknown>][] = [
      ["cc_eval_script", { appId: "after_effects", script: "1" }],
      ["ae_run_script", { script: "1" }],
    ];
    for (const [tool, args] of calls) {
      const row = caps.tools.find((t) => t.tool === tool && t.app === "after_effects")!;
      const r = await c.callTool({ name: tool, arguments: args });
      if (row.enabled) {
        expect(row.enableWith, tool).toBeNull();
        expect(r.isError, tool).toBeFalsy();
      } else {
        expect(r.isError, tool).toBe(true);
        expect(textOf(r), tool).toBe(row.enableWith);
      }
    }
  }
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
      "ae_run_script:after_effects",
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
    // AE-01: ae_run_script rides the panel's generic eval command, like cc_eval_script.
    expect(row(caps, "ae_run_script", "after_effects")).toEqual({
      tool: "ae_run_script",
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
    expect(names).toContain("ae_run_script");
    await c.close();
    await built.server.close();
    await built.bridge.close();
  });

  it("lists ae_run_script only with After Effects' tools (AE-01)", async () => {
    const built = buildServer({ ...config, enabledApps: ["photoshop"], allowRawScripts: true, rawScriptApps: ["after_effects", "photoshop"] });
    await built.bridge.ready();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "subset", version: "0" });
    await Promise.all([c.connect(ct), built.server.connect(st)]);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("ps_batch_play");
    expect(names).not.toContain("ae_run_script");
    expect(names.filter((n) => n.startsWith("ae_"))).toEqual([]);
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

describe("After Effects error context (AE-16)", () => {
  const NEXT_BODY = "check the values the line marked >>> uses (ae_get_comp and ae_get_layer show what exists), then retry";
  const PRELUDE_LENGTH = wrapAe("").length - "\n})()".length;

  /** The 1-based body line (first statement = 1) of the first body line containing `needle`. */
  const bodyLineOf = (script: string, needle: string) => script.slice(PRELUDE_LENGTH).split("\n").slice(1).findIndex((l) => l.includes(needle)) + 1;
  /** The script line of the first line containing `needle`. */
  const scriptLineOf = (script: string, needle: string) => script.split("\n").findIndex((l) => l.includes(needle)) + 1;

  it("a canned body-failure frame reads as body line 3 with the code around it (acceptance 6)", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const line = AE_PRELUDE_LINES + 4;
    recordCmds(panel, (f) => reply(panel, f.id, { code: "HOST_ERROR", message: "boom", line }, false));
    const r = await s.c.callTool({ name: "ae_list_compositions", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      `Script failed in After Effects (ae_list_compositions) at body line 3 (script line ${line}): boom — ${NEXT_BODY}. ` +
        "Code: 2: for (var i = 1; i <= app.project.numItems; i++) { | >>> 3: var item = app.project.item(i); | 4: if (item instanceof CompItem) { comps.push(__compInfo(item)); }",
    );
    panel.close();
    await s.close();
  });

  it("a real body failure, through a vm-backed panel, is body line 3, not +prelude (acceptance 1)", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const host = aeHost();
    host.app.project.item = () => {
      throw new host.VmError("boom");
    };
    vmPanel(panel, host);
    const text = textOf(await s.c.callTool({ name: "ae_list_compositions", arguments: {} }));
    expect(text).toContain(`(ae_list_compositions) at body line 3 (script line ${AE_PRELUDE_LINES + 4}): boom — `);
    expect(text).toContain(">>> 3: var item = app.project.item(i);");
    panel.close();
    await s.close();
  });

  it("an out-of-range layer names the tool, its arguments, the helper and every layer (acceptance 3)", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    vmPanel(panel, aeHost());
    const r = await s.c.callTool({ name: "ae_get_layer", arguments: { compId: 12, layerIndex: 9 } });
    const line = scriptLineOf(getLayerScript(12, 9), 'throw new Error(what + " (1.."');
    expect(textOf(r)).toBe(
      `Script failed in After Effects (ae_get_layer, args {compId: 12, layerIndex: 9}) in helper __layer (script line ${line}): ` +
        `Layer index 9 is out of range (1..3) in "Main" (id 12): 1 "Title" (text), 2 "Logo" (shape), 3 "BG" (solid) — pass one of these indexes (ae_get_comp lists every layer).`,
    );
    panel.close();
    await s.close();
  });

  it("ae_apply_effect suggests close installed effects, reading the list once per panel connection (acceptance 4)", async () => {
    const s = await startSession({});
    const host = aeHost();
    let panel = await connectPanel(s.bridge.port(), "after_effects");
    let cmds = vmPanel(panel, host);
    const listReads = () => cmds.filter((c) => c.params.script === LIST_INSTALLED_EFFECTS).length;
    const apply = () => s.c.callTool({ name: "ae_apply_effect", arguments: { compId: 12, layerIndex: 3, matchName: "ADBE Gausian Blur 2" } });

    const first = textOf(await apply());
    const n = bodyLineOf(applyEffectScript(12, 3, "ADBE Gausian Blur 2"), "canAddProperty");
    expect(first).toContain(`(ae_apply_effect, args {compId: 12, layerIndex: 3, matchName: "ADBE Gausian Blur 2"}) at body line ${n} `);
    expect(first).toContain('Did you mean "ADBE Gaussian Blur 2" (Gaussian Blur)');
    expect(first).toContain(`Code: `);
    expect(listReads()).toBe(1);

    await apply();
    expect(listReads()).toBe(1);

    // The panel reconnects (a new hello): the next miss reads the list again.
    panel.close();
    await vi.waitFor(() => expect(s.bridge.connectedApps()).not.toContain("after_effects"));
    panel = await connectPanel(s.bridge.port(), "after_effects");
    cmds = vmPanel(panel, host);
    const third = textOf(await apply());
    expect(third).toContain('Did you mean "ADBE Gaussian Blur 2" (Gaussian Blur)');
    expect(listReads()).toBe(1);
    panel.close();
    await s.close();
  });

  it("a helper line and a host.jsx serializer line read as helper and outside", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const helperLine = scriptLineOf(getCompScript(12), "No composition with id");
    const empty = `No composition with id 12; the project has no compositions — create one with ae_create_comp and pass its id.`;
    const serializer = "After Effects error: Text document not of Box document type";
    recordCmds(panel, (f) => {
      const outside = f.params.script!.includes("var keys = [];");
      reply(panel, f.id, outside ? { code: "HOST_ERROR", message: serializer, line: 40 } : { code: "HOST_ERROR", message: empty, line: helperLine }, false);
    });
    const comp = await s.c.callTool({ name: "ae_get_comp", arguments: { compId: 12 } });
    expect(textOf(comp)).toBe(`Script failed in After Effects (ae_get_comp, args {compId: 12}) in helper __comp (script line ${helperLine}): ${empty}`);
    const keys = await s.c.callTool({
      name: "ae_get_keyframes",
      arguments: { compId: 32, layerIndex: 4, property: "position", propertyPath: ["ADBE Text Properties", "ADBE Text Document"] },
    });
    expect(textOf(keys)).toBe(
      'Script failed in After Effects (ae_get_keyframes, args {compId: 32, layerIndex: 4, property: "position", propertyPath: ["ADBE Text Properties", "ADBE Text Document"]}) ' +
        `at script line 40, outside this tool's own code (most likely while the panel converted the result to JSON): ${serializer} — ` +
        "the result held a value After Effects could not read; read it another way (for example ae_get_layer) or report the tool and its arguments.",
    );
    panel.close();
    await s.close();
  });

  it("a property path on the wrong kind of layer is explained by the kind, with no suggestions", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    vmPanel(panel, aeHost());
    const r = await s.c.callTool({
      name: "ae_set_expression",
      arguments: { compId: 12, layerIndex: 2, property: "position", propertyPath: ["ADBE Text Properties", "ADBE Text Document"], expression: "time*2" },
    });
    const text = textOf(r);
    expect(text).toMatch(/^Script failed in After Effects \(ae_set_expression, args \{compId: 12, layerIndex: 2, property: "position", propertyPath: \[.*\], expression: "time\*2"\}\) in helper __prop /);
    expect(text).toContain(`Property path not found on layer 2 "Logo" (shape): "ADBE Text Properties" exists only on text layers — address a text layer`);
    expect(text).not.toContain("Did you mean");
    expect(text).not.toContain("children here");
    panel.close();
    await s.close();
  });

  it("never echoes the server's own secrets: arguments and host messages are redacted", async () => {
    // No digit and under 32 characters, so only the configured-secret rule (R1) can catch it.
    const secret = "SuperSecretHttpTokenValue";
    const s = await startSession({ httpToken: secret });
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    const host = aeHost();
    recordCmds(panel, (f) => {
      const r = host.eval(f.params.script!);
      // Stand in for a host message that quotes the value back.
      reply(panel, f.id, r.ok ? r.value : { ...panelReply(r), message: `${r.error.message} (${secret})` }, r.ok);
    });
    const r = await s.c.callTool({
      name: "ae_set_expression",
      arguments: { compId: 12, layerIndex: 9, property: "position", expression: `"${secret}"` },
    });
    const text = textOf(r);
    expect(text).toContain('expression: "\\"[redacted]\\""');
    expect(text).toContain("([redacted])");
    expect(text).not.toContain(secret);
    panel.close();
    await s.close();
  });

  it("a secret longer than a name cut, used as a composition name, leaves no prefix where the host cut it (K2)", async () => {
    // 72 characters; the host lists names cut to their first 60 and "...".
    const secret = "s3cr3tValue".repeat(7).slice(0, 72);
    const s = await startSession({ httpToken: secret });
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    vmPanel(panel, aeHost({ comps: [{ id: 12, name: secret }] }));
    const text = textOf(await s.c.callTool({ name: "ae_get_comp", arguments: { compId: 99 } }));
    expect(text).toContain('the project has 1: 12 "[redacted]..."');
    expect(text).not.toContain(secret.slice(0, 20));
    panel.close();
    await s.close();
  });

  it("a secret after other text in a composition name leaves no part of itself where the host cut the name (F1)", async () => {
    // The shape of the generated panel token: 64 hex characters.
    const secret = "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f7";
    const ordinary = "Instagram_Story_1080x1920_v02_FINAL_extended_cut_for_client_review";
    const s = await startSession({ httpToken: secret });
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    vmPanel(panel, aeHost({ comps: [{ id: 12, name: `tok ${secret}` }, { id: 13, name: `bridge token: ${secret}` }, { id: 14, name: ordinary }] }));
    const text = textOf(await s.c.callTool({ name: "ae_get_comp", arguments: { compId: 99 } }));
    expect(text).toContain('12 "tok [redacted]...", 13 "bridge token: [redacted]..."');
    expect(text).not.toContain(secret.slice(0, 8));
    // An ordinary long name, cut by the host, is shown as cut.
    expect(text).toContain(`14 "${ordinary.slice(0, 60)}..."`);
    panel.close();
    await s.close();
  });

  it("labels each of two concurrent failures with its own tool", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    vmPanel(panel, aeHost(), 30);
    const [comp, layer] = await Promise.all([
      s.c.callTool({ name: "ae_get_comp", arguments: { compId: 99 } }),
      s.c.callTool({ name: "ae_get_layer", arguments: { compId: 12, layerIndex: 9 } }),
    ]);
    expect(textOf(comp)).toMatch(/^Script failed in After Effects \(ae_get_comp, args \{compId: 99\}\) in helper __comp .*No composition with id 99;/);
    expect(textOf(layer)).toMatch(/^Script failed in After Effects \(ae_get_layer, args \{compId: 12, layerIndex: 9\}\) in helper __layer .*Layer index 9 is out of range/);
    panel.close();
    await s.close();
  });

  it("a panel older than the server (UNKNOWN_COMMAND) says to update it, for any app (D1)", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "photoshop");
    recordCmds(panel, (f) => reply(panel, f.id, { code: "UNKNOWN_COMMAND", message: "panel does not implement ps.list_documents" }, false));
    const r = await s.c.callTool({ name: "ps_list_documents", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      "The Photoshop panel does not support this command (panel does not implement ps.list_documents) — it is older than this server; " +
        "update the brainferno-mcp-bridge panel (or reload it after updating), then retry.",
    );
    panel.close();
    await s.close();
  });

  it("a panel that drops mid-call says the call may have partly run and how to reconnect (D12)", async () => {
    const s = await startSession({});
    const panel = await connectPanel(s.bridge.port(), "after_effects");
    recordCmds(panel, () => panel.terminate());
    const r = await s.c.callTool({ name: "ae_list_compositions", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      'The "after_effects" panel disconnected before the command completed (socket closed) — it may have partly run; check After Effects, ' +
        "reconnect the brainferno-mcp-bridge panel (cc_connected_apps shows when it is back), then retry.",
    );
    await s.close();
  });
});

describe("buildRuntime registers the server's own secrets for redaction (R15)", () => {
  afterEach(() => setRedactionSecrets([]));

  it("a generated panel token and the Illustrator key never reach a host message", async () => {
    // Only the configured-secret rule (R1) can catch either: 64 hex characters are kept in host
    // messages on purpose, and this key has no "ilst_" prefix.
    const key = "illustrator-key-without-its-usual-prefix";
    const rt = buildRuntime({ ...config, bridgeInsecure: false, bridgeToken: "", handshakeFilePath: join(tempDir("bf-redact-"), "bridge.json"), illustratorMcpKey: key });
    await rt.bridge.ready();
    try {
      const [token] = rt.bridge.redactionSecrets();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      for (const secret of [token!, key]) {
        const text = scriptErrorText(new ScriptError("after_effects", `quoted ${secret} here`, 1, { where: "unknown" }));
        expect(text).toBe("Script failed in After Effects: quoted [redacted] here");
      }
    } finally {
      await rt.bridge.close();
    }
  });
});
