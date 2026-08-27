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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APPS, type AppId } from "../apps.js";
import { jsStringLiteral } from "../bridge/script-escape.js";
import {
  AppNotConnectedError,
  EvalTimeoutError,
  ScriptError,
  type AppBridge,
  type EvalOptions,
  type JsonValue,
} from "../bridge/types.js";
import { log } from "../logging.js";

/** Runs the bootstrap that evaluates `jsxPath` inside the host. Injectable for tests. */
export type ScriptRunner = (jsxPath: string, signal: AbortSignal) => Promise<void>;

export interface OsScriptBridgeOptions {
  appId: AppId;
  defaultTimeoutMs: number;
  /** Override the platform runner (tests, or a custom bootstrap). */
  runner?: ScriptRunner;
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

function spawnRunner(cmd: string, args: string[], signal: AbortSignal, notConnectedHint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const firstLine = stderr.trim().split("\n")[0] ?? "";
      reject(new AppNotConnectedError("illustrator", `${notConnectedHint} (${firstLine || `exit ${code}`})`));
    });
  });
}

/** Windows: PowerShell drives the COM automation server; a running instance is reused. */
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
      "Could not reach Illustrator over COM. Is it installed? Check the winProgId",
    );
  };
}

/** macOS: AppleScript `do javascript`. First run prompts for Automation permission (TCC). */
export function macRunner(appleScriptName: string): ScriptRunner {
  return (path, signal) => {
    const js = `$.evalFile(\\"${jsxPath(path)}\\")`;
    const as = `tell application "${appleScriptName}" to do javascript "${js}"`;
    return spawnRunner(
      "osascript",
      ["-e", as],
      signal,
      "Could not reach Illustrator via AppleScript. Is it installed, and did you allow Automation for this app in System Settings > Privacy & Security?",
    );
  };
}

export function platformRunner(appId: AppId): ScriptRunner {
  const app = APPS[appId];
  if (process.platform === "win32") {
    if (app.winProgId === undefined) throw new Error(`${app.displayName} has no COM ProgID`);
    return windowsRunner(app.winProgId);
  }
  if (process.platform === "darwin") {
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
  private readonly runner: ScriptRunner;
  private readonly workDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OsScriptBridgeOptions) {
    this.appId = options.appId;
    this.runner = options.runner ?? platformRunner(options.appId);
    this.workDir = options.workDir ?? join(tmpdir(), "adobe-cc-mcp", "osscript");
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
    const id = randomUUID();
    const jsx = join(this.workDir, `${id}.jsx`);
    const result = join(this.workDir, `${id}.result.json`);
    await writeFile(jsx, wrapScript(script, jsxPath(result)), "utf8");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await this.runner(jsx, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new EvalTimeoutError(this.appId, timeoutMs);
      if (error instanceof AppNotConnectedError) throw error;
      throw new AppNotConnectedError(
        this.appId,
        `Script runner failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let raw: string;
    try {
      raw = await readFile(result, "utf8");
    } catch {
      throw new ScriptError(this.appId, "The script produced no result — it probably failed to parse (ES3 syntax only).");
    } finally {
      void rm(jsx, { force: true }).catch(() => {});
      void rm(result, { force: true }).catch(() => {});
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
