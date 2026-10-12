import { createHash } from "node:crypto";
import vm from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  AppDisconnectedError,
  AppNotConnectedError,
  EvalTimeoutError,
  ScriptError,
  type AppBridge,
  type EvalOptions,
  type JsonValue,
} from "../src/bridge/types.js";
import { log } from "../src/logging.js";
import {
  RUN_SCRIPT_DESCRIPTION,
  RUN_SCRIPT_MANAGED_REFUSAL,
  aeArgsLiteral,
  locateAeError,
  registerAfterEffectsTools,
  runRawScript,
  type AfterEffectsToolOptions,
} from "../src/tools/after-effects.js";
import { currentToolCall, type ToolCall } from "../src/tools/call-context.js";
import {
  RAW_SCRIPTS_DISABLED_MESSAGE,
  REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE,
  lineCount,
  rawScriptWrapper,
  rawScriptsDisabledMessage,
} from "../src/tools/raw-script.js";
import { aeHost, panelReply, type AeHost } from "./ae-host.js";

/**
 * AE-01: ae_run_script through registerAfterEffectsTools on a bare McpServer over the in-memory MCP
 * transport, with a recording bridge (what was evaluated, with which options, in which tool-call
 * context) answered canned or by ae-host, and a spy on log.audit.
 */

type Gate = Pick<AfterEffectsToolOptions, "rawScriptApps" | "remote" | "allowRemoteRawScripts">;
const OPEN: Gate = { rawScriptApps: ["after_effects"], remote: false, allowRemoteRawScripts: false };
const CLOSED: Gate = { rawScriptApps: [], remote: false, allowRemoteRawScripts: false };
const SECRET = "TOP-SECRET-AE01";
/** Each shim's text, pinned whole: its own next step (R12). */
const MODAL = {
  alert: "alert() would open a modal dialog in After Effects and block scripting until someone dismisses it — use __log(msg) instead.",
  confirm:
    "confirm() would open a modal dialog in After Effects and block scripting until someone dismisses it — pass the answer in args and read it from __args.",
  prompt:
    "prompt() would open a modal dialog in After Effects and block scripting until someone dismisses it — pass the answer in args and read it from __args.",
} as const;
/** The note an end call's failure adds after the script returned (it ran). */
const CLOSED_NOTE = (call: string, msg: string) => `${call} failed: ${msg} — the script ran; check After Effects before re-running.`;
/** The note an end call's failure adds to an error the call itself threw (the script may not have run). */
const THROWN_NOTE = (call: string, msg: string) => `${call} failed: ${msg} — check After Effects before re-running.`;
/** What the server appends to a host error that escaped the built script (dispatchedFailure). */
const SENT = " — the script was sent; it may have partly run";
/** cc_eval_script's own sentence (diagnostics.ts), which ae_run_script's script describe repeats verbatim. */
const BODYLINE_SENTENCE =
  "bodyLine is null when the error was raised outside your script's own text (for example in a $.evalFile'd " +
  "library, or in a helper an earlier call left as a global) or the host's line numbering cannot be calibrated.";

type Evaluate = (script: string) => Promise<JsonValue> | JsonValue;
interface Call {
  script: string;
  opts: EvalOptions | undefined;
  ctx: ToolCall | undefined;
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const envOf = (r: unknown) => JSON.parse(textOf(r)) as Record<string, any>;

async function session(gate: Gate, evaluate: Evaluate = () => null, opts: { sessionId?: string } = {}) {
  const calls: Call[] = [];
  const bridge: AppBridge = {
    appId: "after_effects",
    isConnected: () => true,
    execute: async () => null,
    close: async () => {},
    evaluate: async (script, o) => {
      calls.push({ script, opts: o, ctx: currentToolCall() });
      return evaluate(script);
    },
  };
  const server = new McpServer({ name: "ae01", version: "0" });
  registerAfterEffectsTools(server, bridge, { ...gate });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  if (opts.sessionId !== undefined) st.sessionId = opts.sessionId;
  const client = new Client({ name: "ae01", version: "0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return {
    calls,
    run: (args: Record<string, unknown>) => client.callTool({ name: "ae_run_script", arguments: args }),
    tool: async () => (await client.listTools()).tools.find((t) => t.name === "ae_run_script"),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** ae-host as the panel: the value, or the ScriptError the socket builds from the panel's failure frame. */
const aeRun =
  (host: AeHost): Evaluate =>
  (script) => {
    const r = host.eval(script);
    if (r.ok) return r.value as JsonValue;
    const p = panelReply(r);
    throw new ScriptError("after_effects", p.message, p.line, { code: p.code });
  };

/**
 * Records the host calls around the script, in order, with how many mutations ae-host had seen (`@n`).
 * ae-host's own `mutations` stays exactly what the script did.
 */
function events(host: AeHost): string[] {
  const ev: string[] = [];
  const at = () => `@${host.mutations.length}`;
  const b0 = host.app.beginUndoGroup;
  const e0 = host.app.endUndoGroup;
  host.app.beginUndoGroup = (n: string) => {
    ev.push(`begin:${n}${at()}`);
    b0.call(host.app, n);
  };
  host.app.endUndoGroup = () => {
    ev.push(`end${at()}`);
    e0.call(host.app);
  };
  host.app.beginSuppressDialogs = () => {
    ev.push(`sup${at()}`);
  };
  host.app.endSuppressDialogs = (b: boolean) => {
    ev.push(`unsup:${b}${at()}`);
  };
  return ev;
}

let audit: MockInstance;
beforeEach(() => {
  audit = vi.spyOn(log, "audit").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
const auditLines = () => audit.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("raw-script "));
const REFUSED_LINE = /^raw-script tool=ae_run_script app=after_effects sha256=[0-9a-f]{12} len=\d+ via=stdio outcome=refused$/;

describe("ae_run_script: gate, refusals and audit (nothing dispatched → plain text)", () => {
  it("refuses with the shared gate text while the gate is closed, before touching the bridge (A1)", async () => {
    const s = await session(CLOSED);
    const r = await s.run({ script: `/* ${SECRET} */ 1` });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
    expect(textOf(r)).toContain("(This call targets After Effects; currently enabled for: none.)");
    expect(textOf(r)).not.toContain(SECRET);
    expect(s.calls).toEqual([]);
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    await s.close();

    const ps = await session({ ...CLOSED, rawScriptApps: ["photoshop"] });
    const p = await ps.run({ script: "1" });
    expect(textOf(p)).toBe(rawScriptsDisabledMessage("after_effects", ["photoshop"]));
    expect(textOf(p)).toContain("currently enabled for: photoshop");
    expect(ps.calls).toEqual([]);
    await ps.close();
  });

  it("refuses a remote session unless remote raw scripts are allowed", async () => {
    const s = await session({ ...OPEN, remote: true });
    const r = await s.run({ script: "1" });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toBe(REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE);
    expect(s.calls).toEqual([]);
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    await s.close();

    const ok = await session({ ...OPEN, remote: true, allowRemoteRawScripts: true }, () => ({ ok: true, value: 7, logs: [], logsDropped: 0 }));
    const r2 = await ok.run({ script: "7" });
    expect(isError(r2)).toBe(false);
    expect(envOf(r2)).toMatchObject({ ok: true, value: 7 });
    expect(ok.calls).toHaveLength(1);
    await ok.close();
  });

  it("refuses args ExtendScript cannot receive as data, in the encoder's own words", async () => {
    const s = await session(OPEN);
    for (const args of [JSON.parse('{"a":{"b":1e999}}'), JSON.parse('{"o":{"__proto__":1}}')] as Record<string, unknown>[]) {
      audit.mockClear();
      const expected = aeArgsLiteral(args);
      expect("refusal" in expected).toBe(true);
      const r = await s.run({ script: `/* ${SECRET} */ 1`, args });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toBe((expected as { refusal: string }).refusal);
      expect(textOf(r)).not.toContain(SECRET);
      expect(() => JSON.parse(textOf(r))).toThrow();
      expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    }
    expect(s.calls).toEqual([]);
    await s.close();
  });

  it("deep args: the gate still wins, the audit line is still written, and depth is refused at level 32 (T2, F1)", async () => {
    // 100,000 levels overflow JSON.stringify on any thread (a worker's stack takes about 19,000, a main thread's 4,800).
    const args = JSON.parse(`{"a":${"[".repeat(100_000)}${"]".repeat(100_000)}}`) as Record<string, unknown>;
    expect(() => JSON.stringify(args)).toThrow(RangeError); // precondition: else the audit payload is not the fallback
    const script = "1";
    const fallback = JSON.stringify({ script, args: "[args could not be serialized: nested too deeply]" });

    const closed = await session(CLOSED);
    const r = await closed.run({ script, args });
    expect(textOf(r)).toBe(rawScriptsDisabledMessage("after_effects", []));
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    expect(auditLines()[0]).toContain(` len=${fallback.length} `);
    expect(auditLines()[0]).toContain(` sha256=${createHash("sha256").update(fallback).digest("hex").slice(0, 12)} `);
    expect(closed.calls).toEqual([]);
    await closed.close();

    audit.mockClear();
    const open = await session(OPEN);
    const r2 = await open.run({ script, args });
    expect(isError(r2)).toBe(true);
    expect(textOf(r2)).toBe((aeArgsLiteral(args) as { refusal: string }).refusal);
    expect(textOf(r2).startsWith("args.a[0]")).toBe(true);
    expect(textOf(r2)).toContain("nested more than 32 levels deep — flatten args.");
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    expect(open.calls).toEqual([]);
    await open.close();
  });

  it("refuses a script that names an undo-group or dialog-suppression call, even in a comment (ES-3)", async () => {
    const s = await session(OPEN, () => ({ ok: true, value: 1, logs: [], logsDropped: 0 }));
    for (const script of [
      'app.beginUndoGroup("x"); 1',
      "app.endUndoGroup(); 1",
      "app.beginSuppressDialogs(); 1",
      "app.endSuppressDialogs(false); 1",
      "// beginUndoGroup\n1",
    ]) {
      audit.mockClear();
      const r = await s.run({ script: `${script} /* ${SECRET} */` });
      expect(isError(r), script).toBe(true);
      expect(textOf(r), script).toBe(RUN_SCRIPT_MANAGED_REFUSAL);
      expect(auditLines(), script).toEqual([expect.stringMatching(REFUSED_LINE)]);
    }
    expect(s.calls).toEqual([]);

    // Args are checked first: a script that names a managed call, with args that are refused, gets the args refusal.
    const both = await s.run({ script: "app.endUndoGroup(); 1", args: { a: Infinity } });
    expect(textOf(both)).toBe((aeArgsLiteral({ a: Infinity }) as { refusal: string }).refusal);
    expect(s.calls).toEqual([]);

    // A guard against honest mistakes, not adversaries: a computed name is not refused, it is sent; nor is a
    // longer identifier that merely contains a managed name (B24).
    audit.mockClear();
    const sent = await s.run({ script: 'app["end" + "UndoGroup"](); 1' });
    expect(isError(sent)).toBe(false);
    expect(s.calls).toHaveLength(1);
    expect(auditLines()).toEqual([expect.stringMatching(/ outcome=run$/)]);
    for (const script of ["var x = app.endUndoGroupX; 1", "var mybeginUndoGroup = 1; mybeginUndoGroup", "myBeginUndoGroup = 1; 1"]) {
      expect(isError(await s.run({ script })), script).toBe(false);
    }
    expect(s.calls).toHaveLength(4);

    // The match is case-sensitive, as After Effects' own names are (K2b): another case names no managed call, so
    // it is sent, not refused.
    audit.mockClear();
    for (const script of ['app.BeginUndoGroup("x"); 1', "// BEGINUNDOGROUP\n1", "app.EndSuppressDialogs(false); 1"]) {
      const r = await s.run({ script });
      expect(isError(r), script).toBe(false);
      expect(textOf(r), script).not.toBe(RUN_SCRIPT_MANAGED_REFUSAL);
    }
    expect(s.calls).toHaveLength(7);
    expect(auditLines()).toEqual([expect.stringMatching(/ outcome=run$/), expect.stringMatching(/ outcome=run$/), expect.stringMatching(/ outcome=run$/)]);
    await s.close();
  });

  it("audits a run with the hash and length of the JSON of { script, args }, and the session it came from", async () => {
    const answer = () => ({ ok: true, value: 42, logs: [], logsDropped: 0 });
    const s = await session(OPEN, answer);
    const script = "__args.n + 1";
    await s.run({ script, args: { n: 41 } });
    const payload = JSON.stringify({ script, args: { n: 41 } });
    const hash = createHash("sha256").update(payload).digest("hex").slice(0, 12);
    expect(auditLines()).toEqual([`raw-script tool=ae_run_script app=after_effects sha256=${hash} len=${payload.length} via=stdio outcome=run`]);
    audit.mockClear();
    await s.run({ script });
    const bare = JSON.stringify({ script });
    expect(auditLines()).toEqual([
      `raw-script tool=ae_run_script app=after_effects sha256=${createHash("sha256").update(bare).digest("hex").slice(0, 12)} len=${bare.length} via=stdio outcome=run`,
    ]);
    await s.close();

    audit.mockClear();
    const remote = await session({ ...OPEN, remote: true, allowRemoteRawScripts: true }, answer, { sessionId: "0badc0de-1234" });
    await remote.run({ script });
    expect(auditLines()).toEqual([expect.stringMatching(/ via=http:0badc0de outcome=run$/)]);
    await remote.close();
  });
});

describe("ae_run_script: dispatched failures are JSON envelopes; not connected is plain text", () => {
  const throwing = (error: unknown): Evaluate => () => {
    throw error;
  };

  it("maps each bridge failure the way cc_eval_script does, and never echoes the script", async () => {
    const script = `var marker = "${SECRET}";\nmarker`;
    const cases: [unknown, (r: unknown) => void][] = [
      [
        new ScriptError("after_effects", "EvalScript error.", 140, { code: "HOST_ERROR" }),
        (r) => {
          expect(envOf(r)).toMatchObject({
            ok: false,
            value: null,
            logs: [],
            error: { message: "EvalScript error. — the script was sent; it may have partly run", line: null, bodyLine: null },
          });
        },
      ],
      [new EvalTimeoutError("after_effects", 100), (r) => expect(envOf(r).error.message).toMatch(/^timed out after 100 ms — the script may still be running/)],
      [new AppDisconnectedError("after_effects", "socket closed"), (r) => expect(envOf(r).error.message).toContain("may have partly run")],
    ];
    for (const [error, check] of cases) {
      const s = await session(OPEN, throwing(error));
      const r = await s.run({ script });
      expect(isError(r)).toBe(true);
      check(r);
      expect(textOf(r)).not.toContain(SECRET);
      expect(s.calls).toHaveLength(1);
      await s.close();
    }

    const s = await session(OPEN, throwing(new AppNotConnectedError("after_effects", "Open the panel.")));
    const r = await s.run({ script });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/^No running host connected/);
    expect(() => JSON.parse(textOf(r))).toThrow();
    expect(textOf(r)).not.toContain(SECRET);
    await s.close();
  });

  it("runs in a tool-call context that names the tool and never holds its arguments (T8)", async () => {
    const s = await session(OPEN, () => ({ ok: true, value: 1, logs: [], logsDropped: 0 }));
    await s.run({ script: `/* ${SECRET} */ 1`, args: { k: SECRET } });
    expect(s.calls[0]!.ctx).toEqual({ tool: "ae_run_script", args: undefined });
    await s.close();
  });

  it("is never located as a typed tool's body, so AE-16 quotes none of it", () => {
    const built = runRawScript(`var marker = "${SECRET}";\nmarker`, { args: "{}", undoGroupName: "x", suppressDialogs: true });
    for (let n = 1; n <= lineCount(built); n++) expect(locateAeError(built, n).kind, `line ${n}`).toBe("unknown");
  });
});

describe("ae_run_script: metadata", () => {
  it("is destructive and open-world, and says every default and the error-shape rule", async () => {
    const s = await session(CLOSED);
    const tool = await s.tool();
    expect(tool).toBeDefined();
    expect(tool!.title).toBe("After Effects: run a raw ExtendScript as one undo step");
    expect(tool!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    const props = tool!.inputSchema["properties"] as Record<string, { description?: string }>;
    expect(Object.keys(props).sort()).toEqual(["args", "script", "suppressDialogs", "timeoutMs", "undoGroupName"]);
    for (const [name, p] of Object.entries(props)) expect(p.description ?? "", name).not.toBe("");
    for (const name of ["undoGroupName", "suppressDialogs", "args"]) expect(props[name]!.description, name).toMatch(/[Dd]efaults to/);
    expect(props["timeoutMs"]!.description).toContain("BRAINFERNO_MCP_EVAL_TIMEOUT_MS");
    expect(props["timeoutMs"]!.description).not.toMatch(/\d\s*ms/); // F7: the number lives in config, not here
    expect(tool!.inputSchema["required"]).toEqual(["script"]);

    expect(tool!.description).toBe(RUN_SCRIPT_DESCRIPTION);
    await s.close();
  });

  it("puts the safety text first, inside the 2,048 characters a client shows, and the detail in the parameters (R1)", async () => {
    const s = await session(CLOSED);
    const tool = await s.tool();
    const d = tool!.description!;
    const describe = (name: string) => (tool!.inputSchema["properties"] as Record<string, { description: string }>)[name]!.description;
    // Claude Code cuts a tool description at 2,048 characters; measured as tools/list delivers it.
    expect(d.length).toBeLessThanOrEqual(2048);

    // In this order: what it does and the one undo step, the error-shape rule, the modal-UI warning, the gate,
    // then the envelope.
    const order = [
      "Run a raw ExtendScript (ES3) in After Effects as ONE undo step",
      "Error shape:",
      "Modal UI:",
      "Refused unless the operator sets BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS",
      "Returns the envelope { ok, error?: { message, line, bodyLine }, durationMs, value, logs, logsDropped? }",
    ];
    for (const phrase of order) expect(d, phrase).toContain(phrase);
    const at = order.map((p) => d.indexOf(p));
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    // D15: it promises no more than is verified.
    for (const phrase of [
      "opening, creating or closing a project, or importing an .aep", // ES-5: outside the one Ctrl-Z
      "plain text means nothing was sent",
      "a JSON envelope means the script was sent and may have partly run",
      "suppressDialogs (default true) hides only After Effects' script warning and error dialogs", // ES-1
      "the missing-font warning shown when a project is opened may still appear", // ES-1
      "A bare alert, confirm or prompt in your script's own text fails the call", // ES-4, as narrowed (R9)
      "BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1",
      "cc_get_capabilities shows the gate",
      "audit line",
    ]) {
      expect(d, phrase).toContain(phrase);
    }
    expect(d).not.toContain("alert, confirm and prompt fail the call"); // the unqualified claim R9 withdrew

    // The detail lives in the parameters' own texts.
    for (const phrase of [
      BODYLINE_SENTENCE,
      "var only — no let/const, arrow functions, template literals or JSON",
      "wrap it in parentheses", // ES-7
      "opening, creating or closing a project, or importing an .aep, inside the script resets or breaks", // ES-5
      "is refused before it is sent", // ES-3
      // R9: the shims stop only a bare call written in the script's own text.
      "Window.alert, $.global.alert and this.alert",
      "a library loaded with $.evalFile, or a global helper, that calls alert, confirm or prompt",
      "ScriptUI dialogs",
      "file or folder pickers",
      // R12: each shim's own next step.
      "Use __log(msg) instead of alert",
      "for confirm or prompt, pass the answer in args and read it from __args",
    ]) {
      expect(describe("script"), phrase).toContain(phrase);
    }
    expect(describe("suppressDialogs")).toContain("the missing-font warning shown when a project is opened may still appear");
    expect(describe("suppressDialogs")).toContain("not modal UI the script opens itself");
    expect(describe("undoGroupName")).toContain("Edit > Undo <name>");
    expect(describe("timeoutMs")).toContain("After Effects keeps running it, and later After Effects calls wait behind it.");
    for (const name of ["script", "args", "undoGroupName", "suppressDialogs", "timeoutMs"]) {
      expect(describe(name).length, name).toBeLessThanOrEqual(2048);
    }
    await s.close();
  });
});

describe("ae_run_script on ae-host (node:vm standing in for After Effects)", () => {
  /** An ae-host with the events recorded and a version, in a session with the gate open. */
  async function hosted() {
    const host = aeHost();
    host.app.version = "26.5";
    const ev = events(host);
    const s = await session(OPEN, aeRun(host));
    return { host, ev, s };
  }

  it("returns app.version as a plain envelope, with timeoutClass slow and the call's timeoutMs (A2, T6a)", async () => {
    const { s } = await hosted();
    const r = await s.run({ script: "(function(){ return app.version; })()" });
    expect(isError(r)).toBe(false);
    const env = envOf(r);
    expect(Object.keys(env)).toEqual(["ok", "durationMs", "value", "logs"]);
    expect(env).toMatchObject({ ok: true, value: "26.5", logs: [] });
    expect(s.calls[0]!.opts).toEqual({ timeoutClass: "slow", timeoutMs: undefined });
    expect(s.calls[0]!.script).toBe(runRawScript("(function(){ return app.version; })()", { args: "{}", undoGroupName: "Brainferno script", suppressDialogs: true }));
    await s.run({ script: "1", timeoutMs: 1234 });
    expect(s.calls[1]!.opts).toEqual({ timeoutClass: "slow", timeoutMs: 1234 });
    await s.close();
  });

  it("makes two layers in one undo group, suppressing dialogs inside it (A3)", async () => {
    const { host, ev, s } = await hosted();
    const script = 'var c = app.project.itemByID(12);\nc.layers.addSolid([1,0,0], "A");\nc.layers.addText("B");\nc.numLayers';
    const r = await s.run({ script, undoGroupName: "Two layers" });
    expect(envOf(r)).toMatchObject({ ok: true, value: 5 });
    expect(ev).toEqual(["begin:Two layers@0", "sup@0", "unsup:false@2", "end@2"]);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    expect(host.mutations).toEqual(["layers.addSolid", "layers.addText"]);
    await s.close();
  });

  it("closes both groups after a change and a throw, keeping the change for one Ctrl-Z and the caller's bodyLine (A3)", async () => {
    const { host, ev, s } = await hosted();
    const script = 'var c = app.project.itemByID(12);\nc.layers.addSolid([1,0,0], "A");\nnull.boom;\n1';
    const r = await s.run({ script });
    expect(isError(r)).toBe(true);
    const env = envOf(r);
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({ line: 3, bodyLine: 3 });
    expect(ev).toEqual(["begin:Brainferno script@0", "sup@0", "unsup:false@1", "end@1"]);
    expect(host.mutations).toEqual(["layers.addSolid"]);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    await s.close();
  });

  it("opens and closes exactly one group for a read-only script (A3)", async () => {
    const { host, ev, s } = await hosted();
    expect(envOf(await s.run({ script: "app.project.numItems" }))).toMatchObject({ ok: true, value: 1 });
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    expect(ev.filter((e) => e.startsWith("begin"))).toHaveLength(1);
    expect(ev.filter((e) => e.startsWith("end"))).toHaveLength(1);
    await s.close();
  });

  it("T1 (1): a throw in the wrapper outside its own try still ends suppression and closes the group", async () => {
    // A throwing getter in the result stands in for anything that throws in the wrapper outside its try.
    const { host, ev, s } = await hosted();
    const r = await s.run({ script: '({ get a() { throw new Error("g"); } })' });
    expect(ev).toEqual(["begin:Brainferno script@0", "sup@0", "unsup:false@0", "end@0"]);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    expect(isError(r)).toBe(true);
    expect(envOf(r)).toMatchObject({ ok: false, value: null, logs: [], error: { message: "g — the script was sent; it may have partly run", line: null, bodyLine: null } });
    await s.close();
  });

  it("T1 (2): a failing endSuppressDialogs is added to the envelope; the group still closes, value and logs are kept", async () => {
    const { host, ev, s } = await hosted();
    host.app.endSuppressDialogs = () => {
      ev.push("unsup!");
      throw new host.VmError("Dialog state lost");
    };
    const r = await s.run({ script: '__log("k");\n5' });
    expect(ev).toEqual(["begin:Brainferno script@0", "sup@0", "unsup!", "end@0"]);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    expect(envOf(r)).toEqual({
      ok: false,
      error: { message: CLOSED_NOTE("app.endSuppressDialogs(false)", "Dialog state lost"), line: null, bodyLine: null },
      durationMs: expect.any(Number),
      value: 5,
      logs: ["k"],
    });
    await s.close();
  });

  it("T1 (3): a failing beginSuppressDialogs still closes the group, and never ends a suppression it did not begin", async () => {
    const { host, ev, s } = await hosted();
    host.app.beginSuppressDialogs = () => {
      ev.push("sup!");
      throw new host.VmError("Suppress failed");
    };
    const r = await s.run({ script: "1" });
    expect(ev).toEqual(["begin:Brainferno script@0", "sup!", "end@0"]);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    expect(envOf(r)).toMatchObject({ ok: false, value: null, logs: [], error: { message: "Suppress failed — the script was sent; it may have partly run", line: null, bodyLine: null } });
    await s.close();
  });

  it("K2a: a failing beginUndoGroup runs nothing else: no suppression, no script, no endUndoGroup", async () => {
    // beginUndoGroup sits before __undo's try: inside it, the end call would run and close a group never opened.
    const { host, ev, s } = await hosted();
    host.app.beginUndoGroup = () => {
      ev.push("begin!");
      throw new host.VmError("Undo failed");
    };
    const r = await s.run({ script: 'var c = app.project.itemByID(12);\nc.layers.addSolid([1,0,0], "A");\n1' });
    expect(ev).toEqual(["begin!"]);
    expect(host.mutations).toEqual([]);
    expect(host.undo).toEqual({ begin: 0, end: 0 });
    expect(isError(r)).toBe(true);
    expect(envOf(r)).toMatchObject({ ok: false, value: null, logs: [], error: { message: `Undo failed${SENT}`, line: null, bodyLine: null } });
    await s.close();
  });

  it("R10: an end call that fails after the call itself threw is added to that error, not lost", async () => {
    const getter = '({ get a() { throw new Error("g"); } })'; // the wrapper throws outside its own try (T1 (1))
    /** The recorded end call (still counted, so the group closes), then a throw. */
    const failing = (host: AeHost, which: "endSuppressDialogs" | "endUndoGroup", ev: string[], msg: string) => {
      const inner = host.app[which];
      host.app[which] = (...a: unknown[]) => {
        inner.apply(host.app, a);
        ev.push(`${which} threw`);
        throw new host.VmError(msg);
      };
    };

    // The suppress block: the wrapper threw, then ending the suppression failed.
    const a = await hosted();
    failing(a.host, "endSuppressDialogs", a.ev, "Dialog state lost");
    const ra = envOf(await a.s.run({ script: getter }));
    expect(ra).toMatchObject({ ok: false, value: null, logs: [] });
    expect(ra.error).toEqual({ message: `g ${THROWN_NOTE("app.endSuppressDialogs(false)", "Dialog state lost")}${SENT}`, line: null, bodyLine: null });
    expect(a.ev).toEqual(["begin:Brainferno script@0", "sup@0", "unsup:false@0", "endSuppressDialogs threw", "end@0"]);
    expect(a.host.undo).toEqual({ begin: 1, end: 1 });
    await a.s.close();

    // __undo: beginSuppressDialogs threw (the script never ran), then closing the group failed.
    const b = await hosted();
    b.host.app.beginSuppressDialogs = () => {
      throw new b.host.VmError("Suppress failed");
    };
    failing(b.host, "endUndoGroup", b.ev, "Undo group mismatch");
    const rb = envOf(await b.s.run({ script: "1" }));
    expect(rb.error).toEqual({ message: `Suppress failed ${THROWN_NOTE("app.endUndoGroup()", "Undo group mismatch")}${SENT}`, line: null, bodyLine: null });
    expect(b.host.undo).toEqual({ begin: 1, end: 1 });
    await b.s.close();

    // Without suppression: the wrapper threw, then closing the group failed.
    const c = await hosted();
    failing(c.host, "endUndoGroup", c.ev, "Undo group mismatch");
    const rc = envOf(await c.s.run({ script: getter, suppressDialogs: false }));
    expect(rc.error).toEqual({ message: `g ${THROWN_NOTE("app.endUndoGroup()", "Undo group mismatch")}${SENT}`, line: null, bodyLine: null });
    await c.s.close();

    // Both end calls failed after the throw: both notes, in the order they ran.
    const d = await hosted();
    failing(d.host, "endSuppressDialogs", d.ev, "Dialog state lost");
    failing(d.host, "endUndoGroup", d.ev, "Undo group mismatch");
    const rd = envOf(await d.s.run({ script: getter }));
    expect(rd.error.message).toBe(
      `g ${THROWN_NOTE("app.endSuppressDialogs(false)", "Dialog state lost")} ${THROWN_NOTE("app.endUndoGroup()", "Undo group mismatch")}${SENT}`,
    );
    expect(d.host.undo).toEqual({ begin: 1, end: 1 });
    await d.s.close();
  });

  it("R10: a rethrown error keeps its own line when no end call failed, and has none when a note was added", () => {
    // bodyLine stays null either way (dispatchedFailure gives a host error none); this pins what the panel sees.
    const lineOf = (src: string, text: string) => src.split("\n").findIndex((l) => l.includes(text)) + 1;
    const plain = aeHost();
    plain.app.beginSuppressDialogs = () => {
      throw new plain.VmError("Suppress failed");
    };
    const src = runRawScript("1", { args: "{}", undoGroupName: "x", suppressDialogs: true });
    expect(plain.eval(src)).toEqual({ ok: false, error: { message: "Suppress failed", line: lineOf(src, "app.beginSuppressDialogs();") } });

    const noted = aeHost();
    noted.app.beginSuppressDialogs = () => {
      throw new noted.VmError("Suppress failed");
    };
    noted.app.endUndoGroup = () => {
      throw new noted.VmError("Undo group mismatch");
    };
    expect(noted.eval(src)).toEqual({
      ok: false,
      error: { message: `Suppress failed ${THROWN_NOTE("app.endUndoGroup()", "Undo group mismatch")}`, line: null },
    });
  });

  it("R6: an end call that fails after an ok result keeps the value, the 200 kept logs and logsDropped", async () => {
    for (const which of ["endSuppressDialogs", "endUndoGroup"] as const) {
      const { host, s } = await hosted();
      host.app[which] = () => {
        throw new host.VmError("closing failed");
      };
      const env = envOf(await s.run({ script: "for (var i = 0; i < 250; i++) { __log(i); }\n5" }));
      const call = which === "endUndoGroup" ? "app.endUndoGroup()" : "app.endSuppressDialogs(false)";
      expect(env.error, which).toEqual({ message: CLOSED_NOTE(call, "closing failed"), line: null, bodyLine: null });
      expect(env.value, which).toBe(5);
      expect(env.logs, which).toHaveLength(200);
      expect(env.logs[199], which).toBe("199");
      expect(env.logsDropped, which).toBe(50);
      await s.close();
    }
  });

  it("ES-6: a failing endUndoGroup is added to the envelope instead of replacing it", async () => {
    const { host, ev, s } = await hosted();
    host.app.endUndoGroup = () => {
      ev.push("end!");
      throw new host.VmError("Undo group mismatch");
    };
    const r = await s.run({ script: '__log("kept?");\n5' });
    expect(isError(r)).toBe(true);
    expect(envOf(r)).toEqual({
      ok: false,
      error: { message: CLOSED_NOTE("app.endUndoGroup()", "Undo group mismatch"), line: null, bodyLine: null },
      durationMs: expect.any(Number),
      value: 5,
      logs: ["kept?"],
    });
    expect(ev).toEqual(["begin:Brainferno script@0", "sup@0", "unsup:false@0", "end!"]);
    await s.close();
  });

  it("ES-6: after the caller's own error the note is appended, keeping the caller's message first and its bodyLine", async () => {
    const control = await hosted();
    const script = '__log("kept?");\nnull.x';
    const own = envOf(await control.s.run({ script })).error as { message: string; line: number; bodyLine: number };
    expect(own.bodyLine).toBe(2);
    await control.s.close();

    const { host, s } = await hosted();
    host.app.endUndoGroup = () => {
      throw new host.VmError("Undo group mismatch");
    };
    const env = envOf(await s.run({ script }));
    expect(env.error).toEqual({ message: `${own.message} ${CLOSED_NOTE("app.endUndoGroup()", "Undo group mismatch")}`, line: 2, bodyLine: 2 });
    expect(env.logs).toEqual(["kept?"]);

    // Both end calls failing: both notes, in the order they ran (suppression first, then the undo group).
    host.app.endSuppressDialogs = () => {
      throw new host.VmError("Dialog state lost");
    };
    const both = envOf(await s.run({ script }));
    expect(both.error.message).toBe(
      `${own.message} ${CLOSED_NOTE("app.endSuppressDialogs(false)", "Dialog state lost")} ${CLOSED_NOTE("app.endUndoGroup()", "Undo group mismatch")}`,
    );
    expect(both.error.bodyLine).toBe(2);
    await s.close();
  });

  it("ES-4: a bare alert, confirm or prompt fails the call instead of opening a dialog, with no line and its own next step", async () => {
    const { s } = await hosted();
    const alerted = envOf(await s.run({ script: '__log("before");\nalert("done");\n1' }));
    expect(alerted).toMatchObject({ ok: false, error: { message: MODAL.alert, line: null, bodyLine: null }, logs: ["before"] });
    const confirmed = envOf(await s.run({ script: 'confirm("sure?")' }));
    expect(confirmed.error).toEqual({ message: MODAL.confirm, line: null, bodyLine: null });
    // On the script's last line of six: a shim's own line must never be read as the caller's.
    const prompted = envOf(await s.run({ script: 'var a = 1;\nvar b = 2;\nvar c = 3;\nvar d = 4;\nvar e = 5;\nprompt("name?")' }));
    expect(prompted.error).toEqual({ message: MODAL.prompt, line: null, bodyLine: null });
    // A function the script itself declares reaches the shims too: its scope chain runs through them.
    const own = envOf(await s.run({ script: 'function ask() { return confirm("sure?"); }\nask()' }));
    expect(own.error).toEqual({ message: MODAL.confirm, line: null, bodyLine: null });

    // A caller's own catch swallows the shim's throw, and the call goes on with no dialog.
    const caught = envOf(await s.run({ script: 'try { alert("x"); } catch (e) { __log("caught: " + e.message.substring(0, 7)); }\n2' }));
    expect(caught).toMatchObject({ ok: true, value: 2, logs: ["caught: alert()"] });
    await s.close();
  });

  it("R9: the shims stop only a bare call in the script's own text; global code and qualified calls reach the real dialog", async () => {
    // What the script describe warns about, pinned: ae-host gets a global alert, confirm and prompt (standing in for
    // After Effects' own, which would open a modal), $.global, Window, and a helper an earlier call left as a global
    // (the case of a $.evalFile'd library too: both run in global scope).
    const { host, s } = await hosted();
    vm.runInContext(
      [
        "var __opened = [];",
        "function alert(m) { __opened.push('alert:' + m); }",
        "function confirm(m) { __opened.push('confirm:' + m); return true; }",
        "function prompt(m) { __opened.push('prompt:' + m); return 'typed'; }",
        "var $ = { global: this };",
        "var Window = { alert: function (m) { __opened.push('Window.alert:' + m); } };",
        "function helperThatAsks() { alert('from helper'); return confirm('helper sure?'); }",
      ].join("\n"),
      host.ctx,
    );
    const opened = () => vm.runInContext("__opened.join('|')", host.ctx) as string;
    for (const [script, dialog] of [
      ["helperThatAsks()", "alert:from helper|confirm:helper sure?"],
      ['Window.alert("w"); 1', "Window.alert:w"],
      ['$.global.alert("g"); 1', "alert:g"],
      ['this.prompt("t")', "prompt:t"],
    ] as const) {
      vm.runInContext("__opened.length = 0", host.ctx);
      const env = envOf(await s.run({ script }));
      expect(env.ok, script).toBe(true);
      expect(opened(), script).toBe(dialog); // After Effects would have opened a modal here
    }
    // A bare call in the script's own text still meets the shim: the real alert stays untouched.
    vm.runInContext("__opened.length = 0", host.ctx);
    expect(envOf(await s.run({ script: 'alert("own"); 1' })).error).toEqual({ message: MODAL.alert, line: null, bodyLine: null });
    expect(opened()).toBe("");
    await s.close();
  });

  it("A4: bodyLine points into the caller's script, with args present", async () => {
    const { s } = await hosted();
    const at = async (script: string) => envOf(await s.run({ script, args: { n: 1, s: "x" } })).error as { line: number; bodyLine: number };
    expect(await at("var a = __args.n;\nvar b = 2;\nnull.x")).toMatchObject({ line: 3, bodyLine: 3 });
    expect(await at("var a = __args.n;\napp.project.itemByID(999)")).toMatchObject({ line: 2, bodyLine: 2 });
    expect(await at('var a = __args.n;\nvar b = 2;\nthrow new Error("nope")')).toMatchObject({ line: 3, bodyLine: 3 });
    await s.close();
  });

  it("A5: suppressDialogs (default true) suppresses around the script; false leaves the dialog to block", async () => {
    const host = aeHost();
    let suppressed = false;
    const ends: unknown[][] = [];
    host.app.beginSuppressDialogs = () => {
      suppressed = true;
    };
    host.app.endSuppressDialogs = (...a: unknown[]) => {
      ends.push(a);
      suppressed = false;
    };
    host.app.open = () => {
      if (!suppressed) throw new host.VmError("MODAL");
      return {};
    };
    const s = await session(OPEN, aeRun(host));
    expect(envOf(await s.run({ script: "app.open();\n1" }))).toMatchObject({ ok: true, value: 1 });
    expect(ends).toEqual([[false]]);

    const off = envOf(await s.run({ script: "app.open();\n1", suppressDialogs: false }));
    expect(off).toMatchObject({ ok: false, error: { message: "MODAL", line: 1, bodyLine: 1 } });
    expect(s.calls[1]!.script).not.toContain("SuppressDialogs");
    expect(ends).toHaveLength(1);
    await s.close();
  });

  it("ES-7: a bare object literal on the last line is a block; a parenthesized one is the result", async () => {
    const { s } = await hosted();
    expect(envOf(await s.run({ script: "var n = 3;\n{ count: n }" }))).toMatchObject({ ok: true, value: 3 });
    expect(envOf(await s.run({ script: "var n = 3;\n({ count: n, more: 1 })" }))).toMatchObject({ ok: true, value: { count: 3, more: 1 } });
    await s.close();
  });

  it("__args: round-trips plain data, defaults to {}, keeps the AE helpers out of scope and leaves no global", async () => {
    const { host, s } = await hosted();
    // Escapes, so this source stays free of a raw U+2028 (a line terminator in source) and of raw non-ASCII.
    const args = { n: 41, s: 'q"\\\u2028\u00e9', a: [1, -0, 1e21, 5e-324, 0.1 + 0.2, true, null], o: { default: 1, "": 2, constructor: 3 } };
    const back = envOf(await s.run({ script: "__args", args }));
    // -0 comes back as 0: host.jsx's serializer writes String(-0). 0.1 + 0.2 keeps all 17 digits (R7).
    expect(back).toMatchObject({ ok: true, value: { ...args, a: [1, 0, 1e21, 5e-324, 0.30000000000000004, true, null] } });
    expect(envOf(await s.run({ script: "__args.a[4] === 0.1 + 0.2", args })).value).toBe(true);
    expect(envOf(await s.run({ script: "__args.n + 1", args: { n: 41 } })).value).toBe(42);
    const dflt = envOf(await s.run({ script: 'var k, n = 0; for (k in __args) { n++; } typeof __args + ":" + n' }));
    expect(dflt.value).toBe("object:0");
    expect(envOf(await s.run({ script: "[typeof __comp, typeof __q, typeof __undo, typeof __closed, typeof alert]" })).value).toEqual([
      "undefined",
      "undefined",
      "function",
      "function",
      "function",
    ]);
    await s.close();
  });

  it("leaves no global behind: every name the builder declares stays inside its IIFE (R3)", async () => {
    // Every name declared in the builder's own text (the X-01 wrapper's are its own concern), read from the text so
    // a name added later is checked too. A leaked shim would replace After Effects' own alert for every later script.
    const declared = (built: string): string[] => {
      const own = built.replace(rawScriptWrapper("1"), "");
      const names = new Set<string>();
      for (const m of own.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
      for (const m of own.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
      for (const m of own.matchAll(/\bvar\s+([^;]+);/g)) {
        for (const part of m[1]!.split(",")) {
          const id = /^\s*([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(part);
          if (id) names.add(id[1]!);
        }
      }
      return [...names];
    };
    const on = declared(runRawScript("1", { args: "{}", undoGroupName: "x", suppressDialogs: true }));
    const off = declared(runRawScript("1", { args: "{}", undoGroupName: "x", suppressDialogs: false }));
    expect(on).toEqual(expect.arrayContaining(["__args", "__modal", "__closed", "__undo", "__r", "alert", "confirm", "prompt"]));
    expect(on).toEqual(expect.arrayContaining(off));

    const { host, s } = await hosted();
    // ae-host has no alert, confirm or prompt of its own, so "undefined" is each name's baseline.
    for (const n of on) expect(vm.runInContext(`typeof ${n}`, host.ctx), `${n} before`).toBe("undefined");
    // And no global at all appears, declared or not (an assignment to an undeclared name creates one). __aeSrc is
    // ae-host's own: how it hands the script to the panel's __acmEval.
    const globals = () =>
      (vm.runInContext("Object.getOwnPropertyNames(this).join(',')", host.ctx) as string)
        .split(",")
        .filter((n) => n !== "__aeSrc")
        .sort();
    const before = globals();
    // An ok run, a shim, a throw out of the wrapper, and both end calls failing: every path through the builder.
    await s.run({ script: "__args" });
    await s.run({ script: 'alert("x")' });
    await s.run({ script: 'confirm("x")', suppressDialogs: false });
    await s.run({ script: '({ get a() { throw new Error("g"); } })' });
    host.app.endSuppressDialogs = () => {
      throw new host.VmError("end failed");
    };
    host.app.endUndoGroup = () => {
      throw new host.VmError("end failed");
    };
    await s.run({ script: "1" });
    await s.run({ script: '({ get a() { throw new Error("g"); } })' });
    for (const n of on) expect(vm.runInContext(`typeof ${n}`, host.ctx), n).toBe("undefined");
    expect(globals()).toEqual(before);
    await s.close();
  });
});
