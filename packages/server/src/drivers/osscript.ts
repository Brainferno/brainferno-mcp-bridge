/**
 * The os-script lane: drive an Adobe app that has no panel by injecting
 * ExtendScript from outside the process.
 *
 *   Windows: PowerShell -> COM `Illustrator.Application` -> DoJavaScript
 *   macOS:   osascript  -> AppleScript `do javascript`
 *
 * Both runners execute one tiny bootstrap (`$.evalFile(<temp .jsx>)`) so the
 * real script never travels through shell quoting. The script's result comes
 * back through a JSON result file the .jsx writes, not through stdout — return
 * strings from COM/AppleScript are lossy and size-limited.
 *
 * ExtendScript is ES3 with no JSON object, so every script is wrapped in a
 * prelude that ships a small stringifier, catches errors (with the line), and
 * writes the outcome. Illustrator has no "allow scripts to write files"
 * preference, so this works out of the box (unlike After Effects).
 *
 * Calls are serialized: one script at a time per host.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APPS, type AppId } from "@brainferno/mcp-bridge-protocol";
import { jsStringLiteral } from "../bridge/script-escape.js";
import {
  AppNotConnectedError,
  EvalTimeoutError,
  RunnerExitedError,
  ScriptError,
  type AppBridge,
  type EvalOptions,
  type JsonValue,
} from "../bridge/types.js";
import { log } from "../logging.js";

/**
 * Runs the bootstrap that evaluates `jsxPath` inside the host. Injectable for tests.
 *
 * `timeoutMs` is the call's deadline: the server aborts `signal` when it passes. A runner whose
 * transport has a deadline of its own (AppleScript's Apple-event timeout) must set it longer,
 * so the server's deadline is the one that fires.
 *
 * Failure contract: reject with AppNotConnectedError only when the script provably never
 * reached the host; with RunnerExitedError when it may have (see spawnRunner). Anything else
 * a runner throws is treated as "may have been dispatched".
 */
export type ScriptRunner = (jsxPath: string, signal: AbortSignal, timeoutMs: number) => Promise<void>;

/**
 * What a call reports when the host wrote no result file. The typed ai_* tools show it as is;
 * cc_eval_script rewords it, because a raw script's syntax errors come back through its wrapper.
 */
export const NO_RESULT_MESSAGE = "The script produced no result — it probably failed to parse (ES3 syntax only).";

/** The longest explicit `timeoutMs` cc_eval_script accepts (its schema's max); staleTempFileMs builds on it. */
export const MAX_EXPLICIT_TIMEOUT_MS = 30 * 60_000;

/**
 * How old one of the lane's temp files must be before a sweep treats it as a leftover: twice
 * the longest deadline a call on this bridge can get (cc_eval_script's 30-minute cap on an
 * explicit timeoutMs, or the default deadline — `BRAINFERNO_MCP_EVAL_TIMEOUT_MS`, which has no
 * upper bound — when that is longer), plus 5 minutes. Twice, because a call's .jsx can wait in
 * Illustrator behind another call before it is read. It is a margin, not a guarantee: another
 * server sharing the work dir with a longer default deadline, or a script that keeps
 * Illustrator busy well past its own deadline, can outlast it, and a sweep can then remove a
 * .jsx before Illustrator reads it.
 */
export function staleTempFileMs(defaultTimeoutMs: number): number {
  return Math.max(2 * MAX_EXPLICIT_TIMEOUT_MS, 2 * defaultTimeoutMs) + 5 * 60_000;
}

/** The lane's own temp files: `<uuid>.jsx` and `<uuid>.result.json`. Nothing else is swept. */
const TEMP_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jsx|result\.json)$/i;

export interface OsScriptBridgeOptions {
  appId: AppId;
  defaultTimeoutMs: number;
  /** Override the platform runner (tests, or a custom bootstrap). */
  runner?: ScriptRunner;
  /**
   * Which application the platform runner drives: an AppleScript name, a bundle id, or an
   * absolute `.app` path on macOS; a COM ProgID on Windows. "" / undefined = the app's default.
   */
  target?: string;
  /** Where temp .jsx/.json files go. Defaults to the OS temp dir. */
  workDir?: string;
}

/**
 * ES3-safe prelude: a JSON stringifier and the result-file writer. Kept as a
 * raw string so the backslashes below reach ExtendScript unchanged. No arrow
 * functions, no const/let, no template literals, no JSON global — on purpose.
 */
export const JSX_PRELUDE = String.raw`
function __acmStr(s) {
  s = String(s); var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 32 || code === 0x2028 || code === 0x2029) out += '\\u' + ('000' + code.toString(16)).slice(-4);
    else out += c;
  }
  return '"' + out + '"';
}
function __acmJson(v) {
  var t = typeof v;
  if (v === null || v === undefined) return "null";
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return __acmStr(v);
  if (t === "function") return "null";
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(__acmJson(v[i]));
    return "[" + a.join(",") + "]";
  }
  if (t === "object") {
    var o = [];
    for (var k in v) {
      var x = v[k];
      if (typeof x === "function") continue;
      o.push(__acmStr(k) + ":" + __acmJson(x));
    }
    return "{" + o.join(",") + "}";
  }
  return __acmStr(String(v));
}
function __acmWrite(path, text) {
  var f = new File(path);
  f.encoding = "UTF-8";
  f.open("w");
  f.write(text);
  f.close();
}
`;

/** Wraps a user script (an expression, typically an IIFE) into a self-reporting .jsx. */
export function wrapScript(script: string, resultPath: string): string {
  return (
    JSX_PRELUDE +
    "\nvar __acmResult;\n" +
    "try {\n" +
    "  var __acmValue = " +
    script +
    ";\n" +
    "  __acmResult = { ok: true, value: __acmValue === undefined ? null : __acmValue };\n" +
    "} catch (e) {\n" +
    "  __acmResult = { ok: false, error: { message: String(e && e.message ? e.message : e), line: e && e.line ? e.line : null } };\n" +
    "}\n" +
    "__acmWrite(" +
    jsStringLiteral(resultPath) +
    ", __acmJson(__acmResult));\n"
  );
}

/** Forward-slash path for use inside a JS/ExtendScript string on any OS. */
export function jsxPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * How one platform's runner reports a failure: the hint in its error message (what the typed
 * ai_* tools show), and which failures provably happened before the script reached the app.
 */
export interface RunnerProfile {
  notConnectedHint: string;
  /** True only when the runner's first stderr line proves nothing was dispatched. */
  beforeDispatch: (firstLine: string) => boolean;
}

/** Windows (powershell.exe -> COM). */
export const WINDOWS_RUNNER_PROFILE: RunnerProfile = {
  notConnectedHint: "Could not reach Illustrator over COM. Is it installed? Check the winProgId",
  // `New-Object -ComObject` failed — class not registered (80040154 / REGDB_E_CLASSNOTREG), the
  // server could not start: DoJavaScript never ran. A failure inside DoJavaScript counts as
  // dispatched whatever its text says (it can quote the script's own error message).
  beforeDispatch: (line) =>
    !/DoJavaScript/i.test(line) &&
    /^New-Object\s*:|80040154|REGDB_E_CLASSNOTREG|Class not registered|Cannot create ActiveX component|Retrieving the COM class factory/i.test(
      line,
    ),
};

/** macOS (osascript -> AppleScript `do javascript`). */
export const MAC_RUNNER_PROFILE: RunnerProfile = {
  notConnectedHint:
    "Could not reach Illustrator via AppleScript. Is it installed, and did you allow Automation for this app in System Settings > Privacy & Security?",
  // osascript ends the line with the AppleScript error number. Before dispatch: -600 app not
  // running, -1728 app not found, -1743 Automation not allowed, -10814 no app with that bundle id.
  // Anything else — -1712 (Apple-event timed out), -609 (connection lost) — may come after the
  // script started.
  beforeDispatch: (line) => /\((?:-600|-1728|-1743|-10814)\)\s*$/.test(line),
};

/**
 * The error for a runner process that exited non-zero: AppNotConnectedError when its output
 * proves the script never reached the app, otherwise RunnerExitedError (when in doubt,
 * dispatched). The message is the same either way, so the typed ai_* tools read as before.
 */
export function runnerExitError(code: number | null, stderr: string, profile: RunnerProfile): AppNotConnectedError {
  const firstLine = stderr.trim().split("\n")[0] ?? "";
  const output = firstLine || `exit ${code}`;
  const hint = `${profile.notConnectedHint} (${output})`;
  return firstLine !== "" && profile.beforeDispatch(firstLine)
    ? new AppNotConnectedError("illustrator", hint)
    : new RunnerExitedError("illustrator", hint, output.trim());
}

/** Spawns a runner process; resolves on exit 0, rejects with the classified error otherwise. */
export function spawnRunner(cmd: string, args: string[], signal: AbortSignal, profile: RunnerProfile): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    // The runner could not be started (ENOENT, EACCES): nothing was sent. An abort also lands
    // here; runOne turns that into a timeout before looking at the error.
    child.on("error", (error) => reject(new AppNotConnectedError("illustrator", `Script runner failed: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(runnerExitError(code, stderr, profile));
    });
  });
}

/**
 * Windows: PowerShell drives the COM automation server; a running instance is reused. A COM
 * call has no deadline of its own, so the server's abort is the only one (`timeoutMs` unused).
 */
export function windowsRunner(progId: string): ScriptRunner {
  return (path, signal) => {
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      `$ai = New-Object -ComObject ${progId}`,
      `$null = $ai.DoJavaScript('$.evalFile(${JSON.stringify(jsxPath(path))})')`,
    ].join("; ");
    return spawnRunner(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      signal,
      WINDOWS_RUNNER_PROFILE,
    );
  };
}

/**
 * How an app is addressed in AppleScript. A bare name is what Adobe documents, but on a Mac
 * with both the release and the Beta installed BOTH bundles are named `Adobe Illustrator.app`,
 * so a name resolves to whichever LaunchServices picks — in practice the one already running,
 * which flips mid-session. A bundle id or an absolute `.app` path is unambiguous, so the target
 * may be given as any of the three (config `illustratorApp` / `BRAINFERNO_MCP_ILLUSTRATOR_APP`).
 */
export function appleScriptTarget(target: string): string {
  const t = target.trim();
  if (t.startsWith("/") || /\.app\/?$/i.test(t)) return `application "${t.replace(/\/$/, "")}"`;
  // A bundle id: dotted, no spaces or slashes (com.adobe.illustrator, com.adobe.illustratorBeta).
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(t)) return `application id "${t}"`;
  return `application "${t}"`;
}

/**
 * The AppleScript the macOS runner sends, one line per `-e`. AppleScript gives up waiting for
 * an Apple-event reply after 120 s by default (-1712) while the app keeps running the script,
 * so `do javascript` runs inside a timeout 5 s longer than the call's own deadline: the
 * server's deadline always fires first.
 */
export function appleScriptLines(target: string, path: string, timeoutMs: number): string[] {
  const js = `$.evalFile(\\"${jsxPath(path)}\\")`;
  return [
    `with timeout of ${Math.ceil(timeoutMs / 1000) + 5} seconds`,
    `tell ${appleScriptTarget(target)} to do javascript "${js}"`,
    "end timeout",
  ];
}

/** macOS: AppleScript `do javascript`. First run prompts for Automation permission (TCC). */
export function macRunner(appleScriptName: string): ScriptRunner {
  return (path, signal, timeoutMs) =>
    spawnRunner(
      "osascript",
      appleScriptLines(appleScriptName, path, timeoutMs).flatMap((line) => ["-e", line]),
      signal,
      MAC_RUNNER_PROFILE,
    );
}

export function platformRunner(appId: AppId, target?: string): ScriptRunner {
  const app = APPS[appId];
  if (process.platform === "win32") {
    if (target !== undefined && target !== "") return windowsRunner(target);
    if (app.winProgId === undefined) throw new Error(`${app.displayName} has no COM ProgID`);
    return windowsRunner(app.winProgId);
  }
  if (process.platform === "darwin") {
    if (target !== undefined && target !== "") return macRunner(target);
    if (app.appleScriptName === undefined) throw new Error(`${app.displayName} has no AppleScript name`);
    return macRunner(app.appleScriptName);
  }
  return () => Promise.reject(new AppNotConnectedError(appId, "The os-script lane needs macOS or Windows."));
}

interface ResultFile {
  ok: boolean;
  value?: unknown;
  error?: { message?: string; line?: number | null };
}

export class OsScriptBridge implements AppBridge {
  readonly appId: AppId;
  /** The stale-file sweep started when the bridge was built (never rejects; awaitable by tests). */
  readonly initialSweep: Promise<void>;
  private readonly runner: ScriptRunner;
  private readonly workDir: string;
  /** staleTempFileMs for this bridge's default deadline. */
  private readonly staleAfterMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OsScriptBridgeOptions) {
    this.appId = options.appId;
    this.runner = options.runner ?? platformRunner(options.appId, options.target);
    this.workDir = options.workDir ?? join(tmpdir(), "brainferno-mcp-bridge", "osscript");
    this.staleAfterMs = staleTempFileMs(options.defaultTimeoutMs);
    // Files a previous server left when it was killed mid-call.
    this.initialSweep = this.sweepStaleFiles();
  }

  /**
   * Best effort, never throws: removes the lane's temp files (`<uuid>.jsx`, `<uuid>.result.json`)
   * older than staleTempFileMs(defaultTimeoutMs) — the files of a server killed mid-call, or a
   * result written by a script that outlived its call's timeout. Several servers may share the
   * work dir, so only old files go; anything else in the directory is left alone.
   */
  private async sweepStaleFiles(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.workDir);
    } catch {
      return; // not created yet, or unreadable
    }
    const cutoff = Date.now() - this.staleAfterMs;
    await Promise.all(
      names
        .filter((name) => TEMP_FILE_NAME.test(name))
        .map(async (name) => {
          const path = join(this.workDir, name);
          try {
            const info = await stat(path);
            if (info.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
          } catch {
            // Gone already (another server swept it) or not ours to touch.
          }
        }),
    );
  }

  /** The lane can launch the app itself, so it is always "reachable". */
  isConnected(): boolean {
    return true;
  }

  execute(name: string, params?: JsonValue, options?: EvalOptions): Promise<JsonValue> {
    if (name !== "eval") {
      return Promise.reject(
        new ScriptError(this.appId, `The os-script lane only runs "eval" commands (got "${name}")`),
      );
    }
    const script =
      params !== null && typeof params === "object" && !Array.isArray(params) ? params["script"] : undefined;
    if (typeof script !== "string") return Promise.reject(new ScriptError(this.appId, "eval needs params.script"));
    return this.evaluate(script, options);
  }

  evaluate(script: string, options?: EvalOptions): Promise<JsonValue> {
    const run = this.queue.catch(() => {}).then(() => this.runOne(script, options));
    this.queue = run.catch(() => {});
    return run;
  }

  private async runOne(script: string, options?: EvalOptions): Promise<JsonValue> {
    const timeoutMs =
      options?.timeoutMs ?? (options?.timeoutClass === "fast" ? 10_000 : this.options.defaultTimeoutMs);
    await mkdir(this.workDir, { recursive: true });
    await this.sweepStaleFiles();
    const id = randomUUID();
    const jsx = join(this.workDir, `${id}.jsx`);
    const result = join(this.workDir, `${id}.result.json`);

    let raw: string;
    // Both files are removed when the call ends, whatever the outcome (the .jsx holds the
    // caller's script text). What this cannot cover — a result written by a script that
    // outlives its timeout, or the files of a server killed mid-call — is removed by the
    // sweep on a later call (or the next start) once it is older than staleAfterMs.
    try {
      await writeFile(jsx, wrapScript(script, jsxPath(result)), "utf8");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await this.runner(jsx, controller.signal, timeoutMs);
      } catch (error) {
        if (controller.signal.aborted) throw new EvalTimeoutError(this.appId, timeoutMs);
        // The runner classified it: not dispatched (AppNotConnectedError) or dispatched
        // (RunnerExitedError, a subclass).
        if (error instanceof AppNotConnectedError) throw error;
        // Anything else says nothing about whether the script reached the app: dispatched.
        const output = error instanceof Error ? error.message : String(error);
        throw new RunnerExitedError(this.appId, `Script runner failed: ${output}`, output);
      } finally {
        clearTimeout(timer);
      }

      try {
        raw = await readFile(result, "utf8");
      } catch {
        throw new ScriptError(this.appId, NO_RESULT_MESSAGE);
      }
    } finally {
      await Promise.all([rm(jsx, { force: true }).catch(() => {}), rm(result, { force: true }).catch(() => {})]);
    }

    let parsed: ResultFile;
    try {
      parsed = JSON.parse(raw) as ResultFile;
    } catch {
      throw new ScriptError(this.appId, "The script wrote an unreadable result.");
    }
    if (!parsed.ok) {
      throw new ScriptError(
        this.appId,
        parsed.error?.message ?? "script failed without a message",
        parsed.error?.line ?? undefined,
      );
    }
    return (parsed.value ?? null) as JsonValue;
  }

  async close(): Promise<void> {
    log.debug(`os-script bridge for ${this.appId} closed`);
  }
}
