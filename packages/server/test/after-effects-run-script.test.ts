import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitRequestSchema, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
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
  RUN_SCRIPT_DESCRIPTION,
  RUN_SCRIPT_MANAGED_REFUSAL,
  SWITCH_REFUSALS_MAX,
  SWITCH_REFUSAL_TTL_MS,
  SwitchRefusals,
  aeArgsLiteral,
  closeOptionsOf,
  evalSwitchRefusal,
  locateAeError,
  projectState,
  projectSwitchCalls,
  registerAfterEffectsTools,
  riskSentence,
  runRawScript,
  switchRefusal,
  type AfterEffectsToolOptions,
  type ProjectState,
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

interface SessionOptions {
  sessionId?: string;
  /**
   * The client advertises form elicitation (as Claude Code does) and records every elicitation/create it gets, answering
   * accept + true. AE-01 consent is chat only: the server must never send one.
   */
  elicitation?: boolean;
  /** The clock ae_run_script's project-switch guard reads (AfterEffectsToolOptions.now). */
  now?: () => number;
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
  registerAfterEffectsTools(server, bridge, { ...gate, ...(opts.now ? { now: opts.now } : {}) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  if (opts.sessionId !== undefined) st.sessionId = opts.sessionId;
  const client = new Client({ name: "ae01", version: "0" }, opts.elicitation ? { capabilities: { elicitation: { form: {} } } } : undefined);
  const asked: ElicitRequest["params"][] = [];
  if (opts.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return { action: "accept", content: { allowProjectSwitch: true } };
    });
  }
  await Promise.all([client.connect(ct), server.connect(st)]);
  // The server receiving the client's notifications/cancelled. The SDK aborts the tool call's signal in a microtask it
  // queues while delivering that message (InMemoryTransport delivers synchronously), so the abort has run by the time
  // a later task starts: C13 orders on this, not on timers.
  let cancelSeen = () => {};
  const cancelled = new Promise<void>((resolve) => (cancelSeen = resolve));
  const deliver = st.onmessage;
  st.onmessage = (message, extra) => {
    deliver?.(message, extra);
    if ("method" in message && message.method === "notifications/cancelled") cancelSeen();
  };
  return {
    calls,
    /** Every elicitation/create the client received (with `elicitation` set); it must stay empty. */
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
    // args left out is audited as {}, as the script gets it, so it pairs with args: {} (fix C5).
    const bare = JSON.stringify({ script, args: {} });
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

    // The auto-save hazard the live runs found (AE-01 probe 10; the consent live run's T1 and T2), scoped to the calls it
    // was seen with, and the operator's OK in the chat it now needs (AE-01 consent, chat only): safety text, in its own
    // project-switch part, ending well before the cut, whatever follows it.
    const autoSave = "app.open, app.openFast and app.newProject were seen to save the open project's unsaved changes over its file without asking.";
    const consent = "A script that closes or replaces the open project is refused until the operator agrees in the chat: see allowProjectSwitch.";

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
    // Chat only: no tool text promises a question in the client (Claude Code 2.1.296 did not show one in the AE-01 consent
    // live run).
    for (const text of [d, describe("allowProjectSwitch"), describe("suppressDialogs")]) {
      expect(text).not.toMatch(/the tool asks|asks the operator|question|in this client|elicit/i);
    }

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
      // Scoped to the calls the live runs saw save over the file (probe 10; the consent live run's T1, T2), on a project
      // with a file; on one with no file, what app.open did (T3) and that the other two were not tried (fix B2).
      "with suppression on, a script that opens or creates another project (app.open, app.openFast, app.newProject) " +
        "while the open project has a file and unsaved changes gets no save prompt (seen live): After Effects saves the " +
        "open project over its file, those changes included.",
      "On a project with no file, app.open still showed After Effects' save prompt, which blocks After Effects; " +
        "app.openFast and app.newProject on such a project were not tried.",
      // T5on, T5, t4#0: no prompt.
      "To discard the changes instead, call app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES) first; it closed " +
        "without a prompt in the live run.",
      // Not a complete guard: the consent applies to such a script either way (M2).
      "Either way, a script whose text names such a call needs the operator's OK first (see allowProjectSwitch).",
    ]) {
      expect(describe("suppressDialogs"), phrase).toContain(phrase);
    }
    expect(describe("suppressDialogs")).not.toContain("may still appear");
    expect(describe("suppressDialogs")).not.toContain("is the exception"); // read as covering openFast and newProject (B2)
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
    // AE-01 consent: the flag cannot pre-approve (the refuse-first guard), every trigger is named with what was seen and
    // what was not, and the known gaps are stated. The flag is set only after this tool's own plain-text refusal was
    // passed on.
    expect(describe("allowProjectSwitch")).toMatch(
      /^Set true only after this tool refused this script in plain text, you told the operator what that refusal says, and they agreed in the chat that it may close or replace the open project; defaults to false\. /,
    );
    for (const phrase of [
      // "as sent": the key is the JSON of the args as sent, so the same keys in another order are other args (C5).
      "It is honoured only for the same script, args (as sent) and suppressDialogs that this tool refused in this " +
        "session within the last 10 minutes, and only once; otherwise the call is refused again, with the risk.",
      // The consent live run (T1, T2, T4, T5on, T3) and probe 10, all with suppression on, scoped to the project's state.
      "Seen live with suppressDialogs on, for a project with a file: app.open, app.openFast, app.newProject and " +
        "close(CloseOptions.PROMPT_TO_SAVE_CHANGES) saved its unsaved changes over the file without asking; " +
        "close(CloseOptions.DO_NOT_SAVE_CHANGES) threw them away. For a never-saved project, app.open still showed " +
        "After Effects' save prompt, which blocks After Effects.",
      // Not the whole list of what was seen or not tried: the refusal names each case (round-2 fix B1; T5, T6, T7 and
      // t4#0 were tried, and the refusal states them as seen).
      "Every other case is in the refusal, as seen live or marked \"not verified live\"; app.quit and app.restart were not tried.",
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
    expect(describe("allowProjectSwitch")).not.toContain("as Adobe documents it"); // the close outcomes are seen live now
    // Round 2, B1: false for T5, T6, T7 and t4#0, which were tried.
    expect(describe("allowProjectSwitch")).not.toContain("Other cases, app.quit and app.restart among them, were not tried");
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
    // app.open is a project switch (AE-01 consent): each script is first refused (only the read-only check,
    // PROJECT_INFO, is sent), then the operator's OK comes as allowProjectSwitch on the same call.
    const approved = async (call: Record<string, unknown>) => {
      expect(isError(await s.run(call))).toBe(true);
      return s.run({ ...call, allowProjectSwitch: true });
    };
    expect(envOf(await approved({ script: "app.open();\n1" }))).toMatchObject({ ok: true, value: 1 });
    expect(ends).toEqual([[false]]);

    const off = envOf(await approved({ script: "app.open();\n1", suppressDialogs: false }));
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
/** What ae_run_script sends for `script` with these args and the default undo name. */
const sentFor = (script: string, args: Record<string, unknown> = {}, suppressDialogs = true) =>
  runRawScript(script, { args: (aeArgsLiteral(args) as { literal: string }).literal, undoGroupName: "Brainferno script", suppressDialogs });
const OK_ENVELOPE = { ok: true, value: 1, logs: [], logsDropped: 0 };
const P = { p: "C:\\Projects\\other.aep" };

// The texts, pinned whole for representative cases, rendered for the fixtures above.
const NO_DETOUR = "Do not run this script, or its project switch, through cc_eval_script or another tool.";
const REMOTE_MODEL_LINE =
  "This is a shared (remote) session: the person you ask in the chat answers for whoever is at After Effects, who is not asked — say so when you ask.";
/** The one sentence a flagged call with no matching refusal adds at the front (contract item 4). */
const NO_REFUSAL_FOUND =
  "allowProjectSwitch is honoured only for the same script, args (as sent) and suppressDialogs that this tool refused in this " +
  "session within the last 10 minutes, once; this call had no such refusal.";
/**
 * The sentence a risk with two or more switch calls ends with (fix C1): the later ones act on the project the first one
 * leaves open, which T3 shows can be this same project (round-2 fix A1).
 */
const LATER_CALLS =
  "These clauses describe the project open now; the later calls act on the project the first one leaves open (which can " +
  "be this same project).";
/** Every refusal with the risk: the approved call does not read the project again (fix B3). */
const AS_IT_IS_NOW =
  "This describes the project as it is now: the approved call does not read it again, so if the open project changes " +
  "first, call without allowProjectSwitch for a new refusal.";
/** The refusal for SWITCH on FONTPROJ, suppressDialogs on, a local session (contract item 1). */
const REFUSED_SWITCH =
  "ae_run_script did not send this script: it calls app.project.close (line 1), app.open (line 2), which close or replace the open " +
  "After Effects project — tell the operator what follows, ask in the chat whether the script may do this, and call ae_run_script " +
  "again with the same script, args (as sent) and suppressDialogs and allowProjectSwitch: true only if they agree (within 10 " +
  "minutes; it lets that call through once); to keep the open project, remove those calls instead. The open project is " +
  "fontproj.aep (C:\\Projects\\Client X\\fontproj.aep), 12 items; it has unsaved changes right now. With suppressDialogs on, " +
  "close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the file as it was. app.open saves " +
  `the open project's unsaved changes over its file without asking. ${LATER_CALLS} ${AS_IT_IS_NOW} Do not run this script, or ` +
  "its project switch, through cc_eval_script or another tool.";
/** The audit line's ` sha256=… len=… ` part. */
const signature = (line: string) => / sha256=[0-9a-f]{12} len=\d+ /.exec(line)?.[0];

describe("ae_run_script: the operator's OK in the chat before a project switch (AE-01 consent, chat only)", () => {
  it("C1: a script that names no switch call is never checked, flag or not, and runs", async () => {
    const s = await session(OPEN, switchPanel());
    const r = await s.run({ script: "app.project.numItems", allowProjectSwitch: true });
    expect(isError(r)).toBe(false);
    expect(envOf(r)).toMatchObject({ ok: true, value: 1 });
    expect(s.calls.map((c) => [c.script, c.opts])).toEqual([[sentFor("app.project.numItems"), { timeoutClass: "slow", timeoutMs: undefined }]]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run"))]);
    await s.close();
  });

  it("C2: the first call is refused with the risk; only the read-only check (fast, no arguments in its context) reached the panel", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ));
    const r = await s.run({ script: SWITCH, args: P });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toBe(REFUSED_SWITCH);
    expect(() => JSON.parse(textOf(r))).toThrow();
    expect(textOf(r)).not.toContain("shared (remote) session");
    expect(s.calls.map((c) => [c.script, c.opts])).toEqual([[PROJECT_INFO, { timeoutClass: "fast" }]]);
    // The check runs in the tool-call context too, which never holds ae_run_script's arguments.
    expect(s.calls[0]!.ctx).toEqual({ tool: "ae_run_script", args: undefined });
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=needed"))]);
    await s.close();
  });

  it("C3: the same call with allowProjectSwitch: true then runs once, without a second check; again, it is refused", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ));
    await s.run({ script: SWITCH, args: P });
    const refusedLine = auditLines()[0]!;
    audit.mockClear();
    const ok = await s.run({ script: SWITCH, args: P, allowProjectSwitch: true });
    expect(isError(ok)).toBe(false);
    expect(envOf(ok)).toMatchObject({ ok: true, value: 1 });
    expect(s.calls.map((c) => [c.script, c.opts])).toEqual([
      [PROJECT_INFO, { timeoutClass: "fast" }],
      [sentFor(SWITCH, P), { timeoutClass: "slow", timeoutMs: undefined }],
    ]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run consent=flag"))]);
    // The run and the refusal it follows audit the same payload: an auditor can pair them.
    expect(signature(auditLines()[0]!)).toBe(signature(refusedLine));

    // One OK is one run: the same flagged call again is a first call (checked, refused with the risk, recorded)...
    audit.mockClear();
    const again = await s.run({ script: SWITCH, args: P, allowProjectSwitch: true });
    expect(isError(again)).toBe(true);
    expect(textOf(again)).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    expect(scriptsSent(s).slice(2)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=needed"))]);
    // ...whose refusal lets the next one through.
    expect(isError(await s.run({ script: SWITCH, args: P, allowProjectSwitch: true }))).toBe(false);
    expect(scriptsSent(s).slice(3)).toEqual([sentFor(SWITCH, P)]);
    await s.close();
  });

  it("C3b: a recorded refusal never lets the call through without the flag; allowProjectSwitch: false is no flag (fix A2)", async () => {
    for (const repeat of [{}, { allowProjectSwitch: false }]) {
      audit.mockClear();
      const s = await session(OPEN, switchPanel(FONTPROJ));
      expect(textOf(await s.run({ script: SWITCH, args: P }))).toBe(REFUSED_SWITCH);
      // The same call again, within the 10 minutes, without the flag: the normal refusal (no lead sentence), a second
      // read-only check, and the caller's script never sent.
      const again = await s.run({ script: SWITCH, args: P, ...repeat });
      expect(isError(again), JSON.stringify(repeat)).toBe(true);
      expect(textOf(again), JSON.stringify(repeat)).toBe(REFUSED_SWITCH);
      expect(scriptsSent(s)).toEqual([PROJECT_INFO, PROJECT_INFO]);
      expect(auditLines()).toEqual([
        expect.stringMatching(LINE("outcome=refused consent=needed")),
        expect.stringMatching(LINE("outcome=refused consent=needed")),
      ]);
      // Only the flagged call runs, once.
      const ran = await s.run({ script: SWITCH, args: P, allowProjectSwitch: true });
      expect(isError(ran)).toBe(false);
      expect(scriptsSent(s)).toEqual([PROJECT_INFO, PROJECT_INFO, sentFor(SWITCH, P)]);
      expect(auditLines().slice(2)).toEqual([expect.stringMatching(LINE("outcome=run consent=flag"))]);
      await s.close();
    }
  });

  it("C4: allowProjectSwitch: true on the first call is refused with the risk and one sentence more; the next flagged call runs", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ));
    const r = await s.run({ script: SWITCH, args: P, allowProjectSwitch: true });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=needed"))]);
    audit.mockClear();
    expect(isError(await s.run({ script: SWITCH, args: P, allowProjectSwitch: true }))).toBe(false);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO, sentFor(SWITCH, P)]);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=run consent=flag"))]);
    await s.close();
  });

  it("C5: the OK covers only the same script, the same args and the same effective suppressDialogs", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ));
    await s.run({ script: SWITCH, args: P }); // refused; suppressDialogs defaults to true
    const others: Record<string, unknown>[] = [
      { script: SWITCH, args: { p: "C:\\Projects\\third.aep" } }, // other args
      { script: SWITCH }, // no args
      { script: `${SWITCH} `, args: P }, // another script
      { script: SWITCH, args: P, suppressDialogs: false }, // another suppressDialogs
    ];
    for (const call of others) {
      const r = await s.run({ ...call, allowProjectSwitch: true });
      expect(isError(r), JSON.stringify(call)).toBe(true);
      expect(textOf(r).startsWith(`${NO_REFUSAL_FOUND} ae_run_script did not send this script: `), JSON.stringify(call)).toBe(true);
    }
    expect(scriptsSent(s)).toEqual(Array(1 + others.length).fill(PROJECT_INFO));
    // The effective value counts: suppressDialogs: true is the default left out.
    expect(isError(await s.run({ script: SWITCH, args: P, suppressDialogs: true, allowProjectSwitch: true }))).toBe(false);
    expect(scriptsSent(s).at(-1)).toBe(sentFor(SWITCH, P));
    await s.close();
  });

  it("C5b: args left out and args: {} run the same, so they are the same call; the same keys in another order are not (fix C5)", async () => {
    const s = await session(OPEN, switchPanel(FONTPROJ));
    // Left out, then {}; and {}, then left out: each pair is one refusal and its run, with one audited payload, the
    // JSON of { script, args } with args {} (as the script gets it).
    const payload = JSON.stringify({ script: SWITCH, args: {} });
    const signed = ` sha256=${createHash("sha256").update(payload).digest("hex").slice(0, 12)} len=${payload.length} `;
    for (const [first, second] of [
      [{}, { args: {} }],
      [{ args: {} }, {}],
    ] as const) {
      audit.mockClear();
      expect(textOf(await s.run({ script: SWITCH, ...first }))).toBe(REFUSED_SWITCH);
      const ran = await s.run({ script: SWITCH, ...second, allowProjectSwitch: true });
      expect(isError(ran), JSON.stringify([first, second])).toBe(false);
      expect(scriptsSent(s).at(-1)).toBe(sentFor(SWITCH));
      expect(auditLines().map(signature)).toEqual([signed, signed]);
    }
    // The key is the args as sent: the same keys in another order fail closed (refused again, with the risk), and the
    // texts promise only "args (as sent)".
    expect(textOf(await s.run({ script: SWITCH, args: { a: 1, b: 2 } }))).toBe(REFUSED_SWITCH);
    const reordered = await s.run({ script: SWITCH, args: { b: 2, a: 1 }, allowProjectSwitch: true });
    expect(textOf(reordered)).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    expect(textOf(reordered)).toContain("the same script, args (as sent) and suppressDialogs");
    expect(isError(await s.run({ script: SWITCH, args: { b: 2, a: 1 }, allowProjectSwitch: true }))).toBe(false);
    await s.close();
  });

  it("C6: a refusal lets the flagged call through for 10 minutes and no longer (injected clock)", async () => {
    expect(SWITCH_REFUSAL_TTL_MS).toBe(600_000);
    let t = 1_000_000;
    const s = await session(OPEN, switchPanel(FONTPROJ), { now: () => t });
    await s.run({ script: SWITCH });
    t += SWITCH_REFUSAL_TTL_MS; // exactly 10 minutes after the refusal: still honoured
    expect(isError(await s.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(false);
    await s.run({ script: SWITCH });
    t += SWITCH_REFUSAL_TTL_MS + 1; // 10 minutes and 1 ms after: expired
    audit.mockClear();
    const late = await s.run({ script: SWITCH, allowProjectSwitch: true });
    expect(textOf(late)).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused consent=needed"))]);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO, sentFor(SWITCH), PROJECT_INFO, PROJECT_INFO]);
    await s.close();
  });

  it("C7: a session keeps at most 64 refusals; the 65th drops the oldest", async () => {
    expect(SWITCH_REFUSALS_MAX).toBe(64);
    const s = await session(OPEN, switchPanel(FONTPROJ));
    const script = (i: number) => `${SWITCH};${i}`;
    for (let i = 0; i <= SWITCH_REFUSALS_MAX; i++) await s.run({ script: script(i) });
    expect(scriptsSent(s)).toEqual(Array(SWITCH_REFUSALS_MAX + 1).fill(PROJECT_INFO));
    // The second-oldest and the newest are kept...
    for (const i of [1, SWITCH_REFUSALS_MAX]) expect(isError(await s.run({ script: script(i), allowProjectSwitch: true })), String(i)).toBe(false);
    // ...the oldest is gone.
    expect(textOf(await s.run({ script: script(0), allowProjectSwitch: true }))).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    await s.close();
  });

  it("C8: a refusal lets the flagged call through only in its own session: one guard per McpServer", async () => {
    const a = await session(OPEN, switchPanel(FONTPROJ));
    const b = await session(OPEN, switchPanel(FONTPROJ));
    await a.run({ script: SWITCH });
    const r = await b.run({ script: SWITCH, allowProjectSwitch: true });
    expect(textOf(r)).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    expect(scriptsSent(b)).toEqual([PROJECT_INFO]);
    expect(isError(await a.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(false);
    expect(scriptsSent(a)).toEqual([PROJECT_INFO, sentFor(SWITCH)]);
    await a.close();
    await b.close();
  });

  it("C9: a client that advertises form elicitation gets exactly the same; the server never sends elicitation/create", async () => {
    const run = async (s: Awaited<ReturnType<typeof session>>) => {
      const refused = await s.run({ script: SWITCH, args: P });
      const flaggedOther = await s.run({ script: `${SWITCH} `, allowProjectSwitch: true });
      const ran = await s.run({ script: SWITCH, args: P, allowProjectSwitch: true });
      return [textOf(refused), textOf(flaggedOther), isError(ran), envOf(ran)["value"]];
    };
    const plain = await session(OPEN, switchPanel(FONTPROJ));
    const able = await session(OPEN, switchPanel(FONTPROJ), { elicitation: true });
    const spy = vi.spyOn(able.mcp.server, "elicitInput");
    const expected = await run(plain);
    const plainAudit = auditLines().map((l) => l.replace(/ sha256=\S+ len=\d+ /, " "));
    audit.mockClear();
    expect(await run(able)).toEqual(expected);
    expect(auditLines().map((l) => l.replace(/ sha256=\S+ len=\d+ /, " "))).toEqual(plainAudit);
    expect(able.asked).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(scriptsSent(able)).toEqual(scriptsSent(plain));
    // Nothing in after-effects.ts can ask: the consent is the chat's.
    const source = readFileSync(new URL("../src/tools/after-effects.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/elicitInput|getClientCapabilities|elicitation\/create|ElicitRe/);
    await plain.close();
    await able.close();
  });

  it("C10: a remote session's refusal says who answers for the person at After Effects; the gate still applies", async () => {
    const REMOTE = { ...OPEN, remote: true, allowRemoteRawScripts: true };
    const s = await session(REMOTE, switchPanel(FONTPROJ), { sessionId: "0badc0de-1234" });
    expect(textOf(await s.run({ script: SWITCH }))).toBe(`${REFUSED_SWITCH} ${REMOTE_MODEL_LINE}`);
    expect(textOf(await s.run({ script: `${SWITCH} `, allowProjectSwitch: true }))).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH} ${REMOTE_MODEL_LINE}`);
    expect(isError(await s.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(false);
    const tail = (t: string) => new RegExp(`^raw-script tool=ae_run_script app=after_effects sha256=[0-9a-f]{12} len=\\d+ via=http:0badc0de ${t}$`);
    expect(auditLines()).toEqual([
      expect.stringMatching(tail("outcome=refused consent=needed")),
      expect.stringMatching(tail("outcome=refused consent=needed")),
      expect.stringMatching(tail("outcome=run consent=flag")),
    ]);
    await s.close();

    const refused = await session({ ...REMOTE, allowRemoteRawScripts: false }, switchPanel(FONTPROJ), { sessionId: "0badc0de-1234" });
    expect(textOf(await refused.run({ script: SWITCH }))).toBe(REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE);
    expect(textOf(await refused.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE);
    expect(refused.calls).toEqual([]);
    await refused.close();
  });

  it("C11: over real Streamable HTTP, http.ts builds one McpServer per session, so sessions never share a refusal", async () => {
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
    let built = 0;
    // index.ts passes () => createMcpServer(rt, { remote: true }), which registers the After Effects tools on a new
    // McpServer each time; this factory does the same for After Effects alone.
    const running = await startHttpServer(
      () => {
        built++;
        const mcp = new McpServer({ name: "ae01", version: "0" });
        registerAfterEffectsTools(mcp, bridge, { rawScriptApps: ["after_effects"], remote: true, allowRemoteRawScripts: true });
        return mcp;
      },
      { host: "127.0.0.1", port: 0, token: TOKEN },
    );
    try {
      const connect = async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}${running.path}`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        });
        const client = new Client({ name: "remote", version: "0" });
        await client.connect(transport);
        return client;
      };
      const a = await connect();
      const b = await connect();
      expect(built).toBe(2);
      const call = (c: Client, flag: boolean) =>
        c.callTool({ name: "ae_run_script", arguments: { script: SWITCH, ...(flag ? { allowProjectSwitch: true } : {}) } });
      expect(textOf(await call(a, false))).toBe(`${REFUSED_SWITCH} ${REMOTE_MODEL_LINE}`);
      expect(textOf(await call(b, true))).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH} ${REMOTE_MODEL_LINE}`);
      const ran = await call(a, true);
      expect(isError(ran)).toBe(false);
      expect(envOf(ran)).toMatchObject({ ok: true, value: 1 });
      expect(sent.map((x) => x === PROJECT_INFO)).toEqual([true, true, false]);
      expect(auditLines()).toEqual([
        expect.stringMatching(/ via=http:[0-9a-f]{8} outcome=refused consent=needed$/),
        expect.stringMatching(/ via=http:[0-9a-f]{8} outcome=refused consent=needed$/),
        expect.stringMatching(/ via=http:[0-9a-f]{8} outcome=run consent=flag$/),
      ]);
      await a.close();
      await b.close();
    } finally {
      await running.close();
    }
  });

  it("C12: the OK is used once the script reaches the bridge: not connected keeps it, a dispatched failure uses it", async () => {
    let connected = true;
    let timeout = false;
    const panel: Evaluate = (script) => {
      if (script === PROJECT_INFO) return switchPanel(FONTPROJ)(script);
      if (!connected) throw new AppNotConnectedError("after_effects", "Open the panel.");
      if (timeout) throw new EvalTimeoutError("after_effects", 100);
      return OK_ENVELOPE;
    };
    const s = await session(OPEN, panel);
    await s.run({ script: SWITCH });
    connected = false;
    const notConnected = await s.run({ script: SWITCH, allowProjectSwitch: true });
    expect(isError(notConnected)).toBe(true);
    expect(textOf(notConnected)).toMatch(/^No running host connected for "after_effects"\. Open the panel\.$/);
    connected = true; // the operator reconnects the panel: the same OK still holds
    expect(isError(await s.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(false);

    await s.run({ script: SWITCH });
    timeout = true;
    const timedOut = await s.run({ script: SWITCH, allowProjectSwitch: true });
    expect(envOf(timedOut).error.message).toMatch(/^timed out after 100 ms/);
    timeout = false; // the script was sent: the OK is used
    expect(textOf(await s.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO, sentFor(SWITCH), sentFor(SWITCH), PROJECT_INFO, sentFor(SWITCH), PROJECT_INFO]);
    await s.close();
  });

  it("C13: two flagged calls at once after one refusal: one runs, the other is refused", async () => {
    const held = deferred<JsonValue>();
    const reached = deferred<void>();
    const panel: Evaluate = (script) => {
      if (script === PROJECT_INFO) return switchPanel(FONTPROJ)(script);
      reached.resolve();
      return held.promise;
    };
    const s = await session(OPEN, panel);
    await s.run({ script: SWITCH });
    const first = s.run({ script: SWITCH, allowProjectSwitch: true });
    await reached.promise; // the first call's script is at the panel, unanswered
    const second = await s.run({ script: SWITCH, allowProjectSwitch: true });
    expect(textOf(second)).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    held.resolve(OK_ENVELOPE);
    expect(isError(await first)).toBe(false);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO, sentFor(SWITCH), PROJECT_INFO]);
    await s.close();
  });

  it("C14: a failed read-only check refuses in plain text, with no consent= and no refusal recorded", async () => {
    const failing =
      (error: unknown): (() => JsonValue) =>
      () => {
        throw error;
      };
    const cases: [() => JsonValue, string | RegExp][] = [
      [failing(new AppNotConnectedError("after_effects", "Open the panel.")), /^No running host connected for "after_effects"\. Open the panel\.$/],
      [
        failing(new EvalTimeoutError("after_effects", 10_000)),
        "Could not read the open After Effects project (After Effects did not answer within 10000 ms), so this script, which " +
          "closes or replaces it, was not sent. Wait until After Effects responds (an earlier script may still be running: a " +
          "timeout stops the wait, not the script), then retry.",
      ],
      [
        failing(new AppDisconnectedError("after_effects", "socket closed")),
        "Could not read the open After Effects project (the panel disconnected), so this script, which closes or replaces it, " +
          "was not sent. Reconnect the brainferno-mcp-bridge panel in After Effects (cc_connected_apps shows when it is back), " +
          "then retry.",
      ],
      [
        failing(new ScriptError("after_effects", "EvalScript error.", 3, { code: "HOST_ERROR" })),
        "Could not read the open After Effects project (After Effects answered: EvalScript error.), so this script, which " +
          "closes or replaces it, was not sent. Retry; if it keeps failing, close and reopen the brainferno-mcp-bridge panel in " +
          "After Effects.",
      ],
      [
        () => null,
        "Could not read the open After Effects project (After Effects answered: an unexpected answer), so this script, which " +
          "closes or replaces it, was not sent. Retry; if it keeps failing, close and reopen the brainferno-mcp-bridge panel in " +
          "After Effects.",
      ],
    ];
    for (const [failure, text] of cases) {
      for (const flag of [false, true]) {
        audit.mockClear();
        let failed = false; // the first check fails, later ones answer
        const panel: Evaluate = (script) => {
          if (script !== PROJECT_INFO || failed) return switchPanel(FONTPROJ)(script);
          failed = true;
          return failure();
        };
        const s = await session(OPEN, panel);
        const r = await s.run({ script: SWITCH, ...(flag ? { allowProjectSwitch: true } : {}) });
        expect(isError(r)).toBe(true);
        if (typeof text === "string") expect(textOf(r)).toBe(text);
        else expect(textOf(r)).toMatch(text);
        expect(() => JSON.parse(textOf(r))).toThrow();
        expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
        expect(auditLines()).toEqual([expect.stringMatching(LINE("outcome=refused"))]);
        // No risk was shown, so no refusal was recorded: the flagged call is a first call.
        expect(textOf(await s.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
        expect(scriptsSent(s)).toEqual([PROJECT_INFO, PROJECT_INFO]);
        await s.close();
      }
    }
  });

  it("C15: a call the client cancelled during the read-only check records no refusal: the model never saw the risk", async () => {
    const reached = deferred<void>();
    const held = deferred<JsonValue>();
    let hold = true; // only the first check is held
    const panel: Evaluate = (script) => {
      if (script !== PROJECT_INFO || !hold) return switchPanel(FONTPROJ)(script);
      hold = false;
      reached.resolve();
      return held.promise;
    };
    const s = await session(OPEN, panel);
    const audited = nextAudit();
    const ac = new AbortController();
    const call = s.run({ script: SWITCH }, { signal: ac.signal });
    await reached.promise; // the read-only check is at the panel
    ac.abort("the operator pressed Esc");
    await expect(call).rejects.toThrow();
    await s.cancelled; // the server has the client's notifications/cancelled...
    await nextTask(); // ...and has aborted the tool call's signal
    held.resolve({ ...FONTPROJ, bitsPerChannel: 8, version: "26.5x89" }); // only now does the check answer
    expect(await audited).toMatch(LINE("outcome=refused consent=needed"));
    await nextTask(); // anything the handler would still send has reached the panel
    expect(scriptsSent(s)).toEqual([PROJECT_INFO]);
    expect(textOf(await s.run({ script: SWITCH, allowProjectSwitch: true }))).toBe(`${NO_REFUSAL_FOUND} ${REFUSED_SWITCH}`);
    expect(scriptsSent(s)).toEqual([PROJECT_INFO, PROJECT_INFO]);
    await s.close();
  });

  it("C16: the gate, the args and a managed call are refused first: nothing checked, no refusal recorded", async () => {
    const closed = await session(CLOSED, switchPanel());
    expect(textOf(await closed.run({ script: SWITCH }))).toBe(rawScriptsDisabledMessage("after_effects", []));
    expect(closed.calls).toEqual([]);
    await closed.close();

    const s = await session(OPEN, switchPanel());
    const badArgs = await s.run({ script: SWITCH, args: { a: Infinity } });
    expect(textOf(badArgs)).toBe((aeArgsLiteral({ a: Infinity }) as { refusal: string }).refusal);
    const managed = await s.run({ script: "app.endUndoGroup(); app.open(f)" });
    expect(textOf(managed)).toBe(RUN_SCRIPT_MANAGED_REFUSAL);
    expect(s.calls).toEqual([]);
    expect(auditLines()).toEqual([expect.stringMatching(REFUSED_LINE), expect.stringMatching(REFUSED_LINE), expect.stringMatching(REFUSED_LINE)]);
    await s.close();
  });

  it("C17: the read-only check (PROJECT_INFO) only reads: no set, define, delete or call, no mutation, no undo group", () => {
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

  it("C17b: projectState takes only PROJECT_INFO's shape; a partial or mistyped answer is null (V5)", () => {
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

  it("C18: host text in a refusal is redacted, then put on one line, then capped (echo rule)", async () => {
    // The server's own secret, a Bearer credential and an Illustrator key, as a host could echo them, with a line break
    // and a bidi override between them: the refusal shows them redacted, on one line, without the override.
    const KEY = "configured-secret-value";
    const RLO = String.fromCharCode(0x202e);
    const leak = `${KEY}\nBearer abcdefghijklmnop0123456789 ${RLO}ilst_abcdefghijklmnop0123`;
    const shown = "[redacted] Bearer [redacted] [redacted]";
    /** The secret starts at code point 290 of the text shown, inside the 300 kept: redacted whole, never cut first. */
    const late = (head: string) => `${head}${"p".repeat(290 - head.length)}${KEY} tail`;
    const lateShown = (head: string) => `${head}${"p".repeat(290 - head.length)}[redacted]${String.fromCharCode(0x2026)}(+5 chars)`;
    const CHECK_HEAD = "EvalScript error: ";
    setRedactionSecrets([KEY]);
    try {
      const checkText = async (message: string) => {
        const failing: Evaluate = () => {
          throw new ScriptError("after_effects", message, 3, { code: "HOST_ERROR" });
        };
        const check = await session(OPEN, failing);
        const text = textOf(await check.run({ script: SWITCH }));
        await check.close();
        return text;
      };
      const checked = await checkText(`${CHECK_HEAD}${leak}`);
      expect(checked).toBe(
        `Could not read the open After Effects project (After Effects answered: ${CHECK_HEAD}${shown}), so this script, ` +
          "which closes or replaces it, was not sent. Retry; if it keeps failing, close and reopen the brainferno-mcp-bridge " +
          "panel in After Effects.",
      );
      expect(checked).not.toContain("\n");
      expect(checked).not.toContain(RLO);
      const checkedLate = await checkText(late(CHECK_HEAD));
      expect(checkedLate).toContain(`(After Effects answered: ${lateShown(CHECK_HEAD)}), so this script, which closes or replaces it, was not sent.`);
      expect(checkedLate).not.toContain(KEY.slice(0, 8));
    } finally {
      setRedactionSecrets([]);
    }
  });

  it("C19: SwitchRefusals hands an OK out once; a put-back keeps its refusal time; a clock that went back expires it", () => {
    let t = 0;
    const r = new SwitchRefusals(() => t);
    expect(r.take("a")).toBeNull();
    r.record("a"); // refused at 0
    const putBack = r.take("a");
    expect(putBack).not.toBeNull();
    expect(r.take("a")).toBeNull(); // taken: a second call cannot have it
    t = 5 * 60_000;
    putBack!(); // the script never reached the bridge: the OK is back, still dated 0...
    t = SWITCH_REFUSAL_TTL_MS + 1;
    expect(r.take("a")).toBeNull(); // ...so it expires 10 minutes after the refusal, not after the put-back

    r.record("b");
    r.take("b")!(); // put back at once
    expect(r.take("b")).not.toBeNull(); // within the 10 minutes: honoured

    r.record("c");
    t -= 1; // the wall clock went back: fail closed
    expect(r.take("c")).toBeNull();
  });
});

/** A project with a file (saved) and one without (never saved), each with unsaved changes. */
const SAVED: ProjectState = { path: "C:\\p\\a.aep", numItems: 2, dirty: true };
const NOFILE: ProjectState = { path: null, numItems: 2, dirty: true };
const CLOSE = (option: string) => `close(CloseOptions.${option})`;
/** One script per item the risk sentence describes. */
const ITEM_SCRIPT: Record<string, string> = {
  "app.open": "app.open(new File(__args.p))",
  "app.openFast": "app.openFast(new File(__args.p))",
  "app.newProject": "app.newProject()",
  "app.quit": "app.quit()",
  "app.restart": "app.restart()",
  [CLOSE("DO_NOT_SAVE_CHANGES")]: "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)",
  [CLOSE("SAVE_CHANGES")]: "app.project.close(CloseOptions.SAVE_CHANGES)",
  [CLOSE("PROMPT_TO_SAVE_CHANGES")]: "app.project.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)",
};
const cell = (item: string, suppress: boolean, state: ProjectState) => `${item}|${suppress ? "on" : "off"}|${state.path === null ? "no file" : "saved"}`;
/**
 * The AE-01 consent live run (After Effects 26.5x89, Windows 11, scratch projects with unsaved changes) and AE-01 probe
 * 10, one row per case tried: what After Effects did, as the risk sentence says it. Every other cell was not tried.
 */
const LIVE: Record<string, { prompt: boolean; text: string }> = {
  // probe 10, F2
  [cell("app.open", true, SAVED)]: { prompt: false, text: "With suppressDialogs on, app.open saves the open project's unsaved changes over its file without asking." },
  // T2, T1
  [cell("app.openFast", true, SAVED)]: { prompt: false, text: "With suppressDialogs on, app.openFast saves the open project's unsaved changes over its file without asking." },
  [cell("app.newProject", true, SAVED)]: { prompt: false, text: "With suppressDialogs on, app.newProject saves the open project's unsaved changes over its file without asking." },
  // T3
  [cell("app.open", true, NOFILE)]: {
    prompt: true,
    text:
      "With suppressDialogs on, app.open still showed After Effects' own save prompt for unsaved changes in a project with no file: " +
      "it blocks After Effects until someone answers it there, and the call times out meanwhile; after Don't Save, the other " +
      "project was not opened and the unsaved one stayed open.",
  },
  // T7
  [cell("app.open", false, SAVED)]: {
    prompt: true,
    text:
      "With suppressDialogs off, app.open showed After Effects' own save prompt: it blocks After Effects until someone answers it " +
      "there, and the call times out meanwhile; after Don't Save, the other project opened and the file was unchanged.",
  },
  // T4
  [cell(CLOSE("PROMPT_TO_SAVE_CHANGES"), true, SAVED)]: {
    prompt: false,
    text: "With suppressDialogs on, close(CloseOptions.PROMPT_TO_SAVE_CHANGES) saves the open project's unsaved changes over its file without asking.",
  },
  // T5on, T5
  [cell(CLOSE("DO_NOT_SAVE_CHANGES"), true, SAVED)]: {
    prompt: false,
    text: "With suppressDialogs on, close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the file as it was.",
  },
  [cell(CLOSE("DO_NOT_SAVE_CHANGES"), false, SAVED)]: {
    prompt: false,
    text: "With suppressDialogs off, close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the file as it was.",
  },
  // t4#0: the record shows no prompt (ok in 48 ms) and, after the close, a project with no file and no items; it shows
  // nothing about where the changes went, so the text claims nothing about them (fix C12).
  [cell(CLOSE("DO_NOT_SAVE_CHANGES"), true, NOFILE)]: {
    prompt: false,
    text:
      "With suppressDialogs on, close(CloseOptions.DO_NOT_SAVE_CHANGES) closes the project without asking; the project open " +
      "afterwards has no file and no items.",
  },
  // T6
  [cell(CLOSE("SAVE_CHANGES"), false, SAVED)]: {
    prompt: false,
    text: "With suppressDialogs off, close(CloseOptions.SAVE_CHANGES) saves the open project's unsaved changes over its file without asking.",
  },
};
/** Not tried, suppression off, an opening call or PROMPT_TO_SAVE_CHANGES on a saved project: the save prompt is expected. */
const EXPECTED_PROMPT = new Set([
  cell("app.open", false, NOFILE),
  cell("app.openFast", false, SAVED),
  cell("app.openFast", false, NOFILE),
  cell("app.newProject", false, SAVED),
  cell("app.newProject", false, NOFILE),
  cell(CLOSE("PROMPT_TO_SAVE_CHANGES"), false, SAVED),
]);

describe("ae_run_script: what the refusal says After Effects does (AE-01 consent live run)", () => {
  it("C20: closeOptionsOf takes a value only from a close whose own argument is that value; any other close stands for all three (fix A1)", () => {
    const ALL = ["DO_NOT_SAVE_CHANGES", "SAVE_CHANGES", "PROMPT_TO_SAVE_CHANGES"];
    const cases: [string, string[]][] = [
      // A close whose own argument is one CloseOptions value, dotted or quoted: that value.
      ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", ["DO_NOT_SAVE_CHANGES"]],
      ["app.project.close(CloseOptions.SAVE_CHANGES)", ["SAVE_CHANGES"]],
      ['app.project.close(CloseOptions["SAVE_CHANGES"])', ["SAVE_CHANGES"]],
      ['app.project["close"](CloseOptions.SAVE_CHANGES)', ["SAVE_CHANGES"]],
      ["app['project']['close']( CloseOptions [ 'PROMPT_TO_SAVE_CHANGES' ] )", ["PROMPT_TO_SAVE_CHANGES"]],
      ["app.project.close(\n  CloseOptions . DO_NOT_SAVE_CHANGES\n)", ["DO_NOT_SAVE_CHANGES"]],
      // Through an alias of app.project, and mixed: each close's own value, once, in order of first appearance.
      [
        "p.close(CloseOptions . PROMPT_TO_SAVE_CHANGES); q.close(CloseOptions['DO_NOT_SAVE_CHANGES']); r.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)",
        ["PROMPT_TO_SAVE_CHANGES", "DO_NOT_SAVE_CHANGES"],
      ],
      ["app.project.close(CloseOptions.SAVE_CHANGES); var p = app.project; p.close(CloseOptions.DO_NOT_SAVE_CHANGES)", ["SAVE_CHANGES", "DO_NOT_SAVE_CHANGES"]],
      // A File's close is not a project close.
      ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); var f = File(__args.log); f.open('w'); f.close()", ["DO_NOT_SAVE_CHANGES"]],
      // The reviewers' cases: a value named elsewhere (a comment, an earlier close, a variable) never stands for a close
      // whose own argument is not that value.
      ["// like CloseOptions.DO_NOT_SAVE_CHANGES\napp.project.close(CloseOptions[__args.o])", ALL],
      ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.open(f); app.project.close(__args.opt)", ALL],
      ["var opt = CloseOptions.DO_NOT_SAVE_CHANGES; if (__args.keep) opt = CloseOptions[__args.mode]; app.project.close(opt)", ALL],
      // A number, no argument, a computed name, more than the value, a variable through an alias, a value named outside
      // any close, a name that is no value.
      ["app.project.close(1)", ALL],
      ["app.project.close()", ALL],
      ["p.close(CloseOptions[x])", ALL],
      ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES || 1)", ALL],
      ["var o = CloseOptions.SAVE_CHANGES; var p = app.project; p.close(o)", ALL],
      ["// CloseOptions.SAVE_CHANGES would save it\napp.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", ALL],
      ["CloseOptions.SAVE_CHANGESX", ALL],
      ["CloseOptions.save_changes", ALL],
      // Round 2, B2: once the scan sees a close (CloseOptions named, or a close through app.project), a close on any
      // object whose argument is neither empty nor one value written out stands for all three (an alias of app.project
      // the text does not show; a File's or a window's close with an argument over-warns, the safe direction). The
      // reviewers' three probes first.
      ["var p = app.project; if (m) p.close(__args.mode); else p.close(CloseOptions.DO_NOT_SAVE_CHANGES);", ALL],
      ["var p = app.project; p.close(CloseOptions.DO_NOT_SAVE_CHANGES); p.close(1213)", ALL],
      ["// app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)\nvar p = app.project; p.close(__args.o)", ALL],
      ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); w.close(1)", ALL],
      ['p["close"](__args.o); p.close(CloseOptions.SAVE_CHANGES)', ALL],
      // ...but a close with no argument (a File's) stays out, as does any close when the scan sees none.
      ["p.close(CloseOptions.SAVE_CHANGES); f.close( )", ["SAVE_CHANGES"]],
      ["app.open(f); w.close(1)", []],
      // No close at all.
      ["app.open(f)", []],
      ["MyCloseOptions.SAVE_CHANGES", []],
      ["var f = File(__args.log); f.open('w'); f.close()", []],
    ];
    for (const [script, expected] of cases) expect(closeOptionsOf(script), script).toEqual(expected);
  });

  it("C21: each case tried live reads as seen; every case not tried says so; 'without asking' only where no prompt was seen", () => {
    let rows = 0;
    for (const [item, script] of Object.entries(ITEM_SCRIPT)) {
      for (const suppress of [true, false]) {
        for (const state of [SAVED, NOFILE]) {
          const where = cell(item, suppress, state);
          const text = riskSentence(script, state, suppress);
          const live = LIVE[where];
          const on = suppress ? "on" : "off";
          const quit = item === "app.quit" || item === "app.restart" ? ` ${item} is meant to close After Effects itself (not verified live).` : "";
          if (live) expect(text, where).toBe(live.text);
          else if (EXPECTED_PROMPT.has(where)) {
            expect(text, where).toBe(
              `With suppressDialogs off, ${item} is expected to show After Effects' own save prompt, which blocks After Effects until someone answers it there (not verified live).`,
            );
          } else {
            expect(text, where).toBe(`Not verified live (suppressDialogs ${on}${state.path === null ? ", a project with no file" : ""}): what ${item} does with unsaved changes.${quit}`);
          }
          // Nothing not tried is stated as fact (app.quit and app.restart closing After Effects included: "meant to", not
          // verified live; round-2 fix B3); "without asking" only where the live run saw no prompt.
          expect(text.includes("without asking"), where).toBe(live?.prompt === false);
          expect(/does not ask/.test(text), where).toBe(false);
          expect(/not verified live/i.test(text), where).toBe(live === undefined);
          expect(/\bshowed\b/.test(text), where).toBe(live?.prompt === true);
          rows++;
        }
      }
    }
    expect(rows).toBe(8 * 2 * 2);
  });

  it("C22: every set of calls: each is described and nothing else, grouped by outcome, seen and not tried kept apart", () => {
    const ALL = ["DO_NOT_SAVE_CHANGES", "SAVE_CHANGES", "PROMPT_TO_SAVE_CHANGES"].map(CLOSE);
    // Each part with the items its refusal must describe, spelled out here (fix A1: not derived from the code's rule):
    // a close is one value only when its own argument is that value, else all three. A set of parts is described by the
    // union of their items. `call`: the part is a call the text shows (the comment is not); `close`: it closes.
    const parts: { code: string; items: string[]; call: boolean; close: boolean }[] = [
      { code: "app.open(f)", items: ["app.open"], call: true, close: false },
      { code: "app.openFast(f)", items: ["app.openFast"], call: true, close: false },
      { code: "app.newProject()", items: ["app.newProject"], call: true, close: false },
      { code: "app.quit()", items: ["app.quit"], call: true, close: false },
      { code: "app.restart()", items: ["app.restart"], call: true, close: false },
      { code: "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", items: [CLOSE("DO_NOT_SAVE_CHANGES")], call: true, close: true },
      { code: "var p = app.project; p.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)", items: [CLOSE("PROMPT_TO_SAVE_CHANGES")], call: true, close: true },
      { code: 'app.project["close"](CloseOptions.SAVE_CHANGES)', items: [CLOSE("SAVE_CHANGES")], call: true, close: true },
      { code: "app.project.close(__args.opt)", items: ALL, call: true, close: true },
      { code: "// like CloseOptions.DO_NOT_SAVE_CHANGES", items: ALL, call: false, close: true },
    ];
    /** Whether the text names the item (app.open, not as the start of app.openFast). */
    const names = (text: string, item: string) => (item === "app.open" ? /app\.open(?!Fast)/.test(text) : text.includes(item));
    const every = [...new Set(parts.flatMap((p) => p.items))];
    let checked = 0;
    for (let mask = 1; mask < 1 << parts.length; mask++) {
      const chosen = parts.filter((_, i) => mask & (1 << i));
      const script = chosen.map((p) => p.code).join("\n");
      const items = [...new Set(chosen.flatMap((p) => p.items))];
      // Two calls or more: the later ones act on the project the first one leaves open (fix C1; round-2 A1). The comment
      // is no call, but alone with a call that does not close it is a second one (the scan reads CloseOptions as a close).
      const calls = chosen.filter((p) => p.call);
      const comment = chosen.some((p) => !p.call);
      const later = calls.length >= 2 || (calls.length === 1 && comment && !calls[0]!.close);
      for (const state of [SAVED, NOFILE]) {
        for (const suppress of [true, false]) {
          const where = `${JSON.stringify(script)} ${cell("", suppress, state)}`;
          const text = riskSentence(script, state, suppress);
          expect(text.endsWith(` ${LATER_CALLS}`) || text === LATER_CALLS, where).toBe(later);
          const body = text.replace(LATER_CALLS, "");
          for (const item of every) expect(names(body, item), `${where}: ${item}`).toBe(items.includes(item));
          const live = items.map((i) => LIVE[cell(i, suppress, state)]);
          expect(text.includes("without asking"), where).toBe(live.some((l) => l?.prompt === false));
          expect(/Not verified live \(/.test(text), where).toBe(items.some((i, n) => live[n] === undefined && !EXPECTED_PROMPT.has(cell(i, suppress, state))));
          // Each outcome is one sentence: no call is described twice.
          expect(text.split("saves the open project's unsaved changes").length + text.split("save the open project's unsaved changes").length - 2, where).toBeLessThanOrEqual(1);
          expect(text.startsWith("With suppressDialogs") || text.startsWith("Not verified live"), where).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(1023 * 4);
  });

  it("C23: representative refusals, pinned whole", () => {
    // Several calls on a saved project, suppression on: grouped (app.newProject and app.open save over the file), then the
    // note that the later calls act on the project the first one leaves open (fix C1; round-2 A1).
    expect(riskSentence(MULTI, FONTPROJ, true)).toBe(
      "With suppressDialogs on, close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the file " +
        "as it was. app.newProject and app.open save the open project's unsaved changes over its file without asking. Not verified " +
        "live (suppressDialogs on): what app.quit does with unsaved changes. app.quit is meant to close After Effects itself (not " +
        `verified live). ${LATER_CALLS}`,
    );
    // Both quitting calls: one sentence, plural (round-2 B3: not tried, so "meant to").
    expect(riskSentence("app.quit();\napp.restart()", FONTPROJ, true)).toBe(
      "Not verified live (suppressDialogs on): what app.quit and app.restart do with unsaved changes. app.quit and app.restart " +
        `are meant to close After Effects itself (not verified live). ${LATER_CALLS}`,
    );
    // Round 2, A1: app.open on a project with no file, suppression on, then a close. T3: after Don't Save the unsaved
    // project stayed open, so the close may act on it; the refusal must not say a different project is open.
    const OPEN_THEN_CLOSE = "app.open(new File(__args.p));\napp.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)";
    const openThenClose = switchRefusal(OPEN_THEN_CLOSE, NOFILE, true, false, false);
    expect(openThenClose).toBe(
      "ae_run_script did not send this script: it calls app.open (line 1), app.project.close (line 2), which close or replace " +
        "the open After Effects project — tell the operator what follows, ask in the chat whether the script may do this, and " +
        "call ae_run_script again with the same script, args (as sent) and suppressDialogs and allowProjectSwitch: true only if " +
        "they agree (within 10 minutes; it lets that call through once); to keep the open project, remove those calls instead. " +
        "The open project has never been saved (no file), 2 items; it has unsaved changes right now. With suppressDialogs on, " +
        "app.open still showed After Effects' own save prompt for unsaved changes in a project with no file: it blocks After " +
        "Effects until someone answers it there, and the call times out meanwhile; after Don't Save, the other project was not " +
        "opened and the unsaved one stayed open. close(CloseOptions.DO_NOT_SAVE_CHANGES) closes the project without asking; the " +
        "project open afterwards has no file and no items. These clauses describe the project open now; the later calls act on " +
        "the project the first one leaves open (which can be this same project). This describes the project as it is now: the " +
        "approved call does not read it again, so if the open project changes first, call without allowProjectSwitch for a new " +
        "refusal. Do not run this script, or its project switch, through cc_eval_script or another tool.",
    );
    expect(openThenClose).not.toContain("a different project");
    expect(openThenClose).not.toContain("another project");
    // Every opening call at once: the grouping the spec names.
    expect(riskSentence("app.open(f); app.openFast(g); app.newProject()", FONTPROJ, true)).toBe(
      `With suppressDialogs on, app.open, app.openFast and app.newProject save the open project's unsaved changes over its file without asking. ${LATER_CALLS}`,
    );
    // One call made twice is two calls; one call alone gets no note.
    const OPEN_SAVES = "With suppressDialogs on, app.open saves the open project's unsaved changes over its file without asking.";
    expect(riskSentence("app.open(f);\napp.open(g)", FONTPROJ, true)).toBe(`${OPEN_SAVES} ${LATER_CALLS}`);
    expect(riskSentence("app.open(f)", FONTPROJ, true)).toBe(OPEN_SAVES);
    // A never-saved project, suppression off.
    expect(riskSentence(SWITCH, UNSAVED, false)).toBe(
      "With suppressDialogs off, app.open is expected to show After Effects' own save prompt, which blocks After Effects until " +
        "someone answers it there (not verified live). Not verified live (suppressDialogs off, a project with no file): what " +
        `close(CloseOptions.DO_NOT_SAVE_CHANGES) does with unsaved changes. ${LATER_CALLS}`,
    );
    // A close whose own argument is not one CloseOptions value: each value's outcome.
    const ALL_THREE =
      "With suppressDialogs on, close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the " +
      "file as it was. close(CloseOptions.PROMPT_TO_SAVE_CHANGES) saves the open project's unsaved changes over its file without " +
      "asking. Not verified live (suppressDialogs on): what close(CloseOptions.SAVE_CHANGES) does with unsaved changes.";
    expect(riskSentence("app.project.close(2)", FONTPROJ, true)).toBe(ALL_THREE);
    // The reviewers' cases (fix A1), a saved project, suppression on: a value named elsewhere does not stand for it.
    expect(riskSentence("// like CloseOptions.DO_NOT_SAVE_CHANGES\napp.project.close(CloseOptions[__args.o])", SAVED, true)).toBe(ALL_THREE);
    expect(riskSentence("app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.open(f); app.project.close(__args.opt)", SAVED, true)).toBe(
      "With suppressDialogs on, close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the " +
        "file as it was. close(CloseOptions.PROMPT_TO_SAVE_CHANGES) and app.open save the open project's unsaved changes over its " +
        "file without asking. Not verified live (suppressDialogs on): what close(CloseOptions.SAVE_CHANGES) does with unsaved " +
        `changes. ${LATER_CALLS}`,
    );
    expect(
      riskSentence("var opt = CloseOptions.DO_NOT_SAVE_CHANGES; if (__args.keep) opt = CloseOptions[__args.mode]; app.project.close(opt)", SAVED, true),
    ).toBe(ALL_THREE);
    // Round 2, B2: the reviewers' three probes. A close through an alias whose argument is not one value written out
    // stands for all three, and counts as a call, so the note on later calls follows.
    for (const script of [
      "var p = app.project; if (m) p.close(__args.mode); else p.close(CloseOptions.DO_NOT_SAVE_CHANGES);",
      "var p = app.project; p.close(CloseOptions.DO_NOT_SAVE_CHANGES); p.close(1213)",
      "// app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)\nvar p = app.project; p.close(__args.o)",
    ]) {
      expect(riskSentence(script, SAVED, true), script).toBe(`${ALL_THREE} ${LATER_CALLS}`);
    }
    // A File's close() (no argument) is no call and changes nothing; a close with an argument when the scan sees no
    // close is outside it (the alias gap, pinned in T2).
    const DO_NOT_ONLY =
      "With suppressDialogs on, close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the file as it was.";
    expect(riskSentence("app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); var f = File(__args.log); f.open('w'); f.close()", SAVED, true)).toBe(
      DO_NOT_ONLY,
    );
    expect(riskSentence("app.open(f); w.close(1)", SAVED, true)).toBe(
      "With suppressDialogs on, app.open saves the open project's unsaved changes over its file without asking.",
    );
    // ...and a close whose own argument is the value: that value alone.
    expect(riskSentence("app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", SAVED, true)).toBe(
      "With suppressDialogs on, close(CloseOptions.DO_NOT_SAVE_CHANGES) throws unsaved changes away without asking, leaving the file as it was.",
    );
    expect(riskSentence('app.project["close"](CloseOptions.SAVE_CHANGES)', SAVED, true)).toBe(
      "Not verified live (suppressDialogs on): what close(CloseOptions.SAVE_CHANGES) does with unsaved changes.",
    );
    expect(riskSentence('app.project["close"](CloseOptions.SAVE_CHANGES)', SAVED, false)).toBe(
      "With suppressDialogs off, close(CloseOptions.SAVE_CHANGES) saves the open project's unsaved changes over its file without asking.",
    );
    // app.open on a never-saved project, suppression on, through the whole refusal.
    expect(switchRefusal("app.open(new File(__args.p))", UNSAVED, true, false, false)).toBe(
      "ae_run_script did not send this script: it calls app.open (line 1), which closes or replaces the open After Effects project " +
        "— tell the operator what follows, ask in the chat whether the script may do this, and call ae_run_script again with the " +
        "same script, args (as sent) and suppressDialogs and allowProjectSwitch: true only if they agree (within 10 minutes; it " +
        "lets that call through once); to keep the open project, remove those calls instead. The open project has never been " +
        "saved (no file), 0 items; it has no unsaved changes right now, but the script can make some before it switches. With " +
        "suppressDialogs on, app.open still showed After Effects' own save prompt for unsaved changes in a project with no file: " +
        "it blocks After Effects until someone answers it there, and the call times out meanwhile; after Don't Save, the other " +
        `project was not opened and the unsaved one stayed open. ${AS_IT_IS_NOW} Do not run this script, or its project switch, ` +
        "through cc_eval_script or another tool.",
    );
    // The alias of app.project, caught by CloseOptions; its value is named.
    expect(switchRefusal("var p = app.project;\np.close(CloseOptions.SAVE_CHANGES)", FONTPROJ, false, false, false)).toContain(
      "it calls a close that names CloseOptions (line 2), which closes or replaces the open After Effects project — ",
    );
  });

  it("C24: a macOS path shows its file name; host text cannot break the refusal (no line break, no bidi override, capped)", () => {
    const MAC = { path: "/Users/x/Projects/a.aep", numItems: 3, dirty: true };
    expect(switchRefusal("app.open(f)", MAC, true, false, false)).toContain(
      "; to keep the open project, remove those calls instead. The open project is a.aep (/Users/x/Projects/a.aep), 3 items; it has unsaved changes right now. ",
    );
    const RLO = String.fromCharCode(0x202e);
    const evil = { path: `C:\\Projects\\evil\nname${RLO}${"x".repeat(400)}.aep`, numItems: 1, dirty: true };
    const shown = switchRefusal("app.open(f)", evil, true, false, false);
    expect(shown).not.toContain("\n");
    expect(shown).not.toContain(RLO);
    expect(shown).toContain(`${String.fromCharCode(0x2026)}(+`);
  });

  it("C25: every refusal after the trigger matched closes the detour; cc_eval_script's own refusal is the pointer (CS-1)", () => {
    const tail = (text: string, n: number) => text.slice(-n);
    for (const flagged of [false, true]) {
      const local = switchRefusal(SWITCH, FONTPROJ, true, false, flagged);
      expect(tail(local, NO_DETOUR.length + 1)).toBe(` ${NO_DETOUR}`);
      expect(local.startsWith(NO_REFUSAL_FOUND)).toBe(flagged);
      const remote = switchRefusal(SWITCH, FONTPROJ, true, true, flagged);
      expect(tail(remote, NO_DETOUR.length + REMOTE_MODEL_LINE.length + 2)).toBe(` ${NO_DETOUR} ${REMOTE_MODEL_LINE}`);
    }
    // cc_eval_script's refusal is the one consent path's pointer itself: it sends the script to ae_run_script, so it
    // carries no no-detour sentence; it promises no question, only the chat.
    const cc = evalSwitchRefusal(projectSwitchCalls(SWITCH));
    expect(cc).toBe(
      "cc_eval_script did not send this script: it calls app.project.close (line 1), app.open (line 2), which close or replace the " +
        "open After Effects project (a comment or string that names one counts) — run it with ae_run_script, which needs the " +
        "operator's OK in the chat first and says what to tell them.",
    );
    expect(cc).not.toContain(NO_DETOUR);
    expect(cc).not.toMatch(/asks the operator/);
  });
});
