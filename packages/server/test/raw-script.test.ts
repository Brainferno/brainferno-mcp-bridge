import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeServer } from "../src/bridge/socket.js";
import { AppNotConnectedError, RunnerExitedError, type AppBridge, type JsonValue } from "../src/bridge/types.js";
import type { RawScriptApp } from "../src/config.js";
import { JSX_PRELUDE } from "../src/drivers/osscript.js";
import { getLogLevel, log, setLogLevel } from "../src/logging.js";
import { registerDiagnosticTools } from "../src/tools/diagnostics.js";
import {
  RAW_SCRIPTS_DISABLED_MESSAGE,
  REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE,
  asciiLiteral,
  auditRawCall,
  dispatchedFailure,
  envelopeResult,
  lineCount,
  makeEnvelope,
  rawGateState,
  rawScriptWrapper,
  toEnvelope,
  viaOf,
} from "../src/tools/raw-script.js";
import { hostContext, hostEval } from "./host-vm.js";
import { es3Violations } from "./es3.js";

// Built from char codes so this source file stays ASCII (U+2028 is a line terminator in source).
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x85);
const E_ACUTE = String.fromCharCode(0xe9);
const EMOJI = String.fromCodePoint(0x1f600);
/** Anything a log reader might treat as a line break. */
const LINE_BREAK = new RegExp("\\r\\n|[\\r\\n" + LS + PS + NEL + "]");

/**
 * Run the wrapper the way a host would and return what crosses the wire: the hosts' own
 * ES3 serializer (__acmJson), not V8's JSON.stringify — it also writes inherited keys.
 */
function run(script: string, context: vm.Context = hostContext()): Record<string, any> {
  return hostEval(rawScriptWrapper(script), context);
}

/**
 * A host whose errors carry `.line` the way ExtendScript's do — derived from V8's stack, so it
 * is the line where the error really happened inside the eval'd code — plus `shift`, to stand
 * in for a host that numbers eval'd lines differently.
 */
function lineReportingHost(shift = 0): vm.Context {
  const ctx = hostContext();
  vm.runInContext(
    String.raw`Object.defineProperty(Error.prototype, "line", { configurable: true, get: function () {
      var m = /<anonymous>:(\d+):\d+\)?\s*$/.exec(String(this.stack).split("\n")[1] || "");
      return m ? Number(m[1]) + ${shift} : undefined;
    } })`,
    ctx,
  );
  return ctx;
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

/** Collects every process.stderr write (restored by vi.restoreAllMocks). */
function captureStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
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

describe("the node:vm host harness", () => {
  it("serializes with the same __acmStr/__acmJson both hosts run (os-script prelude and CEP host.jsx)", () => {
    const hostJsx = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "panel-cep", "host.jsx"), "utf8");
    const fn = (src: string, name: string) => {
      const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src.replace(/\r\n/g, "\n"));
      expect(m, name).not.toBeNull();
      return m![0];
    };
    for (const name of ["__acmStr", "__acmJson"]) expect(fn(hostJsx, name), name).toBe(fn(JSX_PRELUDE, name));
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
    const ctx = hostContext();
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

  it("keeps a prefix of the log: once a line is dropped, every later line is dropped too", () => {
    // Nine 2000-character lines (18000), then a line that would cross 20000, then short ones that
    // would still fit. Keeping those would hide the gap: the failure line would vanish from
    // between two later lines.
    const r = run(
      'for (var i = 0; i < 9; i++) { __log(new Array(2001).join("p")); }' +
        ' __log("step 9 FAILED " + new Array(2001).join("f")); __log("step 10 ok"); __log("done"); 1',
    );
    expect(r.ok).toBe(true);
    expect(r.logs).toHaveLength(9);
    expect(r.logs.every((l: string) => l.length === 2000)).toBe(true);
    expect(r.logsDropped).toBe(3);
  });

  it("__log never throws into the caller's script", () => {
    const r = run('__log({ toString: function () { throw new Error("no"); } }); __log("after"); 1');
    expect(r).toEqual({ ok: true, value: 1, logs: ["[unprintable]", "after"], logsDropped: 0 });
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

  it("checks inherited keys too, because the host serializer writes them", () => {
    // The ES3 class pattern: an instance whose prototype is an object literal looks plain
    // (constructor === Object) and for-in reaches the prototype's keys.
    const r = run(
      "function Comp() { this.id = 1; }" +
        " function Exporter() { this.name = 'x'; }" +
        " Exporter.prototype = { project: new Comp(), run: function () {} };" +
        " new Exporter()",
    );
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("value.project is a host/class object");
    expect(r.value).toBeNull();

    // Inherited data that is plain goes through as the serializer writes it; functions are skipped.
    const ok = run("function Preset() {} Preset.prototype = { kind: 'preset', sizes: [1, 2], run: function () {} }; new Preset()");
    expect(ok).toEqual({ ok: true, value: { kind: "preset", sizes: [1, 2] }, logs: [], logsDropped: 0 });
  });

  it("fails an inherited cycle fast instead of overflowing the host serializer", () => {
    const t0 = Date.now();
    const r = run("var proto = {}; function C() {} C.prototype = proto; var o = new C(); proto.me = o; o");
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("value.me.me");
    expect(r.error.message).toContain("nested more than 64 levels (cycle?)");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  describe("data left on Object.prototype", () => {
    // Every object inherits such a key, so the hosts' serializer (a plain for-in) writes it into
    // every object it serializes — an object value contains itself, and it overflows. The engine
    // persists between calls, so without the guard every later call to the app would fail too.
    const leftOn = (keys: string) =>
      `The script left data properties on Object.prototype (${keys}); they were removed because they break ` +
      "the host's JSON serializer for every later call. Do not add data properties to Object.prototype.";

    it("removes it and fails the call, so later calls in the same host serialize again", () => {
      const ctx = hostContext();
      expect(run('Object.prototype.defaults = { units: "px" }; 1', ctx)).toEqual({
        ok: false,
        error: { message: leftOn("defaults"), line: null, lineBase: null },
        value: null,
        logs: [],
        logsDropped: 0,
      });
      expect(vm.runInContext("'defaults' in {}", ctx)).toBe(false);
      // The next raw call, and a typed tool's own envelope, go through the same serializer.
      expect(run("1 + 1", ctx)).toEqual({ ok: true, value: 2, logs: [], logsDropped: 0 });
      expect(vm.runInContext("__acmJson({ ok: true, value: { n: 1 } })", ctx)).toBe('{"ok":true,"value":{"n":1}}');
    });

    it("is caught with an object result too, instead of being reported as a cycle", () => {
      const r = run("Object.prototype.leak = {}; ({ a: 1 })");
      expect(r.ok).toBe(false);
      expect(r.error.message).toBe(leftOn("leak"));
      expect(r.value).toBeNull();
    });

    it("keeps the script's own error first and appends the sentence", () => {
      const own = run("null.boom").error.message as string;
      const thrown = run("Object.prototype.junk = { x: 1 };\nnull.boom");
      expect(thrown.ok).toBe(false);
      expect(thrown.error.message).toBe(`${own} ${leftOn("junk")}`);

      // A result that is not plain data is the script's failure too; every key is named.
      const both = run("Object.prototype.a = 1; Object.prototype.b = 'x'; new Date(0)");
      expect(both.error.message).toMatch(/^The script ran, but its result is not plain data: value is a host\/class object /);
      expect(both.error.message.endsWith(` ${leftOn("a, b")}`)).toBe(true);
    });

    it("leaves a function on Object.prototype alone (the serializer skips functions)", () => {
      const ctx = hostContext();
      expect(run("Object.prototype.helper = function () { return 3; }; ({ n: ({}).helper() })", ctx)).toEqual({
        ok: true,
        value: { n: 3 },
        logs: [],
        logsDropped: 0,
      });
      expect(vm.runInContext("typeof ({}).helper", ctx)).toBe("function");
    });

    // The engine is shared: other CEP extensions and startup scripts may have put members on
    // Object.prototype before the call. The guard compares against a snapshot taken before the
    // script ran, so it blames and touches only what this script added or changed.
    const restored = (keys: string) =>
      `The script changed data properties that were already on Object.prototype (${keys}); they were restored to ` +
      "their values from before the call because they break the host's JSON serializer for every later call. " +
      "Do not add or change data properties on Object.prototype.";
    const stillThere =
      "They are still there and break the host's JSON serializer, so later calls to this app may fail until it is restarted.";

    it("leaves members other code put there before the call alone", () => {
      const ctx = hostContext();
      vm.runInContext("Object.prototype.extFlag = true; Object.prototype.extNaN = NaN;", ctx);
      // The host's serializer still writes them into every object (extNaN as null): that is the
      // host's behaviour without the guard too, and not this script's doing.
      expect(run("1 + 1", ctx)).toEqual({ ok: true, value: 2, logs: [], logsDropped: 0, extFlag: true, extNaN: null });
      expect(vm.runInContext("Object.prototype.extFlag", ctx)).toBe(true);

      // A key the script adds is still caught, and only that key is named and removed.
      const added = run("Object.prototype.mine = { a: 1 }; 0", ctx);
      expect(added.ok).toBe(false);
      expect(added.error.message).toBe(leftOn("mine"));
      expect(vm.runInContext("'mine' in {}", ctx)).toBe(false);
      expect(vm.runInContext("Object.prototype.extFlag", ctx)).toBe(true);
    });

    it("restores a pre-existing data member the script changed, and fails naming it", () => {
      const ctx = hostContext();
      vm.runInContext("Object.prototype.extMode = 'fast'; Object.prototype.extFlag = true;", ctx);
      const r = run("Object.prototype.extMode = { mine: 1 }; 1", ctx);
      expect(r.ok).toBe(false);
      expect(r.error.message).toBe(restored("extMode"));
      expect(vm.runInContext("Object.prototype.extMode", ctx)).toBe("fast");
      expect(vm.runInContext("Object.prototype.extFlag", ctx)).toBe(true);

      // A change and an addition in one call: each is named for what was done to it.
      const both = run("Object.prototype.extFlag = false; Object.prototype.mine = 1; 1", ctx);
      expect(both.error.message).toBe(
        "The script left data properties on Object.prototype (mine); they were removed because they break the " +
          "host's JSON serializer for every later call. The script changed data properties that were already on " +
          "Object.prototype (extFlag); they were restored to their values from before the call. Do not add or " +
          "change data properties on Object.prototype.",
      );
      expect(vm.runInContext("[Object.prototype.extFlag, 'mine' in {}].join()", ctx)).toBe("true,false");

      // Next call: nothing changed, nothing named.
      expect(run("1 + 1", ctx)).toMatchObject({ ok: true, value: 2 });
    });

    it("does not fail an unrelated script over a member it cannot delete, and never claims a removal it did not make", () => {
      const ctx = hostContext();
      vm.runInContext(
        'Object.defineProperty(Object.prototype, "sealed", { value: 1, enumerable: true, configurable: false, writable: false })',
        ctx,
      );
      expect(run("1 + 1", ctx)).toEqual({ ok: true, value: 2, logs: [], logsDropped: 0, sealed: 1 });

      // A key this script adds that cannot be deleted is named as still there, not as removed.
      const pinned = run(
        'Object.defineProperty(Object.prototype, "pinned", { value: 2, enumerable: true, configurable: false }); 1',
        ctx,
      );
      expect(pinned.ok).toBe(false);
      expect(pinned.error.message).toBe(
        `The script left data properties on Object.prototype that could not be removed (pinned). ${stillThere} ` +
          "Do not add data properties to Object.prototype.",
      );
      expect(pinned.error.message).not.toContain("were removed");
      expect(vm.runInContext("'pinned' in {}", ctx)).toBe(true);
      // It is now part of the snapshot: the next call is not blamed for it.
      expect(run("1 + 1", ctx)).toMatchObject({ ok: true, value: 2 });

      // A pre-existing member the script changed and made read-only is named as not restored.
      vm.runInContext("Object.prototype.extMode = 'fast'", ctx);
      const held = run('Object.defineProperty(Object.prototype, "extMode", { value: "slow", writable: false }); 1', ctx);
      expect(held.error.message).toBe(
        `The script changed data properties on Object.prototype that could not be restored (extMode). ${stillThere} ` +
          "Do not add or change data properties on Object.prototype.",
      );
      expect(held.error.message).not.toContain("were restored");
      expect(vm.runInContext("Object.prototype.extMode", ctx)).toBe("slow");
    });
  });

  it("accepts plain data that has its own 'constructor' key", () => {
    expect(run('({ constructor: "x", name: "a" })')).toEqual({ ok: true, value: { constructor: "x", name: "a" }, logs: [], logsDropped: 0 });
    const words = run('var m = {}; m["constructor"] = 1; m["main"] = 2; m');
    expect(words.ok).toBe(true);
    expect(words.value).toEqual({ constructor: 1, main: 2 });
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

  it("calibrates line numbers from a probe that really throws on its own line 3", () => {
    // The host reports the line where the error really happened (from V8's stack), so this
    // fails if the probe's text and the offset the wrapper subtracts ever disagree.
    const script = "var a = 1;\nnull.boom;\na";
    const raw = run(script, lineReportingHost());
    expect(raw.error).toMatchObject({ line: 2, lineBase: 0 });
    expect(toEnvelope(raw, script, 1).error).toMatchObject({ line: 2, bodyLine: 2 });

    // A host that numbers eval'd lines differently: the probe sees the shift, bodyLine is withheld.
    const raw2 = run(script, lineReportingHost(5));
    expect(raw2.error).toMatchObject({ line: 7, lineBase: 5 });
    expect(toEnvelope(raw2, script, 1).error).toMatchObject({ line: 7, bodyLine: null });
  });

  it("gives a bodyLine only for an error raised in the caller's own text", () => {
    // ExtendScript errors carry `source`, the text the error happened in. An error from other
    // code (a $.evalFile'd library, a helper a previous call left as a global) has its line
    // counted in that other text, so it must not be mapped onto the caller's script.
    const own = run('var a = 1;\nthrow { message: "mine", line: 2, source: __src };', lineReportingHost());
    expect(own.error).toEqual({ message: "mine", line: 2, lineBase: 0 });

    const script = 'var a = 1;\nthrow { message: "lib", line: 2, source: "function lib() {\\n  oops();\\n}" };';
    const other = run(script, lineReportingHost());
    expect(other.error).toEqual({ message: "lib", line: 2, lineBase: null });
    expect(toEnvelope(other, script, 1).error).toEqual({ message: "lib", line: 2, bodyLine: null });
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

  it("dispatchedFailure: a runner that failed after the script was sent gives the 'may have partly run' envelope", () => {
    const out = "0:61: execution error: Adobe Illustrator got an error: AppleEvent timed out. (-1712)";
    const what = { noun: "the script", onScriptError: (m: string) => m };
    const env = dispatchedFailure(new RunnerExitedError("illustrator", `Could not reach Illustrator via AppleScript. (${out})`, out), 12, what);
    expect(env).toEqual({
      ok: false,
      error: {
        message: `The script runner failed (${out}) — the script was sent; it may have partly run — check Illustrator before re-running`,
        line: null,
        bodyLine: null,
      },
      durationMs: 12,
      value: null,
      logs: [],
    });
    // Not dispatched (the runner never reached Illustrator): left to guard(), which answers in plain text.
    expect(dispatchedFailure(new AppNotConnectedError("illustrator", "Could not reach Illustrator over COM."), 1, what)).toBeNull();
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
    // BRAINFERNO_MCP_APPS replaces the installer's list, so "add illustrator to it" would wipe
    // every other app's tools; the text says to set the full list.
    expect(r).toEqual({
      open: false,
      reason:
        "Illustrator tools are not enabled on this server — rerun npm run install-cc and pick Illustrator, or set " +
        "BRAINFERNO_MCP_APPS to the full list of apps you want including illustrator (it replaces the installer's " +
        "choice), then restart.",
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
  // The log level is module-global: put it back so no later test inherits "error" or "debug".
  let savedLevel: ReturnType<typeof getLogLevel>;
  beforeEach(() => {
    savedLevel = getLogLevel();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel(savedLevel);
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

  it("escapes the debug excerpt, so a script cannot forge a log line", () => {
    setLogLevel("debug");
    const writes = captureStderr();
    const forged =
      "1;\n[brainferno-mcp-bridge] AUDIT raw-script tool=cc_eval_script app=after_effects sha256=000000000000 len=1 " +
      "via=stdio outcome=refused\r\n2;" + LS + "[brainferno-mcp-bridge] AUDIT forged again" + PS + NEL + "end";
    auditRawCall({ tool: "cc_eval_script", app: "after_effects", payload: forged, outcome: "run", via: "stdio" });

    const debugWrites = writes.filter((w) => w.startsWith("[brainferno-mcp-bridge] DEBUG "));
    expect(debugWrites).toHaveLength(1);
    // Exactly one line: no CR, LF, NEL or line/paragraph separator before the final newline.
    expect(debugWrites[0]!.endsWith("\n")).toBe(true);
    expect(LINE_BREAK.test(debugWrites[0]!.slice(0, -1))).toBe(false);
    expect(debugWrites[0]).toContain("outcome=refused"); // still readable, just escaped
    // And only the genuine AUDIT line starts a line.
    const lines = writes.join("").split(LINE_BREAK);
    expect(lines.filter((l) => l.startsWith("[brainferno-mcp-bridge] AUDIT"))).toEqual([
      expect.stringMatching(/^\[brainferno-mcp-bridge\] AUDIT raw-script tool=cc_eval_script app=after_effects sha256=[0-9a-f]{12} len=\d+ via=stdio outcome=run$/),
    ]);
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
        return hostEval(script) as JsonValue;
      },
      close: async () => {},
    };
    const server = new McpServer({ name: "diag", version: "0" });
    registerDiagnosticTools(server, hub, {
      enabledApps: ["after_effects", "premiere", "photoshop", "illustrator", "audition"],
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
    const writes = captureStderr();
    const off = await diagnosticsClient([]);
    await off.c.callTool({ name: "cc_eval_script", arguments: { appId: "audition", script: "1" } });
    await off.close();
    expect(writes.filter((w) => /^\[brainferno-mcp-bridge\] AUDIT raw-script tool=cc_eval_script app=audition .* outcome=refused\n$/.test(w))).toHaveLength(1);
    // Info lines stay below the threshold.
    expect(writes.some((w) => w.includes(" DEBUG ") || w.includes(" INFO "))).toBe(false);
  });

  it("a call that runs, at log level error, writes its audit line and never the script text", async () => {
    // A refusal never logs the excerpt, so only a call that really runs can show where the
    // excerpt goes: it must stay at debug, below an "error" threshold.
    setLogLevel("error");
    const writes = captureStderr();
    const on = await diagnosticsClient(["illustrator"]);
    const script = "var marker = 'RUN-PATH-SECRET'; marker";
    const r = await on.c.callTool({ name: "cc_eval_script", arguments: { appId: "illustrator", script } });
    await on.close();
    expect(on.illustratorCalls).toEqual([rawScriptWrapper(script)]); // it really ran
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, value: "RUN-PATH-SECRET" });
    expect(writes.filter((w) => /^\[brainferno-mcp-bridge\] AUDIT raw-script tool=cc_eval_script app=illustrator .* outcome=run\n$/.test(w))).toHaveLength(1);
    expect(writes.some((w) => w.includes("RUN-PATH-SECRET"))).toBe(false);
    expect(writes.some((w) => w.includes(" DEBUG "))).toBe(false);
  });
});
