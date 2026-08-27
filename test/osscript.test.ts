import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JSX_PRELUDE, OsScriptBridge, wrapScript, type ScriptRunner } from "../src/drivers/osscript.js";
import { AppNotConnectedError, EvalTimeoutError, ScriptError } from "../src/bridge/types.js";

/** Pull the result-file path out of a generated .jsx (it is the __acmWrite target). */
function resultPathOf(jsxSource: string): string {
  const m = /__acmWrite\("([^"]+)"/.exec(jsxSource);
  if (!m) throw new Error("no __acmWrite in generated jsx");
  return m[1]!;
}

/** A runner standing in for Illustrator: reads the jsx, writes a canned result. */
function fakeRunner(reply: (jsx: string) => string | undefined): ScriptRunner {
  return async (jsxPath) => {
    const src = readFileSync(jsxPath, "utf8");
    const out = reply(src);
    if (out !== undefined) writeFileSync(resultPathOf(src), out, "utf8");
  };
}

function makeBridge(runner: ScriptRunner, timeoutMs = 1_000): OsScriptBridge {
  return new OsScriptBridge({
    appId: "illustrator",
    defaultTimeoutMs: timeoutMs,
    runner,
    workDir: mkdtempSync(join(tmpdir(), "acm-osscript-")),
  });
}

/** The ES3 rules from CONTRIBUTING.md, as a regex gate. */
export function es3Violations(source: string): string[] {
  const rules: [string, RegExp][] = [
    ["arrow function", /=>/],
    ["const", /\bconst\b/],
    ["let", /\blet\b/],
    ["template literal", /`/],
    ["JSON global", /\bJSON\./],
  ];
  return rules.filter(([, re]) => re.test(source)).map(([name]) => name);
}

describe("wrapScript / prelude", () => {
  it("is ES3-clean", () => {
    expect(es3Violations(JSX_PRELUDE)).toEqual([]);
    expect(es3Violations(wrapScript("(function () { return 1; })()", "/tmp/r.json"))).toEqual([]);
  });

  it("embeds the script and the escaped result path", () => {
    const jsx = wrapScript("(function () { return 42; })()", "C:/tmp/a b/r.json");
    expect(jsx).toContain("var __acmValue = (function () { return 42; })();");
    expect(jsx).toContain('__acmWrite("C:/tmp/a b/r.json"');
  });
});

describe("OsScriptBridge", () => {
  it("resolves with the value the script wrote", async () => {
    const b = makeBridge(fakeRunner(() => JSON.stringify({ ok: true, value: { docs: 2 } })));
    expect(await b.evaluate("(function(){ return 1; })()")).toEqual({ docs: 2 });
  });

  it("hands the script to the runner wrapped in the prelude", async () => {
    let seen = "";
    const b = makeBridge(
      fakeRunner((src) => {
        seen = src;
        return JSON.stringify({ ok: true, value: null });
      }),
    );
    await b.evaluate("(function(){ return app.name; })()");
    expect(seen).toContain("function __acmJson");
    expect(seen).toContain("return app.name;");
  });

  it("turns a script failure into a ScriptError with the line", async () => {
    const b = makeBridge(fakeRunner(() => JSON.stringify({ ok: false, error: { message: "boom", line: 7 } })));
    const err = await b.evaluate("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).message).toBe("boom");
    expect((err as ScriptError).scriptLine).toBe(7);
  });

  it("reports a parse failure when no result file appears", async () => {
    const b = makeBridge(fakeRunner(() => undefined));
    await expect(b.evaluate("this is not es3 (")).rejects.toThrow(/no result/);
  });

  it("maps a runner failure to AppNotConnectedError", async () => {
    const b = makeBridge(async () => {
      throw new Error("COM class not registered");
    });
    await expect(b.evaluate("1")).rejects.toBeInstanceOf(AppNotConnectedError);
  });

  it("times out a runner that never finishes", async () => {
    const b = makeBridge(
      (_, signal) =>
        new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      50,
    );
    await expect(b.evaluate("1")).rejects.toBeInstanceOf(EvalTimeoutError);
  });

  it("runs scripts one at a time, in order", async () => {
    const order: string[] = [];
    const b = makeBridge(async (jsxPath) => {
      const src = readFileSync(jsxPath, "utf8");
      const tag = /TAG_(\w+)/.exec(src)![1]!;
      order.push(`start ${tag}`);
      await new Promise((r) => setTimeout(r, tag === "A" ? 40 : 5));
      order.push(`end ${tag}`);
      writeFileSync(resultPathOf(src), JSON.stringify({ ok: true, value: tag }), "utf8");
    });
    const [a, c] = await Promise.all([b.evaluate("/*TAG_A*/ 1"), b.evaluate("/*TAG_B*/ 2")]);
    expect([a, c]).toEqual(["A", "B"]);
    expect(order).toEqual(["start A", "end A", "start B", "end B"]);
  });

  it("execute() accepts only the generic eval command", async () => {
    const b = makeBridge(fakeRunner(() => JSON.stringify({ ok: true, value: "ok" })));
    expect(await b.execute("eval", { script: "1" })).toBe("ok");
    await expect(b.execute("ps.create_layer", {})).rejects.toBeInstanceOf(ScriptError);
  });

  it("is always reachable (the lane can launch the app)", () => {
    expect(makeBridge(fakeRunner(() => undefined)).isConnected()).toBe(true);
  });
});
