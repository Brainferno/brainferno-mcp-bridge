import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitRequestSchema, type ClientCapabilities, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
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
import { startHttpServer } from "../src/http.js";
import { log } from "../src/logging.js";
import {
  PROJECT_INFO,
  RUN_SCRIPT_CONSENT_TIMEOUT_MS,
  RUN_SCRIPT_DESCRIPTION,
  RUN_SCRIPT_MANAGED_REFUSAL,
  aeArgsLiteral,
  evalSwitchRefusal,
  locateAeError,
  projectState,
  projectSwitchCalls,
  registerAfterEffectsTools,
  runRawScript,
  switchAskFailed,
  switchDeclined,
  switchQuestion,
  switchUnasked,
  type AfterEffectsToolOptions,
} from "../src/tools/after-effects.js";
import { currentToolCall, type ToolCall } from "../src/tools/call-context.js";
import { setRedactionSecrets } from "../src/tools/echo.js";
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

/** How the test client answers elicitation/create (AE-01 consent). */
type Answer = (params: ElicitRequest["params"]) => ElicitResult | Promise<ElicitResult>;
interface SessionOptions {
  sessionId?: string;
  /** The client's elicitation capability, e.g. { form: {} }; the client advertises none when absent. */
  elicitation?: ClientCapabilities["elicitation"];
  /** The client's answer to a question; registered only together with `elicitation` (the SDK requires both). */
  answer?: Answer;
}

async function session(gate: Gate, evaluate: Evaluate = () => null, opts: SessionOptions = {}) {
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
  const client = new Client({ name: "ae01", version: "0" }, opts.elicitation ? { capabilities: { elicitation: opts.elicitation } } : undefined);
  const asked: ElicitRequest["params"][] = [];
  const answer = opts.answer;
  if (opts.elicitation && answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return answer(req.params);
    });
  }
  await Promise.all([client.connect(ct), server.connect(st)]);
  // The server receiving the client's notifications/cancelled. The SDK aborts the tool call's signal in a microtask it
  // queues while delivering that message (InMemoryTransport delivers synchronously), so the abort has run by the time
  // a later task starts: T14 and T14b order on this, not on timers.
  let cancelSeen = () => {};
  const cancelled = new Promise<void>((resolve) => (cancelSeen = resolve));
  const deliver = st.onmessage;
  st.onmessage = (message, extra) => {
    deliver?.(message, extra);
    if ("method" in message && message.method === "notifications/cancelled") cancelSeen();
  };
  return {
    calls,
    /** Every question the client was asked (elicitation/create params), in order. */
    asked,
    /** Resolves once the server has received a notifications/cancelled from the client. */
    cancelled,
    mcp: server,
    client,
    run: (args: Record<string, unknown>, options?: RequestOptions) => client.callTool({ name: "ae_run_script", arguments: args }, undefined, options),
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

  /** The audit line's ` sha256=… len=… ` for a payload, as auditRawCall writes it. */
  const signed = (payload: string) => ` sha256=${createHash("sha256").update(payload).digest("hex").slice(0, 12)} len=${payload.length} `;
  const FALLBACK_PAYLOAD = (script: string) => JSON.stringify({ script, args: "[args could not be serialized: nested too deeply]" });

  it("args that JSON.stringify throws on: the gate still wins, one audit line of the fallback, refused at level 32 (T2, F1)", async () => {
    // A cycle makes JSON.stringify throw a TypeError on every engine. No wire delivers one, but the in-memory transport
    // passes the arguments by reference and z.record(z.unknown()) checks only the top level, so the handler gets it.
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const args = { a: cycle };
    expect(() => JSON.stringify(args)).toThrow(TypeError); // precondition: else the audit payload is not the fallback
    const script = "1";
    const fallback = FALLBACK_PAYLOAD(script);

    const closed = await session(CLOSED);
    const r = await closed.run({ script, args });
    expect(textOf(r)).toBe(rawScriptsDisabledMessage("after_effects", []));
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    expect(auditLines()[0]).toContain(signed(fallback));
    expect(closed.calls).toEqual([]);
    await closed.close();

    audit.mockClear();
    const open = await session(OPEN);
    const r2 = await open.run({ script, args });
    expect(isError(r2)).toBe(true);
    // The encoder's own refusal at level 32 (a cycle is nested without end), which also shows the cycle arrived.
    expect(textOf(r2)).toBe(`args.a${".self".repeat(31)} is nested more than 32 levels deep — flatten args.`);
    expect(textOf(r2)).toBe((aeArgsLiteral(args) as { refusal: string }).refusal);
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    expect(auditLines()[0]).toContain(signed(fallback));
    expect(open.calls).toEqual([]);
    await open.close();
  });

  it("args 100,000 levels deep: one audit line, refused at level 32, nothing sent, on every engine (T2, F1)", async () => {
    // Before V8 13.8 (Node 24 and older) JSON.stringify overflows its stack on this, so the audit payload is the
    // fallback; from 13.8 on its fast path is iterative and serializes it, so the payload is the real JSON.
    const N = 100_000;
    const args = JSON.parse(`{"a":${"[".repeat(N)}${"]".repeat(N)}}`) as Record<string, unknown>;
    const script = "1";
    const payloads = [signed(`{"script":"1","args":{"a":${"[".repeat(N)}${"]".repeat(N)}}}`), signed(FALLBACK_PAYLOAD(script))];

    const closed = await session(CLOSED);
    const r = await closed.run({ script, args });
    expect(textOf(r)).toBe(rawScriptsDisabledMessage("after_effects", []));
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    expect(payloads.filter((p) => auditLines()[0]!.includes(p))).toHaveLength(1);
    expect(closed.calls).toEqual([]);
    await closed.close();

    audit.mockClear();
    const open = await session(OPEN);
    const r2 = await open.run({ script, args });
    expect(isError(r2)).toBe(true);
    expect(textOf(r2)).toBe(`args.a${"[0]".repeat(31)} is nested more than 32 levels deep — flatten args.`);
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    expect(payloads.filter((p) => auditLines()[0]!.includes(p))).toHaveLength(1);
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

    // The gate is checked first: with the gate closed, a script that names a managed call gets the gate text.
    audit.mockClear();
    const closed = await session(CLOSED);
    const gated = await closed.run({ script: 'app.beginUndoGroup("x"); 1' });
    expect(textOf(gated)).toBe(rawScriptsDisabledMessage("after_effects", []));
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE)]);
    expect(closed.calls).toEqual([]);
    await closed.close();
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
    expect(Object.keys(props).sort()).toEqual(["allowProjectSwitch", "args", "script", "suppressDialogs", "timeoutMs", "undoGroupName"]);
    for (const [name, p] of Object.entries(props)) expect(p.description ?? "", name).not.toBe("");
    for (const name of ["undoGroupName", "suppressDialogs", "args", "allowProjectSwitch"]) expect(props[name]!.description, name).toMatch(/[Dd]efaults to/);
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

    // The auto-save hazard the live run found (AE-01 probe 10), scoped to app.open (the call it was seen with), and
    // the operator's OK it now needs (AE-01 consent): safety text, in its own project-switch part, ending well before
    // the cut, whatever follows it.
    const autoSave = "app.open was seen to save the open project's unsaved changes over its file without asking.";
    const consent = "needs the operator's OK: the tool asks them, or see allowProjectSwitch.";

    // In this order: what it does and the one undo step, the error-shape rule, the modal-UI warning, the project
    // switch with the auto-save hazard and the operator's OK, the gate, then the envelope.
    const order = [
      "Run a raw ExtendScript (ES3) in After Effects as ONE undo step",
      "Error shape:",
      "Modal UI:",
      "Project switch:",
      autoSave,
      consent,
      "Refused unless the operator sets BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS",
      "Returns the envelope { ok, error?: { message, line, bodyLine }, durationMs, value, logs, logsDropped? }",
    ];
    for (const phrase of order) expect(d, phrase).toContain(phrase);
    const at = order.map((p) => d.indexOf(p));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(d.indexOf(autoSave) + autoSave.length).toBeLessThanOrEqual(2048);
    expect(d.indexOf(consent) + consent.length).toBeLessThanOrEqual(2048);

    // D15: it promises no more than is verified. The dialog scope is what suppression hid live on After Effects
    // 26.5 (probes 8 and 9), named as examples, never as every dialog.
    for (const phrase of [
      "opening, creating or closing a project, or importing an .aep", // ES-5: outside the one Ctrl-Z
      "plain text means your script was not sent",
      "a project switch not approved", // AE-01 consent: a plain-text cause
      "a JSON envelope means the script was sent and may have partly run",
      "suppressDialogs (default true) hides After Effects' own warning dialogs, such as an export warning or the " +
        "missing-font dialog when the script opens a project.", // ES-1, widened by the live run
      "A bare alert, confirm or prompt in your script's own text fails the call", // ES-4, as narrowed (R9)
      "BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1",
      "cc_get_capabilities shows the gate",
      "audit line",
    ]) {
      expect(d, phrase).toContain(phrase);
    }
    expect(d).not.toContain("alert, confirm and prompt fail the call"); // the unqualified claim R9 withdrew
    expect(d).not.toContain("may still appear"); // the open-time missing-font dialog: hidden live (probe 9)
    expect(d).not.toMatch(/every dialog|all dialogs|any dialog/i);

    // The detail lives in the parameters' own texts.
    for (const phrase of [
      BODYLINE_SENTENCE,
      "var only — no let/const, arrow functions, template literals or JSON",
      "wrap it in parentheses", // ES-7
      "opening, creating or closing a project, or importing an .aep, inside the script resets or breaks", // ES-5
      // Ctrl-Z reaches the project only; what reached the disk stays.
      "It covers project edits only: what the script saves or writes (app.project.save, File writes, renders, " +
        "preferences) stays changed.",
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
    // The live run's dialog scope (probes 8, 9) and the auto-save hazard in full, with the way to discard (probe 10).
    for (const phrase of [
      "Verified on an export warning (from a Motion Graphics template export) and on the missing-font dialog when " +
        "the script opens a project; it is not promised for every dialog.",
      "not modal UI the script opens itself",
      // Scoped to app.open, the call probe 10 saw (AE-01 consent, M1).
      "a script that opens another project with app.open while the open one has unsaved changes gets no save " +
        "prompt. After Effects saves the open project over its file, those changes included, then opens the other.",
      "To discard the changes instead, call app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES) before opening the " +
        "other project.",
      // Not a complete guard: the consent applies to such a script either way (M2).
      "Either way, a script whose text names such a call needs the operator's OK first (see allowProjectSwitch).",
    ]) {
      expect(describe("suppressDialogs"), phrase).toContain(phrase);
    }
    expect(describe("suppressDialogs")).not.toContain("may still appear");
    // The number limits After Effects showed (probe 11); ae-host, on V8, is exact and cannot show them.
    for (const phrase of [
      "After Effects reads a number below about 2.2e-308 as 0 (5e-324 arrives as 0)",
      "numbers in the returned value keep 15 significant digits (0.1 + 0.2 arrives exact but comes back as 0.3)",
      // Only a string passed in keeps every digit: live, String(n) and toPrecision(17) in the script kept 15.
      "Pass a value as a string when every digit matters: strings round-trip exactly.",
      "A number the script returns, even via String(n), keeps 15 significant digits.",
    ]) {
      expect(describe("args"), phrase).toContain(phrase);
    }
    expect(describe("args")).not.toContain("both ways"); // a returned number cannot keep every digit as a string
    expect(describe("undoGroupName")).toContain("Edit > Undo <name>");
    expect(describe("timeoutMs")).toContain("After Effects keeps running it, and later After Effects calls wait behind it.");
    expect(describe("timeoutMs")).toContain("durationMs in the result includes that wait."); // moved from the description
    // AE-01 consent: the flag cannot pre-approve, every trigger is named with what was seen and what was not, and the
    // known gaps are stated. The flag is set only after this tool's own plain-text refusal was passed on.
    expect(describe("allowProjectSwitch")).toMatch(
      /^Set true only after this tool refused this script in plain text, you told the operator what that refusal says, and they agreed in the chat that it may close or replace the open project; defaults to false\. /,
    );
    for (const phrase of [
      "this flag does not skip the question",
      "app.open was seen to save the open project's unsaved changes over its file without asking", // probe 10
      "were not tried",
      // Probe 7 saw a close only on a project saved just before: the discard is Adobe's documentation (AE-01 D15).
      "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES) throws them away as Adobe documents it (not verified live)",
      "$.evalFile",
      "with (app)",
      "text passed in args",
      // The scan's gaps, as a short list that says it is not complete (T2 pins each one).
      "does not catch, among others:",
      "(app).open",
      ".call/.apply",
      "a comment or escape inside the call",
      ...["app.open", "app.openFast", "app.newProject", "app.project.close", "app.quit", "app.restart", "CloseOptions"],
    ]) {
      expect(describe("allowProjectSwitch"), phrase).toContain(phrase);
    }
    expect(describe("allowProjectSwitch")).not.toContain("was seen to throw");
    for (const name of ["script", "args", "undoGroupName", "suppressDialogs", "timeoutMs", "allowProjectSwitch"]) {
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
    // A throwing getter in the result stands in for anything that throws in the wrapper outside its try. The trigger
    // works on ae-host (V8) only: ExtendScript has no getter literals (a SyntaxError in the AE-01 live run).
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
    // The wrapper throws outside its own try (T1 (1)). ae-host only: ExtendScript has no getter literals, so R10 has
    // no live trigger and stays unit-tested (AE-01 live run).
    const getter = '({ get a() { throw new Error("g"); } })';
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
    // app.open is a project switch (AE-01 consent): this client cannot be asked, so the operator's OK comes as
    // allowProjectSwitch, and the read-only check (PROJECT_INFO) runs before each script.
    expect(envOf(await s.run({ script: "app.open();\n1", allowProjectSwitch: true }))).toMatchObject({ ok: true, value: 1 });
    expect(ends).toEqual([[false]]);

    const off = envOf(await s.run({ script: "app.open();\n1", suppressDialogs: false, allowProjectSwitch: true }));
    expect(off).toMatchObject({ ok: false, error: { message: "MODAL", line: 1, bodyLine: 1 } });
    expect(s.calls.map((c) => c.script === PROJECT_INFO)).toEqual([true, false, true, false]);
    expect(s.calls[3]!.script).not.toContain("SuppressDialogs");
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
    // -0 comes back as 0: host.jsx's serializer writes String(-0). On ae-host (V8) 5e-324 and 0.1 + 0.2 come back
    // exact, so this pins the literal (R7). After Effects itself reads 5e-324 as 0 and returns 0.1 + 0.2 as 0.3 (15
    // significant digits; AE-01 live probe 11): the args text says so, and no After Effects round trip is claimed.
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

// ---- AE-01 consent: the operator's OK before a script closes or replaces the open project -----------------------

/** Closes, then opens: the spec's fixtures (the pinned texts below are rendered from exactly these). */
const SWITCH = "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);\napp.open(new File(__args.p));\n1";
const MULTI = "var a = 1;\napp.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);\napp.newProject();\napp.open(f);\napp.open(g);\napp.quit()";
const FONTPROJ = { path: "C:\\Projects\\Client X\\fontproj.aep", numItems: 12, dirty: true };
const UNSAVED = { path: null, numItems: 0, dirty: false };

describe("ae_run_script: the project-switch scan (AE-01 consent)", () => {
  it("T1: finds each call that closes or replaces the open project, once, with the line of its first match", () => {
    const one = (call: string) => [{ call, line: 1 }];
    const positive: [string, { call: string; line: number }[]][] = [
      ...[
        "app.open(new File(p))",
        "app.open()",
        "var p = app.open(f);",
        "app . open ( f )",
        "app\n.\nopen\n(f)",
        "x = 1; app.open(f)",
        "$.global.app.open(f)",
        "if(1){app.open(f)}",
        ";app.open(f)",
        "// app.open(f) later", // a comment counts
      ].map((s): [string, { call: string; line: number }[]] => [s, one("app.open")]),
      ['"app.newProject()"', one("app.newProject")], // a string counts
      ["app.newProject()", one("app.newProject")],
      ["app.newProject ()", one("app.newProject")],
      ["app.openFast(f)", one("app.openFast")],
      // CloseOptions folds into app.project.close when that is listed.
      ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", one("app.project.close")],
      ["app . project . close ( 1 )", one("app.project.close")],
      ["app.quit()", one("app.quit")],
      ["app.restart()", one("app.restart")],
      // The honest alias: CloseOptions is the only sign of the close.
      ["var p = app.project; p.close(CloseOptions.SAVE_CHANGES)", one("a close that names CloseOptions")],
      // A quoted name in brackets is not a computed name: any mix of dot and bracket access, whitespace as around a dot.
      ["app['open'](f)", one("app.open")],
      ['app["open"](f)', one("app.open")],
      ["app [ 'open' ] ( f )", one("app.open")],
      ["app\n['open']\n(f)", one("app.open")],
      ["$.global.app['open'](f)", one("app.open")],
      ['app["newProject"]()', one("app.newProject")],
      ["app['openFast'](f)", one("app.openFast")],
      ["app['quit']()", one("app.quit")],
      ["app['restart']()", one("app.restart")],
      ["app['project'].close(1)", one("app.project.close")],
      ['app["project"]["close"](1)', one("app.project.close")],
      ["app.project['close'](1)", one("app.project.close")],
      ["app [ \"project\" ] . close ( 1 )", one("app.project.close")],
      ["app['project']\n.close(CloseOptions.SAVE_CHANGES)", one("app.project.close")],
      [
        SWITCH,
        [
          { call: "app.project.close", line: 1 },
          { call: "app.open", line: 2 },
        ],
      ],
      [
        MULTI,
        [
          { call: "app.project.close", line: 2 },
          { call: "app.newProject", line: 3 },
          { call: "app.open", line: 4 },
          { call: "app.quit", line: 6 },
        ],
      ],
    ];
    for (const [script, calls] of positive) expect(projectSwitchCalls(script), JSON.stringify(script)).toEqual(calls);
  });

  it("T2: matches no other name, case or longer identifier; pins the known gaps as not caught", () => {
    const negative = [
      "File.close()",
      "f.open()",
      "myFile.close()",
      "f.open('r'); f.close();",
      "app.openX(f)",
      "app.openFastX(f)",
      "app.project.closeX(1)",
      "app.project.closeAll()",
      "myapp.open(f)",
      "app2.open(f)",
      "_app.open(f)",
      "$app.open(f)",
      "app.opener(f)",
      "app.newProjects()",
      "app.projectX.close(1)",
      "App.open(f)",
      "app.Open(f)",
      "APP.NEWPROJECT()",
      "app.project.Close(1)",
      "closeOptions",
      "MyCloseOptions",
      "CloseOptionsX",
      "app.open",
      "app.project.file.open('r')",
      "app.project.items.addComp('c', 1, 1, 1, 1, 1)",
      "app.quitX()",
      "app.restarts()",
      "app.purge(PurgeTarget.ALL_CACHES)",
      // Bracket access: only a whole quoted name, in matching quotes, called.
      "app['opener'](f)",
      "app['Open'](f)",
      "app['open\"](f)",
      "app['open']",
      "app['openFastX'](f)",
      "app['project'].closeAll()",
      "app['projectX'].close(1)",
      "app.project['closeX'](1)",
      "myapp['open'](f)",
      "_app['open'](f)",
      "$app['open'](f)",
    ];
    for (const script of negative) expect(projectSwitchCalls(script), script).toEqual([]);
    // Not caught, by design (a guard against honest mistakes, not adversaries): changing one is a deliberate decision.
    // Keyed by each gap exactly as the regex's doc comment names it.
    const notCaught: Record<string, string[]> = {
      'a computed name (app["op" + "en"], app[name])': ['app["op" + "en"](f)', "app[name](f)", "app[open](f)" /* a variable, not a name */],
      "a Unicode escape in a name, dotted or quoted": ["app.\\u006fpen(f)", "app['\\u006fpen'](f)"],
      "an alias of app, app.open or app.project (without CloseOptions)": [
        "var a = app; a.open(f)",
        "var o = app.open; o(f)",
        "var p = app.project; p.close(2)",
      ],
      "(app).open": ["(app).open(f)"],
      ".call/.apply": ["app.open.call(app, f)", "app.open.apply(app, [f])"],
      "a comment inside the call chain": ["app/**/.open(f)", "app.open/*c*/(f)", "app.open//c\n(f)"],
      "with (app) { open(f) }": ["with (app) { open(f) }"],
      "a menu command run by id (app.executeCommand)": ["app.executeCommand(app.findMenuCommandId('Close Project'))"],
      // CS-7: a file, or text passed in args.
      "code the script runs from elsewhere at run time ($.evalFile, eval of a file's text or of text passed in args)": [
        '$.evalFile(new File("~/Scripts/openClientProject.jsx"))',
        'var f = File("~/x.jsx"); f.open("r"); eval(f.read()); f.close()',
        "eval(__args.code)",
      ],
    };
    for (const [gap, scripts] of Object.entries(notCaught)) {
      for (const script of scripts) expect(projectSwitchCalls(script), `${gap}: ${script}`).toEqual([]);
    }
    // The regex's doc comment names every gap pinned here, and pins nothing it does not name (F4/F5).
    const source = readFileSync(new URL("../src/tools/after-effects.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const doc = /\/\*\*\n((?: \* [^\n]*\n)*) \*\/\nconst AE_PROJECT_SWITCH =/.exec(source)?.[1] ?? "";
    const prose = doc
      .split("\n")
      .map((l) => l.replace(/^ \* /, ""))
      .join(" ")
      .trim();
    const named = /Not caught, each pinned in T2: (.*)\.$/.exec(prose)?.[1]?.split("; ");
    expect(named).toEqual(Object.keys(notCaught));
  });
});

/** The panel: PROJECT_INFO (the read-only check) gets `state`; any other script an ok envelope. */
const switchPanel =
  (state: Record<string, unknown> = FONTPROJ): Evaluate =>
  (script) =>
    script === PROJECT_INFO ? ({ ...state, bitsPerChannel: 8, version: "26.5x89" } as JsonValue) : { ok: true, value: 1, logs: [], logsDropped: 0 };
const FORM: ClientCapabilities["elicitation"] = { form: {} };
const YES: Answer = () => ({ action: "accept", content: { allowProjectSwitch: true } });
const answering =
  (result: ElicitResult): Answer =>
  () =>
    result;
/** A promise and its resolve, for a panel that answers only when the test says so. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
/** One task later: every microtask queued so far (the SDK's cancel handling, a dispatch) has run. No timer. */
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
/** The next raw-script audit line: the handler writes exactly one, as it finishes (every path returns right after). */
const nextAudit = (): Promise<string> =>
  new Promise((resolve) => {
    audit.mockImplementation((line: unknown) => {
      if (String(line).startsWith("raw-script ")) resolve(String(line));
    });
  });
/** An audit line of ae_run_script from stdio, ending with `tail`. */
const LINE = (tail: string) => new RegExp(`^raw-script tool=ae_run_script app=after_effects sha256=[0-9a-f]{12} len=\\d+ via=stdio ${tail}$`);
const scriptsSent = (s: { calls: Call[] }) => s.calls.map((c) => c.script);
const messageOf = (params: ElicitRequest["params"] | undefined) => (params as { message: string }).message;

// The texts, pinned whole for one representative case each (spec section 5), rendered for the fixtures above.
const NO_DETOUR = "Do not run this script, or its project switch, through cc_eval_script or another tool.";
const REMOTE_QUESTION_LINE = "This is a shared (remote) session: the person at After Effects is not asked; you are answering for them.";
const REMOTE_MODEL_LINE =
  "This is a shared (remote) session: the person you ask in the chat answers for whoever is at After Effects, who is not asked — say so when you ask.";
/**
 * What a close does with unsaved changes. None of it was verified live (AE-01 D15): DO_NOT_SAVE_CHANGES and SAVE_CHANGES
 * as Adobe documents them; PROMPT_TO_SAVE_CHANGES's own save prompt possible. (Probe 7 closed with DO_NOT_SAVE_CHANGES
 * under suppression and saw no dialog, but on a project saved just before: it shows nothing about unsaved changes.)
 * Whatever suppressDialogs is (CS-2, H1).
 */
const CLOSE_CLAUSE =
  "CloseOptions.DO_NOT_SAVE_CHANGES throws unsaved changes away and CloseOptions.SAVE_CHANGES saves them over the file (both as " +
  "Adobe documents it; not verified live). CloseOptions.PROMPT_TO_SAVE_CHANGES may show After Effects' own save prompt, which " +
  "blocks After Effects until someone answers it there (not verified live).";
/** The same for a project with no file: no SAVE_CHANGES part. */
const CLOSE_CLAUSE_NO_FILE =
  "CloseOptions.DO_NOT_SAVE_CHANGES throws unsaved changes away (as Adobe documents it; not verified live). " +
  "CloseOptions.PROMPT_TO_SAVE_CHANGES may show After Effects' own save prompt, which blocks After Effects until someone " +
  "answers it there (not verified live).";
/** SWITCH on FONTPROJ, suppressDialogs on, a local session (5.1). */
const QUESTION_SWITCH =
  "ae_run_script wants to run an After Effects script that closes or replaces the open project: it calls app.project.close (line 1), app.open (line 2).\n" +
  "The open project is fontproj.aep (C:\\Projects\\Client X\\fontproj.aep), 12 items; it has unsaved changes right now.\n" +
  "With suppressDialogs on, After Effects does not ask: in a live test, app.open saved the open project's unsaved changes over its file. " +
  "CloseOptions.DO_NOT_SAVE_CHANGES throws unsaved changes away and CloseOptions.SAVE_CHANGES saves them over the file (both as " +
  "Adobe documents it; not verified live). CloseOptions.PROMPT_TO_SAVE_CHANGES may show After Effects' own save prompt, which " +
  "blocks After Effects until someone answers it there (not verified live).\n" +
  // The read-only check was already sent: only the caller's script waits for the yes. The operator did not write the
  // script, so the question never calls it theirs (F3/F7).
  'The script is not sent to After Effects unless you set "Run the script" to yes and submit.';
const SWITCH_SCHEMA = {
  type: "object",
  properties: {
    allowProjectSwitch: {
      type: "boolean",
      title: "Run the script",
      description: "Yes lets it close or replace the open project. No (the default) stops it: the script is not sent to After Effects.",
      default: false,
    },
  },
  required: ["allowProjectSwitch"],
};
/** The fallback when the client cannot ask (5.2), SWITCH on FONTPROJ, on, local. */
const UNASKED_SWITCH =
  "ae_run_script did not send this script: it calls app.project.close (line 1), app.open (line 2), which close or replace the open " +
  "After Effects project, and this MCP client cannot ask the operator itself — tell the operator what follows, ask in the chat " +
  "whether the script may do this, and call ae_run_script again with the same script and allowProjectSwitch: true only if they " +
  "agree; to keep the open project, remove those calls instead. The open project is fontproj.aep (C:\\Projects\\Client X\\fontproj.aep), " +
  "12 items; it has unsaved changes right now. With suppressDialogs on, After Effects does not ask: in a live test, app.open saved " +
  "the open project's unsaved changes over its file. CloseOptions.DO_NOT_SAVE_CHANGES throws unsaved changes away and " +
  "CloseOptions.SAVE_CHANGES saves them over the file (both as Adobe documents it; not verified live). " +
  "CloseOptions.PROMPT_TO_SAVE_CHANGES may show After Effects' own save prompt, which blocks After Effects until someone answers it " +
  "there (not verified live). Do not run this script, or its project switch, through cc_eval_script or another tool.";
/** The operator said no (5.3). */
const DECLINED =
  "Asked whether this script may close or replace the open After Effects project, the operator declined — the script was not sent " +
  "(only a read-only check of the open project ran). Ask the operator in the chat what they want; call ae_run_script again only if " +
  "they ask for it (they will be asked again), or remove the calls that close or replace the project. Do not run this script, or " +
  "its project switch, through cc_eval_script or another tool.";
/** The operator dismissed the question, or the client could not show it (5.3, F4). */
const DISMISSED =
  "Asked whether this script may close or replace the open After Effects project, the operator dismissed the question without " +
  "answering — the script was not sent (only a read-only check of the open project ran). Ask the operator in the chat what they " +
  "want; call ae_run_script again only if they ask for it (they will be asked again), or remove the calls that close or replace the " +
  "project. Do not run this script, or its project switch, through cc_eval_script or another tool. If no question appeared in the " +
  "client, it cannot show one here: ask the operator to open, create or close the project in After Effects themselves.";
/** The operator submitted without a yes: false, no content, or the field left out (5.3, F3). */
const UNSET =
  "Asked whether this script may close or replace the open After Effects project, the operator submitted without setting \"Run the " +
  'script" to yes — the script was not sent (only a read-only check of the open project ran). Ask the operator in the chat what ' +
  "they want; call ae_run_script again only if they ask for it (they will be asked again), or remove the calls that close or " +
  "replace the project. Do not run this script, or its project switch, through cc_eval_script or another tool.";
/** Asking failed (5.4); the reason varies. */
const ASK_FAILED = (reason: string) =>
  `Could not ask the operator whether this script may close or replace the open After Effects project (${reason}) — the script ` +
  "was not sent (only a read-only check of the open project ran). Ask the operator in the chat; if they agree, call ae_run_script " +
  "again and the question is shown again. If this client cannot show it, ask the operator to open, create or close the project " +
  "in After Effects themselves. Do not run this script, or its project switch, through cc_eval_script or another tool.";
/** The SDK 1.30.0 (Ajv) message for an accept whose content leaves the required field out (pinned: F3, T6b). */
const SDK_MISSING_FIELD =
  "MCP error -32602: Elicitation response content does not match requested schema: data must have required property 'allowProjectSwitch'";

describe("ae_run_script: the operator's OK before a project switch (AE-01 consent)", () => {
  it("T3: a script that names no switch call is never checked or asked about, flag or not", async () => {
    const s = await session(OPEN, switchPanel(), { elicitation: FORM, answer: YES });
    const r = await s.run({ script: "app.project.numItems", allowProjectSwitch: true });
    expect(isError(r)).toBe(false);
    expect(envOf(r)).toMatchObject({ ok: true, value: 1 });
    expect(s.calls.map((c) => [c.script, c.opts])).toEqual([
      [runRawScript("app.project.numItems", { args: "{}", undoGroupName: "Brainferno script", suppressDialogs: true }), { timeoutClass: "slow", timeoutMs: undefined }],
    ]);
    expect(s.asked).toEqual([]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run"))]);
    await s.close();
  });

  it("T4: accept + true: reads the project (fast), asks once with the risk, then runs the script (slow)", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer: YES });
    const args = { p: "C:\\Projects\\other.aep" };
    const r = await s.run({ script: SWITCH, args });
    expect(isError(r)).toBe(false);
    expect(envOf(r)).toMatchObject({ ok: true, value: 1 });
    expect(s.asked).toEqual([{ mode: "form", message: QUESTION_SWITCH, requestedSchema: SWITCH_SCHEMA }]);
    expect(messageOf(s.asked[0])).not.toContain("shared (remote) session");
    // The question and its field speak to the operator, who did not write the script (F3/F7).
    expect(JSON.stringify(s.asked[0])).not.toMatch(/\byour script\b/i);
    const literal = (aeArgsLiteral(args) as { literal: string }).literal;
    expect(s.calls.map((c) => [c.script, c.opts])).toEqual([
      [PROJECT_INFO, { timeoutClass: "fast" }],
      [runRawScript(SWITCH, { args: literal, undoGroupName: "Brainferno script", suppressDialogs: true }), { timeoutClass: "slow", timeoutMs: undefined }],
    ]);
    // The check runs in the tool-call context too, which never holds ae_run_script's arguments.
    expect(s.calls[0]!.ctx).toEqual({ tool: "ae_run_script", args: undefined });
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run consent=operator"))]);
    await s.close();
  });

  /** A refusal after the question: plain text, only the check reached the panel, one refused audit line (T20). */
  async function refusedAfterAsking(answer: Answer, text: string, consent: string) {
    const s = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer });
    const r = await s.run({ script: SWITCH });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toBe(text);
    expect(() => JSON.parse(textOf(r))).toThrow();
    expect(s.asked).toHaveLength(1);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE(`outcome=refused consent=${consent}`))]);
    await s.close();
    return s;
  }

  it("T5: accept + false is a refusal: submitted without yes", async () => {
    await refusedAfterAsking(answering({ action: "accept", content: { allowProjectSwitch: false } }), UNSET, "declined");
  });

  it("T6: accept with no content is a refusal: submitted without yes", async () => {
    await refusedAfterAsking(answering({ action: "accept" }), UNSET, "declined");
  });

  it("T6b: accept with the field left out (the SDK rejects it) is the same refusal; the SDK's message is pinned (F3)", async () => {
    for (const content of [{}, { other: 1 }] as Record<string, number>[]) {
      audit.mockClear();
      const s = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer: answering({ action: "accept", content }) });
      const original = s.mcp.server.elicitInput.bind(s.mcp.server);
      const rejections: string[] = [];
      vi.spyOn(s.mcp.server, "elicitInput").mockImplementation(async (params, options) => {
        try {
          return await original(params, options);
        } catch (error) {
          rejections.push((error as Error).message);
          throw error;
        }
      });
      const r = await s.run({ script: SWITCH });
      expect(textOf(r), JSON.stringify(content)).toBe(UNSET);
      expect(rejections, JSON.stringify(content)).toEqual([SDK_MISSING_FIELD]);
      expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
      expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=declined"))]);
      await s.close();
    }
  });

  it("T7: decline is a refusal that says what to do next and closes the detour", async () => {
    await refusedAfterAsking(answering({ action: "decline" }), DECLINED, "declined");
  });

  it("T8: cancel is a refusal, with the way forward when no question appeared (F4)", async () => {
    await refusedAfterAsking(answering({ action: "cancel" }), DISMISSED, "declined");
  });

  it("T8b: a decline or a cancel is a refusal even when its content says allowProjectSwitch: true (V2)", async () => {
    // The SDK checks content against the schema only on accept, so a client can send this; only accept + true is a yes.
    const content = { allowProjectSwitch: true };
    await refusedAfterAsking(answering({ action: "decline", content }), DECLINED, "declined");
    audit.mockClear();
    await refusedAfterAsking(answering({ action: "cancel", content }), DISMISSED, "declined");
  });

  it("T9: a client handler that throws fails closed", async () => {
    await refusedAfterAsking(
      () => {
        throw new Error("dialog crashed");
      },
      ASK_FAILED("MCP error -32603: dialog crashed"),
      "failed",
    );
  });

  it("T10: a non-boolean answer fails closed with the SDK's own message, not as a decline", async () => {
    await refusedAfterAsking(
      answering({ action: "accept", content: { allowProjectSwitch: "true" } }),
      ASK_FAILED("MCP error -32602: Elicitation response content does not match requested schema: data/allowProjectSwitch must be boolean"),
      "failed",
    );
  });

  it("T11: only a boolean true is a yes, even past the SDK's validation", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer: YES });
    vi.spyOn(s.mcp.server, "elicitInput").mockResolvedValue({ action: "accept", content: { allowProjectSwitch: "yes" } });
    const r = await s.run({ script: SWITCH });
    expect(textOf(r)).toBe(UNSET);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=declined"))]);
    await s.close();
  });

  it("T12: asks on the tool call's own stream, cancelled with it, with 10 minutes to answer", async () => {
    expect(RUN_SCRIPT_CONSENT_TIMEOUT_MS).toBe(600_000);
    const s = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer: YES });
    const spy = vi.spyOn(s.mcp.server, "elicitInput");
    await s.run({ script: SWITCH });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([
      { mode: "form", message: QUESTION_SWITCH, requestedSchema: SWITCH_SCHEMA },
      { relatedRequestId: expect.any(Number), signal: expect.any(AbortSignal), timeout: RUN_SCRIPT_CONSENT_TIMEOUT_MS },
    ]);
    await s.close();
  });

  it("T13: no answer in time fails closed", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer: () => new Promise<ElicitResult>(() => {}) });
    const original = s.mcp.server.elicitInput.bind(s.mcp.server);
    vi.spyOn(s.mcp.server, "elicitInput").mockImplementation((params, options) => original(params, { ...options, timeout: 50 }));
    const r = await s.run({ script: SWITCH });
    expect(textOf(r)).toBe(ASK_FAILED("no answer within 10 minutes"));
    expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=failed"))]);
    await s.close();
  });

  it("T14: the client cancelling the tool call during the question sends nothing and audits once", async () => {
    // The client cancels the tool call once the question has reached it; the test then waits for the handler's one
    // audit line. No timer decides the outcome.
    const ac = new AbortController();
    const s = await session(OPEN, switchPanel(FONTPROJ), {
      elicitation: FORM,
      answer: () => {
        ac.abort("the operator pressed Esc");
        return new Promise<ElicitResult>(() => {});
      },
    });
    const audited = nextAudit();
    await expect(s.run({ script: SWITCH }, { signal: ac.signal })).rejects.toThrow();
    await audited;
    await nextTask(); // anything the handler would still send has reached the panel
    expect(s.asked).toHaveLength(1);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=failed"))]);
    await s.close();
  });

  it("T14b: the client cancelling during the read-only check sends nothing, flag or question (F2)", async () => {
    for (const opts of [{}, { elicitation: FORM, answer: YES }] as SessionOptions[]) {
      audit.mockClear();
      // The panel holds the check's answer until the cancellation has reached the server; no timer decides the order.
      const reached = deferred<void>();
      const held = deferred<JsonValue>();
      const panel: Evaluate = (script) => {
        if (script !== PROJECT_INFO) return { ok: true, value: 1, logs: [], logsDropped: 0 };
        reached.resolve();
        return held.promise;
      };
      const s = await session(OPEN, panel, opts);
      const audited = nextAudit();
      const ac = new AbortController();
      const call = s.run({ script: SWITCH, allowProjectSwitch: true }, { signal: ac.signal });
      await reached.promise; // the read-only check is at the panel
      ac.abort("the operator pressed Esc");
      await expect(call).rejects.toThrow();
      await s.cancelled; // the server has the client's notifications/cancelled...
      await nextTask(); // ...and has aborted the tool call's signal
      held.resolve({ ...FONTPROJ, bitsPerChannel: 8, version: "26.5x89" }); // only now does the check answer
      await audited;
      await nextTask(); // anything the handler would still send has reached the panel
      expect(scriptsSent(s), JSON.stringify(opts)).toEqual([PROJECT_INFO]);
      expect(s.asked).toEqual([]);
      expect(auditLines(), JSON.stringify(opts)).toEqual([expect.stringMatching(LINE("outcome=refused consent=failed"))]);
      await s.close();
    }
  });

  it("T15: a client that cannot ask gets the plain-text refusal naming the risk, and is never asked", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ));
    const spy = vi.spyOn(s.mcp.server, "elicitInput");
    const r = await s.run({ script: SWITCH });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toBe(UNASKED_SWITCH);
    expect(textOf(r)).not.toContain("shared (remote) session");
    expect(spy).not.toHaveBeenCalled();
    expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=needed"))]);
    await s.close();
  });

  it("T16: a client that cannot ask, with allowProjectSwitch: true, runs the script", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ));
    const spy = vi.spyOn(s.mcp.server, "elicitInput");
    const r = await s.run({ script: SWITCH, allowProjectSwitch: true });
    expect(isError(r)).toBe(false);
    expect(envOf(r)).toMatchObject({ ok: true, value: 1 });
    expect(spy).not.toHaveBeenCalled();
    expect(s.calls.map((c) => [c.script === PROJECT_INFO, c.opts?.timeoutClass])).toEqual([
      [true, "fast"],
      [false, "slow"],
    ]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run consent=flag"))]);
    await s.close();
  });

  it("T17: a client that can ask is always asked: allowProjectSwitch does not skip the question", async () => {
    const declined = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer: answering({ action: "decline" }) });
    const r = await declined.run({ script: SWITCH, allowProjectSwitch: true });
    expect(declined.asked).toHaveLength(1);
    expect(textOf(r)).toBe(DECLINED);
    expect(scriptsSent(declined)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=declined"))]);
    await declined.close();

    audit.mockClear();
    const approved = await session(OPEN, switchPanel(FONTPROJ), { elicitation: FORM, answer: YES });
    expect(isError(await approved.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(false);
    expect(approved.asked).toHaveLength(1);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run consent=operator"))]);
    await approved.close();
  });

  it("T18: only form elicitation counts as able to ask; a bare elicitation: {} does", async () => {
    const urlOnly = await session(OPEN, switchPanel(FONTPROJ), { elicitation: { url: {} }, answer: YES });
    expect(textOf(await urlOnly.run({ script: SWITCH }))).toBe(UNASKED_SWITCH);
    expect(urlOnly.asked).toEqual([]);
    expect(isError(await urlOnly.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(false);
    expect(urlOnly.asked).toEqual([]);
    expect(auditLines()).toEqual([
      expect.stringMatching(LINE("outcome=refused consent=needed")),
      expect.stringMatching(LINE("outcome=run consent=flag")),
    ]);
    await urlOnly.close();

    audit.mockClear();
    const bare = await session(OPEN, switchPanel(FONTPROJ), { elicitation: {}, answer: YES });
    expect(isError(await bare.run({ script: SWITCH }))).toBe(false);
    expect(bare.asked).toHaveLength(1);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run consent=operator"))]);
    await bare.close();
  });

  it("T19: the read-only check (PROJECT_INFO) only reads: no set, define, delete or call, no mutation, no undo group", () => {
    const host = aeHost();
    host.app.version = "26.5";
    const seen: string[] = [];
    const record = (target: object, path: string): object =>
      new Proxy(target, {
        get(t, k, r) {
          const v: unknown = Reflect.get(t, k, r);
          seen.push(`get ${path}.${String(k)}`);
          if (k === "project" && v !== null && typeof v === "object") return record(v, `${path}.project`);
          if (typeof v !== "function") return v;
          return new Proxy(v, {
            apply(f, _self, a) {
              seen.push(`call ${path}.${String(k)}`);
              return Reflect.apply(f, t, a);
            },
          });
        },
        set(t, k, v, r) {
          seen.push(`SET ${path}.${String(k)}`);
          return Reflect.set(t, k, v, r);
        },
        defineProperty(t, k, d) {
          seen.push(`DEFINE ${path}.${String(k)}`);
          return Reflect.defineProperty(t, k, d);
        },
        deleteProperty(t, k) {
          seen.push(`DELETE ${path}.${String(k)}`);
          return Reflect.deleteProperty(t, k);
        },
      });
    (host.ctx as Record<string, unknown>)["app"] = record(host.app as object, "app");
    expect(host.eval(PROJECT_INFO)).toEqual({ ok: true, value: { path: null, numItems: 1, bitsPerChannel: null, dirty: false, version: "26.5" } });
    expect(seen).toEqual([
      "get app.project",
      "get app.project.file",
      "get app.project.numItems",
      "get app.project.bitsPerChannel",
      "get app.project.dirty",
      "get app.version",
    ]);
    expect(host.mutations).toEqual([]);
    expect(host.undo).toEqual({ begin: 0, end: 0 });
  });

  it("T19b: projectState takes only PROJECT_INFO's shape; a partial or mistyped answer is null (V5)", () => {
    const answer = { path: "C:\\p.aep", numItems: 3, bitsPerChannel: 8, dirty: false, version: "26.5x89" };
    expect(projectState(answer)).toEqual({ path: "C:\\p.aep", numItems: 3, dirty: false });
    expect(projectState({ ...answer, path: null, dirty: true })).toEqual({ path: null, numItems: 3, dirty: true });
    const { dirty: _dirty, ...noDirty } = answer;
    const { numItems: _numItems, ...noItems } = answer;
    const { path: _path, ...noPath } = answer;
    const bad: unknown[] = [
      noDirty,
      noItems,
      noPath,
      { ...answer, dirty: "true" },
      { ...answer, dirty: 1 },
      { ...answer, dirty: null },
      { ...answer, numItems: "3" },
      { ...answer, path: 3 },
      { ...answer, path: undefined },
      [answer],
      [],
      null,
      undefined,
      "C:\\p.aep",
      3,
    ];
    for (const raw of bad) expect(projectState(raw), JSON.stringify(raw) ?? String(raw)).toBeNull();
  });

  it("T21: a failed read-only check refuses before asking; not connected is the usual plain text", async () => {
    const failing =
      (error: unknown): Evaluate =>
      () => {
        throw error;
      };
    const cases: [Evaluate, string | RegExp][] = [
      [failing(new AppNotConnectedError("after_effects", "Open the panel.")), /^No running host connected for "after_effects"\. Open the panel\.$/],
      [
        failing(new EvalTimeoutError("after_effects", 10_000)),
        "Could not read the open After Effects project before asking about this script, which closes or replaces it (After Effects " +
          "did not answer within 10000 ms) — the script was not sent. Wait until After Effects responds (an earlier script may still " +
          "be running: a timeout stops the wait, not the script), then retry.",
      ],
      [
        failing(new AppDisconnectedError("after_effects", "socket closed")),
        "Could not read the open After Effects project before asking about this script, which closes or replaces it (the panel " +
          "disconnected) — the script was not sent. Reconnect the brainferno-mcp-bridge panel in After Effects (cc_connected_apps " +
          "shows when it is back), then retry.",
      ],
      [
        failing(new ScriptError("after_effects", "EvalScript error.", 3, { code: "HOST_ERROR" })),
        "Could not read the open After Effects project before asking about this script, which closes or replaces it (After Effects " +
          "answered: EvalScript error.) — the script was not sent. Retry; if it keeps failing, close and reopen the " +
          "brainferno-mcp-bridge panel in After Effects.",
      ],
      [
        () => null,
        "Could not read the open After Effects project before asking about this script, which closes or replaces it (After Effects " +
          "answered: an unexpected answer) — the script was not sent. Retry; if it keeps failing, close and reopen the " +
          "brainferno-mcp-bridge panel in After Effects.",
      ],
    ];
    for (const [evaluate, text] of cases) {
      audit.mockClear();
      const s = await session(OPEN, evaluate, { elicitation: FORM, answer: YES });
      const r = await s.run({ script: SWITCH });
      expect(isError(r)).toBe(true);
      if (typeof text === "string") expect(textOf(r)).toBe(text);
      else expect(textOf(r)).toMatch(text);
      expect(() => JSON.parse(textOf(r))).toThrow();
      expect(s.asked).toEqual([]);
      expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
      expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused"))]);
      await s.close();
    }
  });

  it("T21b: host and client text in a refusal is redacted, then put on one line, then capped (echo rule)", async () => {
    // The server's own secret, a Bearer credential and an Illustrator key, as a host or a client could echo them, with a
    // line break and a bidi override between them: the refusal shows them redacted, on one line, without the override.
    const KEY = "configured-secret-value";
    const RLO = String.fromCharCode(0x202e);
    const leak = `${KEY}\nBearer abcdefghijklmnop0123456789 ${RLO}ilst_abcdefghijklmnop0123`;
    const shown = "[redacted] Bearer [redacted] [redacted]";
    /** The secret starts at code point 290 of the text shown, inside the 300 kept: redacted whole, never cut first. */
    const late = (head: string) => `${head}${"p".repeat(290 - head.length)}${KEY} tail`;
    const lateShown = (head: string) => `${head}${"p".repeat(290 - head.length)}[redacted]${String.fromCharCode(0x2026)}(+5 chars)`;
    const CHECK_HEAD = "EvalScript error: ";
    const ASK_HEAD = "MCP error -32603: dialog crashed: ";
    setRedactionSecrets([KEY]);
    try {
      // The read-only check failed with the secrets in the host's message.
      const checkText = async (message: string) => {
        const failing: Evaluate = () => {
          throw new ScriptError("after_effects", message, 3, { code: "HOST_ERROR" });
        };
        const check = await session(OPEN, failing, { elicitation: FORM, answer: YES });
        const text = textOf(await check.run({ script: SWITCH }));
        await check.close();
        return text;
      };
      const checked = await checkText(`${CHECK_HEAD}${leak}`);
      expect(checked).toBe(
        "Could not read the open After Effects project before asking about this script, which closes or replaces it (After Effects " +
          `answered: ${CHECK_HEAD}${shown}) — the script was not sent. Retry; if it keeps failing, close and reopen the ` +
          "brainferno-mcp-bridge panel in After Effects.",
      );
      expect(checked).not.toContain("\n");
      expect(checked).not.toContain(RLO);
      const checkedLate = await checkText(late(CHECK_HEAD));
      expect(checkedLate).toContain(`(After Effects answered: ${lateShown(CHECK_HEAD)}) — the script was not sent.`);
      expect(checkedLate).not.toContain(KEY.slice(0, 8));

      // Asking failed with the secrets in the client's error.
      const askText = async (message: string) => {
        const ask = await session(OPEN, switchPanel(FONTPROJ), {
          elicitation: FORM,
          answer: () => {
            throw new Error(message);
          },
        });
        const text = textOf(await ask.run({ script: SWITCH }));
        await ask.close();
        return text;
      };
      const asked = await askText(`dialog crashed: ${leak}`);
      expect(asked).toBe(ASK_FAILED(`${ASK_HEAD}${shown}`));
      expect(asked).not.toContain("\n");
      expect(asked).not.toContain(RLO);
      const askedLate = await askText(late(ASK_HEAD).slice("MCP error -32603: ".length));
      expect(askedLate).toBe(ASK_FAILED(lateShown(ASK_HEAD)));
      expect(askedLate).not.toContain(KEY.slice(0, 8));
    } finally {
      setRedactionSecrets([]);
    }
  });

  it("T22: the gate, the args and a managed call are refused first: nothing checked, nothing asked", async () => {
    const closed = await session(CLOSED, switchPanel(), { elicitation: FORM, answer: YES });
    expect(textOf(await closed.run({ script: SWITCH }))).toBe(rawScriptsDisabledMessage("after_effects", []));
    expect(closed.calls).toEqual([]);
    expect(closed.asked).toEqual([]);
    await closed.close();

    const s = await session(OPEN, switchPanel(), { elicitation: FORM, answer: YES });
    const badArgs = await s.run({ script: SWITCH, args: { a: Infinity } });
    expect(textOf(badArgs)).toBe((aeArgsLiteral({ a: Infinity }) as { refusal: string }).refusal);
    const managed = await s.run({ script: "app.endUndoGroup(); app.open(f)" });
    expect(textOf(managed)).toBe(RUN_SCRIPT_MANAGED_REFUSAL);
    expect(s.calls).toEqual([]);
    expect(s.asked).toEqual([]);
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE), expect.stringMatching(REFUSED_LINE), expect.stringMatching(REFUSED_LINE)]);
    await s.close();
  });

  it("T23: a remote session asks its own client and says who is answering; the gate still applies", async () => {
    const REMOTE = { ...OPEN, remote: true, allowRemoteRawScripts: true };
    const s = await session(REMOTE, switchPanel(FONTPROJ), { sessionId: "0badc0de-1234", elicitation: FORM, answer: YES });
    const r = await s.run({ script: SWITCH });
    expect(isError(r)).toBe(false);
    const lines = messageOf(s.asked[0]).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe(REMOTE_QUESTION_LINE);
    expect(lines.slice(0, 3).concat(lines[4]!).join("\n")).toBe(QUESTION_SWITCH);
    expect(auditLines()).toEqual([expect.stringMatching(/^raw-script tool=ae_run_script app=after_effects sha256=[0-9a-f]{12} len=\d+ via=http:0badc0de outcome=run consent=operator$/)]);
    await s.close();

    const unasked = await session(REMOTE, switchPanel(FONTPROJ), { sessionId: "0badc0de-1234" });
    expect(textOf(await unasked.run({ script: SWITCH }))).toBe(`${UNASKED_SWITCH} ${REMOTE_MODEL_LINE}`);
    await unasked.close();

    const refused = await session({ ...REMOTE, allowRemoteRawScripts: false }, switchPanel(FONTPROJ), { sessionId: "0badc0de-1234", elicitation: FORM, answer: YES });
    expect(textOf(await refused.run({ script: SWITCH }))).toBe(REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE);
    expect(refused.calls).toEqual([]);
    expect(refused.asked).toEqual([]);
    await refused.close();
  });

  it("T24: over real Streamable HTTP, the question reaches the remote client and the call runs", async () => {
    const TOKEN = "test-token-0123456789abcdef";
    const sent: string[] = [];
    const panel = switchPanel(FONTPROJ);
    const bridge: AppBridge = {
      appId: "after_effects",
      isConnected: () => true,
      execute: async () => null,
      close: async () => {},
      evaluate: async (script) => {
        sent.push(script);
        return panel(script);
      },
    };
    const running = await startHttpServer(
      () => {
        const mcp = new McpServer({ name: "ae01", version: "0" });
        registerAfterEffectsTools(mcp, bridge, { rawScriptApps: ["after_effects"], remote: true, allowRemoteRawScripts: true });
        return mcp;
      },
      { host: "127.0.0.1", port: 0, token: TOKEN },
    );
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}${running.path}`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      });
      const client = new Client({ name: "remote", version: "0" }, { capabilities: { elicitation: { form: {} } } });
      const asked: string[] = [];
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        asked.push(messageOf(req.params));
        return { action: "accept", content: { allowProjectSwitch: true } };
      });
      await client.connect(transport);
      const r = await client.callTool({ name: "ae_run_script", arguments: { script: SWITCH } });
      expect(isError(r)).toBe(false);
      expect(envOf(r)).toMatchObject({ ok: true, value: 1 });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(`\n${REMOTE_QUESTION_LINE}\n`);
      expect(sent.map((x) => x === PROJECT_INFO)).toEqual([true, false]);
      expect(auditLines()).toEqual([expect.stringMatching(/ via=http:[0-9a-f]{8} outcome=run consent=operator$/)]);
      await client.close();
    } finally {
      await running.close();
    }
  });

  /** The question asked for `script` with the panel reporting `state` (the operator declines). */
  async function questionFor(script: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
    const s = await session(OPEN, switchPanel(state), { elicitation: FORM, answer: answering({ action: "decline" }) });
    expect(isError(await s.run({ script, ...extra }))).toBe(true);
    await s.close();
    return messageOf(s.asked[0]);
  }

  it("T25: the question states as seen live only what probe 10 saw (app.open), scoped to the calls and the project", async () => {
    // (a) app.open on a never-saved project, suppression on: pinned whole. Probe 10's project had a file, so neither what
    // happens nor whether After Effects asks is known here (F2).
    expect(await questionFor("app.open(new File(__args.p))", UNSAVED)).toBe(
      "ae_run_script wants to run an After Effects script that closes or replaces the open project: it calls app.open (line 1).\n" +
        "The open project has never been saved (no file), 0 items; it has no unsaved changes right now, but the script can make some before it switches.\n" +
        "With suppressDialogs on, this project has no file: what happens to its unsaved changes, and whether After Effects asks, is not verified (they may be lost).\n" +
        'The script is not sent to After Effects unless you set "Run the script" to yes and submit.',
    );
    // (b) suppression off: the save prompt is expected, not verified; the close clause holds either way (CS-2, H1).
    expect((await questionFor(SWITCH, FONTPROJ, { suppressDialogs: false })).split("\n")[2]).toBe(
      "With suppressDialogs off, After Effects is expected to show its own save prompt first when there are unsaved changes (not " +
        "verified live): After Effects stays blocked until someone answers it there, and the call times out meanwhile. " +
        CLOSE_CLAUSE,
    );
    // (c) a call not tried live is never stated as seen (CS-4, M1).
    const fresh = (await questionFor("app.newProject()", { ...FONTPROJ, dirty: false })).split("\n");
    expect(fresh[1]).toBe(
      "The open project is fontproj.aep (C:\\Projects\\Client X\\fontproj.aep), 12 items; it has no unsaved changes right now, but the script can make some before it switches.",
    );
    expect(fresh[2]).toBe(
      "With suppressDialogs on, for app.newProject, what happens to unsaved changes, and whether After Effects asks, is not verified " +
        "(they may be saved over the file or lost).",
    );
    expect(fresh[2]).not.toContain("saved the open project's unsaved changes");
    // (d) several calls: seen and untried apart (only app.open "without asking"), the close clause, and quit.
    const multi = (await questionFor(MULTI, FONTPROJ)).split("\n");
    expect(multi[0]).toBe(
      "ae_run_script wants to run an After Effects script that closes or replaces the open project: it calls app.project.close (line 2), app.newProject (line 3), app.open (line 4), app.quit (line 6).",
    );
    expect(multi[2]).toBe(
      "With suppressDialogs on: in a live test, app.open saved the open project's unsaved changes over its file without asking; " +
        "for app.newProject and app.quit, what happens to unsaved changes, and whether After Effects asks, is not verified (they may " +
        `be saved over the file or lost). ${CLOSE_CLAUSE} app.quit also closes After Effects itself.`,
    );
    // (e) a close alone, suppression off: only the close clause. No switching call, so no "expected" save prompt first;
    // but PROMPT_TO_SAVE_CHANGES may show one, which a close-only script can name too (AE-01 D15).
    const closeOnly = (await questionFor("app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", FONTPROJ, { suppressDialogs: false })).split("\n");
    expect(closeOnly[2]).toBe(CLOSE_CLAUSE);
    expect(closeOnly[2]).toContain("CloseOptions.PROMPT_TO_SAVE_CHANGES may show After Effects' own save prompt");
    expect(closeOnly.join("\n")).not.toContain("is expected to show its own save prompt first");
    // Nothing un-probed is stated as fact or as seen (AE-01 D15): no close was tried live over unsaved changes (probe 7
    // closed a project saved just before), so the clause is Adobe's documentation, and promises no "no prompt" either way.
    for (const claim of ["live test", "seen", "threw", "without a prompt", "whether suppressDialogs is on or off"]) {
      expect(closeOnly.join("\n"), claim).not.toContain(claim);
    }
    // (h) a close on a never-saved project: no SAVE_CHANGES part (there is no file to save over).
    const noFile = (await questionFor(SWITCH, UNSAVED)).split("\n");
    expect(noFile[2]).toBe(
      "With suppressDialogs on, this project has no file: what happens to its unsaved changes, and whether After Effects asks, is " +
        `not verified (they may be lost). ${CLOSE_CLAUSE_NO_FILE}`,
    );
    // (f) host text cannot break the dialog: no line break, no bidi override, and a cap.
    const RLO = String.fromCharCode(0x202e);
    const evil = { path: `C:\\Projects\\evil\nname${RLO}${"x".repeat(400)}.aep`, numItems: 1, dirty: true };
    const shown = await questionFor("app.open(f)", evil);
    expect(shown.split("\n")).toHaveLength(4);
    expect(shown).not.toContain(RLO);
    expect(shown).toContain(`${String.fromCharCode(0x2026)}(+`);
    // (g) the alias of app.project, caught by CloseOptions.
    const alias = (await questionFor("var p = app.project;\np.close(CloseOptions.SAVE_CHANGES)", FONTPROJ)).split("\n");
    expect(alias[0]).toMatch(/it calls a close that names CloseOptions \(line 2\)\.$/);
    expect(alias[2]).toBe(CLOSE_CLAUSE);
  });

  it("T25i: a macOS path shows its file name, in the question and in the fallback (V4)", async () => {
    const MAC = { path: "/Users/x/Projects/a.aep", numItems: 3, dirty: true };
    const state = "The open project is a.aep (/Users/x/Projects/a.aep), 3 items; it has unsaved changes right now.";
    expect((await questionFor("app.open(f)", MAC)).split("\n")[1]).toBe(state);
    const unasked = await session(OPEN, switchPanel(MAC));
    expect(textOf(await unasked.run({ script: "app.open(f)" }))).toContain(`; to keep the open project, remove those calls instead. ${state} `);
    await unasked.close();
  });

  it("T25j: \"does not ask\" only where probe 10 saw it: every switching call app.open, a project with a file, suppression on (F2)", () => {
    // Every non-empty set of triggers (a close alone, through app.project or the CloseOptions alias, switches nothing),
    // on a saved and a never-saved project, with suppression on and off; the question and the fallback alike.
    const triggers = [
      "app.open(f)",
      "app.openFast(f)",
      "app.newProject()",
      "app.quit()",
      "app.restart()",
      "app.project.close(1)",
      "var p = app.project; p.close(CloseOptions.SAVE_CHANGES)",
    ];
    let checked = 0;
    let probe10 = 0;
    for (let mask = 1; mask < 1 << triggers.length; mask++) {
      const script = triggers.filter((_, i) => mask & (1 << i)).join("\n");
      const calls = projectSwitchCalls(script);
      const switching = calls.map((c) => c.call).filter((n) => n !== "app.project.close" && n !== "a close that names CloseOptions");
      for (const state of [FONTPROJ, UNSAVED]) {
        const file = state.path !== null;
        for (const suppress of [true, false]) {
          const doesNotAsk = suppress && file && switching.length > 0 && switching.every((n) => n === "app.open");
          const seenLive = suppress && file && switching.includes("app.open");
          const askUnverified = suppress && switching.length > 0 && (!file || switching.some((n) => n !== "app.open"));
          for (const text of [switchQuestion(calls, state, suppress, false), switchUnasked(calls, state, suppress, false)]) {
            const where = `${JSON.stringify(script)} ${file ? "saved" : "never saved"} suppress=${suppress}`;
            expect(text.includes("does not ask"), where).toBe(doesNotAsk);
            // Only probe 10 is stated as seen, once, and never for a close.
            expect(text.split("in a live test, app.open saved").length - 1, where).toBe(seenLive ? 1 : 0);
            expect(text.split(/live test|seen/).length - 1, where).toBe(seenLive ? 1 : 0);
            expect(text.includes("without asking"), where).toBe(seenLive && !doesNotAsk);
            expect(text.includes("whether After Effects asks, is not verified"), where).toBe(askUnverified);
            checked++;
            if (doesNotAsk) probe10++;
          }
        }
      }
    }
    expect(checked).toBe(127 * 2 * 2 * 2);
    // app.open alone or with closes: 1 + 3 sets (app.project.close, the alias, both), saved, suppression on, two texts.
    expect(probe10).toBe(4 * 2);
  });

  it("T28: every refusal after the trigger matched closes the detour; cc_eval_script's own refusal is the pointer (CS-1)", () => {
    const calls = projectSwitchCalls(SWITCH);
    const tail = (text: string, n: number) => text.slice(-n);
    // The builders themselves, not the pinned copies: each ends with the no-detour sentence...
    for (const text of [switchDeclined("decline"), switchDeclined("unset"), switchAskFailed("x"), switchUnasked(calls, FONTPROJ, true, false)]) {
      expect(tail(text, NO_DETOUR.length + 1), text).toBe(` ${NO_DETOUR}`);
    }
    // ...or carries it before one last sentence: the cancel text's way forward (F4) and the remote line (C14).
    expect(switchDeclined("cancel")).toContain(`. ${NO_DETOUR} If no question appeared in the client, it cannot show one here:`);
    const remote = switchUnasked(calls, FONTPROJ, true, true);
    expect(tail(remote, NO_DETOUR.length + REMOTE_MODEL_LINE.length + 2)).toBe(` ${NO_DETOUR} ${REMOTE_MODEL_LINE}`);
    // cc_eval_script's refusal is the one consent path's pointer itself: it sends the script to ae_run_script, so it
    // carries no no-detour sentence (spec 4.1, 5.7).
    const cc = evalSwitchRefusal(calls);
    expect(cc).toContain(" — run it with ae_run_script, which asks the operator first and sends it only if they agree.");
    expect(cc).not.toContain(NO_DETOUR);
  });
});
