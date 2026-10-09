import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JSX_PRELUDE,
  MAC_RUNNER_PROFILE,
  NO_RESULT_MESSAGE,
  OsScriptBridge,
  WINDOWS_RUNNER_PROFILE,
  appleScriptLines,
  appleScriptTarget,
  platformRunner,
  runnerExitError,
  spawnRunner,
  staleTempFileMs,
  wrapScript,
  type ScriptRunner,
} from "../src/drivers/osscript.js";
import { AppNotConnectedError, EvalTimeoutError, RunnerExitedError, ScriptError } from "../src/bridge/types.js";
import { es3Violations } from "./es3.js";

/** Every work dir a test here creates; each is removed after its test. */
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
    workDir: tempDir("acm-osscript-"),
  });
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
    // The typed ai_* tools keep this exact text (cc_eval_script rewords it for raw scripts).
    expect(NO_RESULT_MESSAGE).toBe("The script produced no result — it probably failed to parse (ES3 syntax only).");
    const err = await b.evaluate("1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).message).toBe(NO_RESULT_MESSAGE);
  });

  it("maps a runner failure to AppNotConnectedError", async () => {
    const b = makeBridge(async () => {
      throw new Error("COM class not registered");
    });
    await expect(b.evaluate("1")).rejects.toBeInstanceOf(AppNotConnectedError);
    // Same text as before the dispatched/not-dispatched split, so typed tools read the same.
    await expect(b.evaluate("1")).rejects.toThrow(
      'No running host connected for "illustrator". Script runner failed: COM class not registered',
    );
  });

  it("treats an unexplained runner failure as dispatched (the script may have run)", async () => {
    // A custom runner's own error says nothing about whether Illustrator got the script:
    // when in doubt, dispatched — the safe direction for a raw script.
    const b = makeBridge(async () => {
      throw new Error("pipe closed");
    });
    const err = await b.evaluate("1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerExitedError);
    expect(err).toBeInstanceOf(AppNotConnectedError);
    expect((err as RunnerExitedError).dispatched).toBe(true);
    expect((err as RunnerExitedError).runnerOutput).toBe("pipe closed");
  });

  it("passes the runner's own classification through unchanged", async () => {
    const pre = new AppNotConnectedError("illustrator", "Could not reach Illustrator over COM. (class not registered)");
    const post = new RunnerExitedError("illustrator", "Could not reach Illustrator over COM. (RPC gone)", "RPC gone");
    expect(await makeBridge(async () => Promise.reject(pre)).evaluate("1").catch((e: unknown) => e)).toBe(pre);
    expect(await makeBridge(async () => Promise.reject(post)).evaluate("1").catch((e: unknown) => e)).toBe(post);
  });

  it("hands the runner the call's deadline", async () => {
    const seen: (number | undefined)[] = [];
    const b = makeBridge(async (jsxPath, _signal, timeoutMs) => {
      seen.push(timeoutMs);
      writeFileSync(resultPathOf(readFileSync(jsxPath, "utf8")), JSON.stringify({ ok: true, value: 1 }), "utf8");
    }, 1_234);
    await b.evaluate("1");
    await b.evaluate("1", { timeoutMs: 4_321 });
    await b.evaluate("1", { timeoutClass: "fast" });
    expect(seen).toEqual([1_234, 4_321, 10_000]);
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

describe("OsScriptBridge temp-file cleanup", () => {
  /** A bridge on its own empty work dir; `runner` sees the .jsx path first so a test can check it existed. */
  function bridgeIn(runner: ScriptRunner, timeoutMs = 1_000) {
    const workDir = tempDir("acm-osscript-clean-");
    return { workDir, bridge: new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: timeoutMs, runner, workDir }) };
  }

  it("removes the script when the runner fails", async () => {
    let sawJsx = false;
    const { workDir, bridge } = bridgeIn(async (jsxPath) => {
      sawJsx = existsSync(jsxPath);
      throw new Error("COM class not registered");
    });
    await expect(bridge.evaluate("1")).rejects.toBeInstanceOf(AppNotConnectedError);
    expect(sawJsx).toBe(true);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("removes the script when the runner never finishes (timeout)", async () => {
    let sawJsx = false;
    const { workDir, bridge } = bridgeIn(
      (jsxPath, signal) =>
        new Promise<void>((_, reject) => {
          sawJsx = existsSync(jsxPath);
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      50,
    );
    await expect(bridge.evaluate("1")).rejects.toBeInstanceOf(EvalTimeoutError);
    expect(sawJsx).toBe(true);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("removes both files after a run that produced a result, and after one that produced none", async () => {
    const ok = bridgeIn(fakeRunner(() => JSON.stringify({ ok: true, value: 1 })));
    expect(await ok.bridge.evaluate("1")).toBe(1);
    expect(readdirSync(ok.workDir)).toEqual([]);

    const none = bridgeIn(fakeRunner(() => undefined));
    await expect(none.bridge.evaluate("1")).rejects.toBeInstanceOf(ScriptError);
    expect(readdirSync(none.workDir)).toEqual([]);
  });
});

describe("OsScriptBridge stale temp-file sweep", () => {
  const MINUTE = 60_000;

  /** Writes one call's pair of files (`<uuid>.jsx`, `<uuid>.result.json`) aged `ageMs`. */
  function seed(dir: string, ageMs: number): string[] {
    const id = randomUUID();
    const names = [`${id}.jsx`, `${id}.result.json`];
    const when = (Date.now() - ageMs) / 1000;
    for (const n of names) {
      writeFileSync(join(dir, n), "left behind", "utf8");
      utimesSync(join(dir, n), when, when);
    }
    return names;
  }

  it("removes files older than the cutoff (65 minutes by default) when the bridge is built, and nothing else", async () => {
    const dir = tempDir("acm-osscript-sweep-");
    seed(dir, 2 * 60 * MINUTE); // a killed server's script, or a result written after a timeout
    seed(dir, 66 * MINUTE);
    const keep = [...seed(dir, 5 * MINUTE), ...seed(dir, 64 * MINUTE)]; // maybe another server's call in flight
    for (const foreign of ["notes.jsx", "readme.txt"]) {
      writeFileSync(join(dir, foreign), "", "utf8");
      utimesSync(join(dir, foreign), 0, 0);
    }
    const b = new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: 1_000, runner: fakeRunner(() => undefined), workDir: dir });
    await b.initialSweep;
    expect(readdirSync(dir).sort()).toEqual([...keep, "notes.jsx", "readme.txt"].sort());
  });

  it("scales the cutoff with a long default deadline: twice the deadline, plus 5 minutes", async () => {
    // BRAINFERNO_MCP_EVAL_TIMEOUT_MS has no upper bound. A call's .jsx can wait in Illustrator
    // behind another call before it is read, so a 70-minute-old file may still be in flight.
    const longDir = tempDir("acm-osscript-sweep-");
    const inFlight = seed(longDir, 70 * MINUTE);
    seed(longDir, 4 * 60 * MINUTE + 10 * MINUTE); // past 2 x 2 h + 5 min
    const long = new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: 2 * 60 * MINUTE, runner: fakeRunner(() => undefined), workDir: longDir });
    await long.initialSweep;
    expect(readdirSync(longDir).sort()).toEqual([...inFlight].sort());

    // The default deadline (30 s) keeps the 65-minute floor (twice the 30-minute cap on an
    // explicit timeoutMs, plus 5 minutes), so the same 70-minute-old file goes.
    const defaultDir = tempDir("acm-osscript-sweep-");
    seed(defaultDir, 70 * MINUTE);
    const fallback = new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: 30_000, runner: fakeRunner(() => undefined), workDir: defaultDir });
    await fallback.initialSweep;
    expect(readdirSync(defaultDir)).toEqual([]);

    expect(staleTempFileMs(30_000)).toBe(65 * MINUTE);
    expect(staleTempFileMs(2 * 60 * MINUTE)).toBe(4 * 60 * MINUTE + 5 * MINUTE);
  });

  it("sweeps again at the start of every call", async () => {
    const dir = tempDir("acm-osscript-sweep-");
    const b = new OsScriptBridge({
      appId: "illustrator",
      defaultTimeoutMs: 1_000,
      runner: fakeRunner(() => JSON.stringify({ ok: true, value: 1 })),
      workDir: dir,
    });
    await b.initialSweep;
    seed(dir, 3 * 60 * MINUTE); // e.g. a late result from a call that timed out earlier in this process
    const keep = seed(dir, MINUTE);
    expect(await b.evaluate("1")).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([...keep].sort());
  });

  it("never throws, even when the work dir does not exist", async () => {
    const b = new OsScriptBridge({
      appId: "illustrator",
      defaultTimeoutMs: 1_000,
      runner: fakeRunner(() => undefined),
      workDir: join(tmpdir(), `acm-osscript-missing-${randomUUID()}`),
    });
    await expect(b.initialSweep).resolves.toBeUndefined();
  });
});

describe("runner failure classification (dispatched or not)", () => {
  // What powershell.exe prints when New-Object cannot create the COM object: nothing reached Illustrator.
  const PS_CLASS_NOT_REGISTERED = [
    "New-Object : Retrieving the COM class factory for component with CLSID {00000000-0000-0000-0000-000000000000} failed due to the following error: 80040154 Class not registered (Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG)).",
    "At line:1 char:34",
    "+ $ErrorActionPreference = 'Stop'; $ai = New-Object -ComObject Illustrator.Application; $null = $ai.DoJavaScript('$.evalFile(\"C:/t/x.jsx\")')",
    "    + CategoryInfo          : ResourceUnavailable: (:) [New-Object], COMException",
    "    + FullyQualifiedErrorId : NoCOMClassIdentified,Microsoft.PowerShell.Commands.NewObjectCommand",
  ].join("\r\n");
  // DoJavaScript was called, then Illustrator went away (crash, app.quit()): the script was sent.
  const PS_RPC_GONE = [
    'Exception calling "DoJavaScript" with "1" argument(s): "The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)"',
    "At line:1 char:89",
    "+ ... $null = $ai.DoJavaScript('$.evalFile(\"C:/t/x.jsx\")')",
    "    + CategoryInfo          : NotSpecified: (:) [], MethodInvocationException",
    "    + FullyQualifiedErrorId : COMException",
  ].join("\r\n");
  // DoJavaScript ran and failed with text that mentions a pre-dispatch phrase: still dispatched.
  const PS_SCRIPT_TEXT_LOOKALIKE = 'Exception calling "DoJavaScript" with "1" argument(s): "Error 21: Class not registered 80040154"';

  const firstLine = (stderr: string) => stderr.trim().split("\n")[0]!;
  const notDispatched: [string, string, typeof WINDOWS_RUNNER_PROFILE][] = [
    ["COM class not registered", PS_CLASS_NOT_REGISTERED, WINDOWS_RUNNER_PROFILE],
    ["COM server failed to start", "New-Object : Retrieving the COM class factory for component with CLSID {6E8B5D3A} failed due to the following error: 80080005 Server execution failed", WINDOWS_RUNNER_PROFILE],
    ["AppleScript: app not running", "0:61: execution error: Adobe Illustrator got an error: Application isn't running. (-600)", MAC_RUNNER_PROFILE],
    ["AppleScript: no such app", '0:42: execution error: Can\'t get application id "com.adobe.illustratorBeta". (-1728)', MAC_RUNNER_PROFILE],
    ["AppleScript: Automation not allowed", "0:61: execution error: Not authorized to send Apple events to Adobe Illustrator. (-1743)", MAC_RUNNER_PROFILE],
    ["AppleScript: no app with that bundle id", '0:42: execution error: Can\'t get application id "com.adobe.nothing". (-10814)', MAC_RUNNER_PROFILE],
  ];
  const dispatched: [string, string, typeof WINDOWS_RUNNER_PROFILE][] = [
    ["COM call failed after DoJavaScript started", PS_RPC_GONE, WINDOWS_RUNNER_PROFILE],
    ["script text that looks like a pre-dispatch error", PS_SCRIPT_TEXT_LOOKALIKE, WINDOWS_RUNNER_PROFILE],
    ["AppleEvent timed out", "0:61: execution error: Adobe Illustrator got an error: AppleEvent timed out. (-1712)", MAC_RUNNER_PROFILE],
    ["AppleScript: connection lost mid-call", "0:61: execution error: Adobe Illustrator got an error: Connection is invalid. (-609)", MAC_RUNNER_PROFILE],
    ["no output at all", "", WINDOWS_RUNNER_PROFILE],
  ];

  it.each(notDispatched)("%s -> AppNotConnectedError (nothing reached Illustrator), message unchanged", (_name, stderr, profile) => {
    const err = runnerExitError(1, stderr, profile);
    expect(err).toBeInstanceOf(AppNotConnectedError);
    expect(err).not.toBeInstanceOf(RunnerExitedError);
    expect((err as { dispatched?: unknown }).dispatched).toBeUndefined();
    expect(err.message).toBe(`No running host connected for "illustrator". ${profile.notConnectedHint} (${firstLine(stderr)})`);
  });

  it.each(dispatched)("%s -> RunnerExitedError (dispatched), message unchanged", (_name, stderr, profile) => {
    const err = runnerExitError(1, stderr, profile);
    expect(err).toBeInstanceOf(RunnerExitedError);
    expect(err).toBeInstanceOf(AppNotConnectedError); // typed tools and guard() still see AppNotConnectedError
    expect((err as RunnerExitedError).dispatched).toBe(true);
    const out = firstLine(stderr) || "exit 1";
    expect((err as RunnerExitedError).runnerOutput).toBe(out.trim());
    expect(err.message).toBe(`No running host connected for "illustrator". ${profile.notConnectedHint} (${out})`);
  });

  it("classifies a real child process's exit through spawnRunner", async () => {
    // exitCode, not process.exit(): stderr to a pipe is async on POSIX and exit() could cut it off.
    const exitWith = (stderr: string) => ["-e", `process.exitCode = 1; process.stderr.write(${JSON.stringify(stderr)});`];
    const signal = new AbortController().signal;

    const pre = await spawnRunner(process.execPath, exitWith(PS_CLASS_NOT_REGISTERED), signal, WINDOWS_RUNNER_PROFILE).catch((e: unknown) => e);
    expect(pre).toBeInstanceOf(AppNotConnectedError);
    expect(pre).not.toBeInstanceOf(RunnerExitedError);

    const post = await spawnRunner(process.execPath, exitWith(PS_RPC_GONE), signal, WINDOWS_RUNNER_PROFILE).catch((e: unknown) => e);
    expect(post).toBeInstanceOf(RunnerExitedError);
    expect((post as RunnerExitedError).dispatched).toBe(true);

    await expect(spawnRunner(process.execPath, ["-e", "process.exit(0)"], signal, MAC_RUNNER_PROFILE)).resolves.toBeUndefined();

    // The runner binary itself is missing (spawn "error" event): nothing was sent.
    const missing = await spawnRunner(join(tmpdir(), `no-such-runner-${randomUUID()}.exe`), [], signal, WINDOWS_RUNNER_PROFILE).catch(
      (e: unknown) => e,
    );
    expect(missing).toBeInstanceOf(AppNotConnectedError);
    expect(missing).not.toBeInstanceOf(RunnerExitedError);
    expect((missing as Error).message).toMatch(/^No running host connected for "illustrator"\. Script runner failed: spawn .*ENOENT$/);
  });
});

describe("AppleScript target (macOS)", () => {
  it("addresses a bundle id by id, a path by path, and anything else by name", () => {
    // Both the release and the Beta ship a bundle named "Adobe Illustrator.app": a bare name
    // resolves to whichever LaunchServices picks, so the id/path forms are the unambiguous ones.
    expect(appleScriptTarget("com.adobe.illustrator")).toBe('application id "com.adobe.illustrator"');
    expect(appleScriptTarget("com.adobe.illustratorBeta")).toBe('application id "com.adobe.illustratorBeta"');
    expect(appleScriptTarget("/Applications/Adobe Illustrator (Beta)/Adobe Illustrator.app")).toBe('application "/Applications/Adobe Illustrator (Beta)/Adobe Illustrator.app"');
    expect(appleScriptTarget("/Applications/Adobe Illustrator 2026/Adobe Illustrator.app/")).toBe('application "/Applications/Adobe Illustrator 2026/Adobe Illustrator.app"');
    expect(appleScriptTarget("Adobe Illustrator")).toBe('application "Adobe Illustrator"');
    expect(appleScriptTarget("  Adobe Illustrator  ")).toBe('application "Adobe Illustrator"');
  });

  it("wraps do javascript in a timeout a little longer than the call's own deadline", () => {
    // AppleScript's default Apple-event timeout is 120 s; without this, a long script fails at
    // 120 s with -1712 and the server's own deadline never fires.
    const lines = appleScriptLines("com.adobe.illustrator", "/tmp/a b/x.jsx", 600_000);
    expect(lines.join("\n")).toContain("with timeout of");
    expect(lines).toEqual([
      "with timeout of 605 seconds",
      'tell application id "com.adobe.illustrator" to do javascript "$.evalFile(\\"/tmp/a b/x.jsx\\")"',
      "end timeout",
    ]);
    expect(appleScriptLines("Adobe Illustrator", "/t/x.jsx", 1_500)[0]).toBe("with timeout of 7 seconds");
  });

  it("builds a runner on this platform, with and without an explicit target", () => {
    // Windows takes a COM ProgID, macOS an AppleScript target; both accept the override.
    expect(typeof platformRunner("illustrator")).toBe("function");
    expect(typeof platformRunner("illustrator", "com.adobe.illustratorBeta")).toBe("function");
    expect(typeof platformRunner("illustrator", "")).toBe("function");
  });
});
