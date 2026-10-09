import { createHash } from "node:crypto";
import vm from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeServer } from "../src/bridge/socket.js";
import type { AppBridge, JsonValue } from "../src/bridge/types.js";
import type { RawScriptApp } from "../src/config.js";
import { log, setLogLevel } from "../src/logging.js";
import { registerDiagnosticTools } from "../src/tools/diagnostics.js";
import {
  RAW_SCRIPTS_DISABLED_MESSAGE,
  REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE,
  asciiLiteral,
  auditRawCall,
  envelopeResult,
  lineCount,
  makeEnvelope,
  rawGateState,
  rawScriptWrapper,
  toEnvelope,
  viaOf,
} from "../src/tools/raw-script.js";
import { es3Violations } from "./osscript.test.js";

// Built from char codes so this source file stays ASCII (U+2028 is a line terminator in source).
const LS = String.fromCharCode(0x2028);
const E_ACUTE = String.fromCharCode(0xe9);
const EMOJI = String.fromCodePoint(0x1f600);

/** Run the wrapper the way a host would, and return what crosses the wire (JSON). */
function run(script: string, context: vm.Context = vm.createContext({})): Record<string, any> {
  return JSON.parse(JSON.stringify(vm.runInContext(rawScriptWrapper(script), context)));
}

describe("rawScriptWrapper (generated ES3)", () => {
  const tricky = [
    'say "hi" and \'bye\'',
    "back\\slash \\n not-a-newline",
    "line one\nline two\r\nline three",
    `before${LS}after`,
    `caf${E_ACUTE}`,
    `smile ${EMOJI}`,
  ];

  it("is ES3-clean, pure ASCII, one IIFE expression that evals the source", () => {
    for (const s of tricky) {
      const w = rawScriptWrapper(s);
      expect(es3Violations(w), JSON.stringify(s)).toEqual([]);
      expect(/^[\x00-\x7e]*$/.test(w), JSON.stringify(s)).toBe(true);
      expect(w.startsWith("(function () {\n  var __src = ")).toBe(true);
      expect(w.endsWith("})()")).toBe(true);
      expect(w).toContain("eval(__src)");
      expect(w).toContain(asciiLiteral(s));
    }
  });

  it("delivers the script text to eval byte-for-byte", () => {
    // `__src` is the decoded literal; returning it proves the escaping round-trips.
    for (const s of tricky) {
      const script = `/* ${s} */ __src`;
      expect(run(script).value, JSON.stringify(s)).toBe(script);
    }
  });

  it("asciiLiteral escapes every non-ASCII code unit and stays a jsStringLiteral", () => {
    expect(asciiLiteral(`a${E_ACUTE}${LS}${EMOJI}"`)).toBe('"a\\u00e9\\u2028\\ud83d\\ude00\\""');
  });
});

describe("rawScriptWrapper behaviour (node:vm as the host)", () => {
  it("returns the completion value of the last statement", () => {
    expect(run("var a=2; a*3")).toEqual({ ok: true, value: 6, logs: [], logsDropped: 0 });
    expect(run("1; 2").value).toBe(2);
    expect(run("function f(){return 5}; f()").value).toBe(5);
    expect(run("undefined").value).toBeNull();
    expect(run('({ name: "Main", sizes: [1920, 1080], on: true, none: null })').value).toEqual({
      name: "Main",
      sizes: [1920, 1080],
      on: true,
      none: null,
    });
  });

  it("reports a syntax error as ok:false with a message", () => {
    const r = run("var x = ;");
    expect(r.ok).toBe(false);
    expect(typeof r.error.message).toBe("string");
    expect(r.error.message.length).toBeGreaterThan(0);
    expect(r.value).toBeNull();
    // V8 errors carry no .line, so neither the line nor the calibration exists here.
    expect(r.error.line).toBeNull();
    expect(r.error.lineBase).toBeNull();
  });

  it("keeps declarations local to the call; undeclared assignments still leak (documented)", () => {
    const ctx = vm.createContext({});
    expect(run("var leak = 1; function helper() {} leak", ctx).value).toBe(1);
    expect(vm.runInContext("typeof leak + ' ' + typeof helper", ctx)).toBe("undefined undefined");
    run("persisted = 7; 0", ctx);
    expect(vm.runInContext("persisted", ctx)).toBe(7);
  });

  it("does not let the script's own variables clobber the wrapper's", () => {
    const r = run('var __logs = "mine", __v = 3; __log("kept"); __v + 1');
    expect(r).toEqual({ ok: true, value: 4, logs: ["kept"], logsDropped: 0 });
  });

  it("collects __log lines, capped at 200 lines and 20000 characters", () => {
    expect(run("__log('a'); 1").logs).toEqual(["a"]);

    const many = run("for (var i = 0; i < 300; i++) { __log(i); } 1");
    expect(many.logs).toHaveLength(200);
    expect(many.logs[0]).toBe("0");
    expect(many.logsDropped).toBe(100);

    const big = run('for (var i = 0; i < 30; i++) { __log(new Array(1001).join("x")); } 1');
    const total = big.logs.reduce((n: number, l: string) => n + l.length, 0);
    expect(total).toBeLessThanOrEqual(20000);
    expect(big.logs).toHaveLength(20);
    expect(big.logsDropped).toBe(10);

    const long = run('__log(new Array(5001).join("y")); 1');
    expect(long.logs[0]).toHaveLength(2003);
    expect(long.logs[0].endsWith("...")).toBe(true);
  });

  it("refuses a class or host object, naming its path", () => {
    const top = run("new (function C(){})()");
    expect(top.ok).toBe(false);
    expect(top.error.message).toContain("value is a host/class object");
    expect(top.error.message).toContain("copy the fields you need");
    expect(top.error.lineBase).toBeNull();
    expect(top.value).toBeNull();

    const nested = run("({ a: [1, new (function C(){})()] })");
    expect(nested.error.message).toContain("value.a[1] is a host/class object");
    expect(run("new Date(0)").error.message).toContain("host/class object");
  });

  it("bounds nesting and size, so a cycle fails fast", () => {
    expect(run("var o = 1; for (var i = 0; i < 60; i++) { o = { n: o }; } o").ok).toBe(true);
    const deep = run("var o = 1; for (var i = 0; i < 70; i++) { o = { n: o }; } o");
    expect(deep.ok).toBe(false);
    expect(deep.error.message).toContain("nested more than 64 levels");

    const t0 = Date.now();
    const cycle = run("var o = {}; o.self = o; o");
    expect(cycle.ok).toBe(false);
    expect(cycle.error.message).toMatch(/^The script ran, but its result is not plain data: value\.self\.self.* \(cycle\?\)/);
    expect(Date.now() - t0).toBeLessThan(1_000);

    const wide = run("var a = []; for (var i = 0; i < 100001; i++) { a.push(i); } a");
    expect(wide.error.message).toContain("result too large (more than 100000 values)");
  });

  it("calibrates line numbers from a probe error when the host reports .line", () => {
    // Pretend to be ExtendScript: errors carry .line. The probe throws at line 3 of its own eval,
    // so a reported 3 means "lines are counted inside the eval'd code" (lineBase 0).
    const script = "var a = 1;\nthrow { message: 'bad', line: 2 };\na";
    const calibrated = vm.createContext({});
    vm.runInContext('Object.defineProperty(TypeError.prototype, "line", { value: 3 })', calibrated);
    const raw = run(script, calibrated);
    expect(raw.error).toEqual({ message: "bad", line: 2, lineBase: 0 });
    expect(toEnvelope(raw, script, 1).error).toEqual({ message: "bad", line: 2, bodyLine: 2 });

    const shifted = vm.createContext({});
    vm.runInContext('Object.defineProperty(TypeError.prototype, "line", { value: 8 })', shifted);
    const raw2 = run(script, shifted);
    expect(raw2.error.lineBase).toBe(5);
    expect(toEnvelope(raw2, script, 1).error).toEqual({ message: "bad", line: 2, bodyLine: null });
  });
});

describe("toEnvelope", () => {
  it("orders the keys ok, error, durationMs, value, logs (logsDropped only when > 0)", () => {
    const ok = toEnvelope({ ok: true, value: 1, logs: ["a"], logsDropped: 0 }, "1", 7);
    expect(Object.keys(ok)).toEqual(["ok", "durationMs", "value", "logs"]);
    expect(ok).toEqual({ ok: true, durationMs: 7, value: 1, logs: ["a"] });

    const dropped = toEnvelope({ logsDropped: 3, logs: [], value: null, ok: true }, "1", 7);
    expect(Object.keys(dropped)).toEqual(["ok", "durationMs", "value", "logs", "logsDropped"]);

    const bad = toEnvelope({ value: null, logs: [], error: { lineBase: 0, line: 2, message: "m" }, ok: false }, "a\nb\nc", 4);
    expect(Object.keys(bad)).toEqual(["ok", "error", "durationMs", "value", "logs"]);
    expect(bad.error).toEqual({ message: "m", line: 2, bodyLine: 2 });
    expect(JSON.stringify(bad)).not.toContain("lineBase");
  });

  it("sets bodyLine only for a calibrated, in-range line", () => {
    const script = "a\nb\nc";
    const at = (line: unknown, lineBase: unknown) =>
      toEnvelope({ ok: false, error: { message: "m", line, lineBase }, value: null, logs: [] }, script, 0).error!.bodyLine;
    expect(at(2, 0)).toBe(2);
    expect(at(3, 0)).toBe(3);
    expect(at(2, 5)).toBeNull();
    expect(at(2, null)).toBeNull();
    expect(at(4, 0)).toBeNull(); // beyond the script's 3 lines
    expect(at(0, 0)).toBeNull();
    expect(at(null, 0)).toBeNull();
  });

  it("counts every line terminator, CRLF once", () => {
    expect(lineCount("a")).toBe(1);
    expect(lineCount(`a\r\nb${LS}c\rd\ne`)).toBe(5);
  });

  it("passes a value that is not envelope-shaped through as ok:true", () => {
    expect(toEnvelope([1, 2], "x", 1)).toEqual({ ok: true, durationMs: 1, value: [1, 2], logs: [] });
    expect(toEnvelope({ a: 1 }, "x", 1)).toEqual({ ok: true, durationMs: 1, value: { a: 1 }, logs: [] });
    expect(toEnvelope(null, "x", 1)).toEqual({ ok: true, durationMs: 1, value: null, logs: [] });
    expect(toEnvelope({ ok: false }, "x", 1).error).toEqual({ message: "script failed without a message", line: null, bodyLine: null });
  });

  it("envelopeResult: ok is a plain result, not ok is isError with the JSON envelope", () => {
    const good = envelopeResult(makeEnvelope({ ok: true, durationMs: 1, value: 2, logs: [] }));
    expect(good.isError).toBeUndefined();
    const fail = envelopeResult(makeEnvelope({ ok: false, error: { message: "m", line: null, bodyLine: null }, durationMs: 1, value: null, logs: [] }));
    expect(fail.isError).toBe(true);
    expect(JSON.parse((fail.content[0] as { text: string }).text)).toMatchObject({ ok: false, error: { message: "m" } });
  });
});

describe("gate and refusal texts", () => {
  const stdio = { remote: false, allowRemote: false };

  it("uses X-01's sentence verbatim for a closed gate, naming the target and the open apps", () => {
    expect(RAW_SCRIPTS_DISABLED_MESSAGE).toBe(
      "Raw scripts are disabled. Set BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1 (or a comma list of app ids, e.g. after_effects,photoshop) in the MCP server env and restart.",
    );
    const off = rawGateState("after_effects", [], ["after_effects"], stdio);
    expect(off.open).toBe(false);
    expect(!off.open && off.reason).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
    expect(!off.open && off.reason).toContain("(This call targets After Effects; currently enabled for: none.)");
    const other = rawGateState("audition", ["after_effects", "photoshop"], ["audition"], stdio);
    expect(!other.open && other.reason).toContain("currently enabled for: after_effects, photoshop.)");
  });

  it("refuses an app whose tools are not enabled, before anything else", () => {
    const r = rawGateState("illustrator", ["illustrator"], ["after_effects"], { remote: true, allowRemote: false });
    expect(r).toEqual({
      open: false,
      reason: "Illustrator tools are not enabled on this server — add illustrator to BRAINFERNO_MCP_APPS (or rerun npm run install-cc) and restart.",
    });
  });

  it("refuses remote sessions unless allowed, after the gate check", () => {
    expect(rawGateState("photoshop", ["photoshop"], ["photoshop"], { remote: true, allowRemote: false })).toEqual({
      open: false,
      reason: REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE,
    });
    expect(rawGateState("photoshop", ["photoshop"], ["photoshop"], { remote: true, allowRemote: true })).toEqual({ open: true });
    expect(rawGateState("photoshop", ["photoshop"], ["photoshop"], stdio)).toEqual({ open: true });
    // Gate closed AND remote: the gate message wins (it is the one the operator must act on first).
    const both = rawGateState("photoshop", [], ["photoshop"], { remote: true, allowRemote: false });
    expect(!both.open && both.reason).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
  });

  it("viaOf names stdio, or http plus the session id's first 8 characters", () => {
    expect(viaOf(undefined)).toBe("stdio");
    expect(viaOf({})).toBe("stdio");
    expect(viaOf({ sessionId: "0123456789abcdef" })).toBe("http:01234567");
  });
});

describe("audit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one line with a hash and length, never the payload; the excerpt goes to debug on a run", () => {
    const audit = vi.spyOn(log, "audit").mockImplementation(() => {});
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const payload = "app.project.item(1).name = 'SECRET-PAYLOAD'";
    auditRawCall({ tool: "cc_eval_script", app: "after_effects", payload, outcome: "run", via: "stdio" });
    const hash = createHash("sha256").update(payload).digest("hex").slice(0, 12);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toBe(`raw-script tool=cc_eval_script app=after_effects sha256=${hash} len=${payload.length} via=stdio outcome=run`);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]![0])).toContain("SECRET-PAYLOAD");

    auditRawCall({ tool: "ps_batch_play", app: "photoshop", payload: "[]", count: 0, outcome: "refused", via: "http:abcd1234" });
    expect(audit.mock.calls[1]![0]).toMatch(/^raw-script tool=ps_batch_play app=photoshop sha256=[0-9a-f]{12} len=2 count=0 via=http:abcd1234 outcome=refused$/);
    expect(debug).toHaveBeenCalledTimes(1); // no excerpt for a refusal
  });

  /** cc_eval_script on a real hub with no panels, and an injected Illustrator lane. */
  async function diagnosticsClient(rawScriptApps: RawScriptApp[]) {
    const hub = new BridgeServer({ port: 0, token: "", insecure: true, defaultTimeoutMs: 1_000, heartbeatIntervalMs: 0 });
    await hub.ready();
    const illustratorCalls: string[] = [];
    const illustratorBridge: AppBridge = {
      appId: "illustrator",
      isConnected: () => true,
      execute: async () => null,
      evaluate: async (script) => {
        illustratorCalls.push(script);
        return vm.runInNewContext(script) as JsonValue;
      },
      close: async () => {},
    };
    const server = new McpServer({ name: "diag", version: "0" });
    registerDiagnosticTools(server, hub, {
      rawScriptApps,
      rawScriptIgnored: [],
      allowRemoteRawScripts: false,
      remote: false,
      illustratorBridge,
      illustratorDelegateEnabled: false,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "diag", version: "0" });
    await Promise.all([c.connect(ct), server.connect(st)]);
    return {
      c,
      illustratorCalls,
      close: async () => {
        await c.close();
        await server.close();
        await hub.close();
      },
    };
  }

  it("audits every cc_eval_script call exactly once, run or refused, without the script text", async () => {
    const audit = vi.spyOn(log, "audit").mockImplementation(() => {});
    const line = /^raw-script tool=cc_eval_script app=after_effects sha256=[0-9a-f]{12} len=\d+ via=stdio outcome=(run|refused)$/;
    const script = "var marker = 'TOP-SECRET-SCRIPT'; marker";

    const off = await diagnosticsClient([]);
    const refused = await off.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script } });
    expect(refused.isError).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatch(line);
    expect(audit.mock.calls[0]![0]).toContain("outcome=refused");
    expect(audit.mock.calls[0]![0]).not.toContain("TOP-SECRET");
    await off.close();

    const on = await diagnosticsClient(["after_effects", "illustrator"]);
    const notConnected = await on.c.callTool({ name: "cc_eval_script", arguments: { appId: "after_effects", script } });
    expect((notConnected.content as { text: string }[])[0]!.text).toMatch(/^No running host connected/);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[1]![0]).toMatch(line);
    expect(audit.mock.calls[1]![0]).toContain("outcome=run");
    expect(audit.mock.calls[1]![0]).not.toContain("TOP-SECRET");

    // Illustrator goes to the injected os-script lane, as the wrapper.
    const ai = await on.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script } });
    expect(on.illustratorCalls).toEqual([rawScriptWrapper(script)]);
    expect(JSON.parse((ai.content as { text: string }[])[0]!.text)).toMatchObject({ ok: true, value: "TOP-SECRET-SCRIPT" });
    expect(audit).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls[2]![0]).toMatch(/app=illustrator .* outcome=run$/);
    await on.close();
  });

  it("is written to stderr even at log level error", async () => {
    setLogLevel("error");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const off = await diagnosticsClient([]);
    await off.c.callTool({ name: "cc_eval_script", arguments: { appId: "audition", script: "1" } });
    await off.close();
    expect(writes.filter((w) => /^\[brainferno-mcp-bridge\] AUDIT raw-script tool=cc_eval_script app=audition .* outcome=refused\n$/.test(w))).toHaveLength(1);
    // The debug excerpt and info lines stay below the threshold.
    expect(writes.some((w) => w.includes(" DEBUG ") || w.includes(" INFO "))).toBe(false);
  });
});
