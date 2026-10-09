/**
 * The one raw-script contract shared by every escape-hatch tool (`cc_eval_script`,
 * `ps_batch_play`): the result envelope, the ES3 wrapper that runs a caller's
 * ExtendScript, the gate, the refusal texts and the audit line. Tools import these;
 * none of them re-implements a piece.
 *
 * Error-shape rule (stated in both tool descriptions): a tool error with PLAIN TEXT
 * means nothing was dispatched (gate off, app not enabled, app not connected); a tool
 * error whose text is a JSON ENVELOPE means the script/batch was sent and may have
 * partly run.
 */

import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { APPS, type AppId } from "@brainferno/mcp-bridge-protocol";
import { jsStringLiteral } from "../bridge/script-escape.js";
import { AppDisconnectedError, EvalTimeoutError, ScriptError } from "../bridge/types.js";
import { log } from "../logging.js";
import { errorResult, jsonResult } from "./result.js";

// ---- envelope ---------------------------------------------------------------

export interface RawScriptError {
  message: string;
  /** The line the host reported, as it reported it (null when it gave none). */
  line: number | null;
  /** The line in the caller's script, when the host's numbering could be calibrated; else null. */
  bodyLine: number | null;
}

export interface RawScriptEnvelope {
  ok: boolean;
  error?: RawScriptError;
  /** Server round trip around the call, in ms (includes queue wait behind other calls to the app). */
  durationMs: number;
  value: unknown;
  logs: string[];
  /** Log lines dropped by the caps; present only when > 0. */
  logsDropped?: number;
}

/**
 * Builds an envelope with its keys in a fixed order — ok, error, durationMs, value, logs,
 * logsDropped — so the verdict survives a client truncating a long result.
 */
export function makeEnvelope(parts: {
  ok: boolean;
  error?: RawScriptError;
  durationMs: number;
  value: unknown;
  logs: string[];
  logsDropped?: number;
}): RawScriptEnvelope {
  return {
    ok: parts.ok,
    ...(!parts.ok && parts.error !== undefined ? { error: parts.error } : {}),
    durationMs: parts.durationMs,
    value: parts.value === undefined ? null : parts.value,
    logs: parts.logs,
    ...(parts.logsDropped !== undefined && parts.logsDropped > 0 ? { logsDropped: parts.logsDropped } : {}),
  };
}

/** ok → a normal JSON result; not ok → isError with the envelope as its JSON text (= dispatched). */
export function envelopeResult(env: RawScriptEnvelope): CallToolResult {
  return env.ok ? jsonResult(env) : errorResult(JSON.stringify(env, null, 2));
}

// ---- the ES3 wrapper --------------------------------------------------------

/** jsStringLiteral, then every non-ASCII code unit as \uXXXX: a pure-ASCII ES3 string literal. */
export function asciiLiteral(value: string): string {
  return jsStringLiteral(value).replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Lines in a script, counting every JS line terminator (CRLF once). */
export function lineCount(script: string): number {
  return script.split(/\r\n|[\n\r\u2028\u2029]/).length;
}

/**
 * Everything after the script literal. ES3 only (var, no arrows/let/const/template
 * literals/JSON) and ASCII only; helper functions live inside the one IIFE.
 *
 * - The caller's script runs through a direct eval inside its own inner function: the
 *   completion value of its last statement is the result, its declarations stay local
 *   to the call, and `__log` is reachable by closure.
 * - `__log` keeps at most 200 lines / 20000 characters (each line cut at 2000) and
 *   counts the rest in logsDropped.
 * - On a throw, a second tiny eval calibrates how the host numbers lines inside eval'd
 *   code: lineBase 0 means the reported line is a line of the caller's script. The
 *   server turns that into bodyLine and strips lineBase.
 * - `__plainErr` checks the result is plain data without enumerating any host object:
 *   arrays and Object-constructed objects are walked (depth and node budgets bound it,
 *   so a cycle fails fast); anything else object-typed is refused with its path.
 */
const WRAPPER_TAIL = String.raw`;
  var __logs = [], __logChars = 0, __logDropped = 0;
  function __log(m) {
    var s = String(m);
    if (s.length > 2000) { s = s.substring(0, 2000) + "..."; }
    if (__logs.length >= 200 || __logChars + s.length > 20000) { __logDropped++; return; }
    __logs.push(s);
    __logChars += s.length;
  }
  function __fail(msg, line, base) {
    return { ok: false, error: { message: msg, line: line, lineBase: base }, value: null, logs: __logs, logsDropped: __logDropped };
  }
  function __msg(e) {
    return String(e && e.message !== undefined ? e.message : e);
  }
  function __plainErr(root) {
    var path = [], seen = 0;
    function where() {
      var s = "value";
      for (var i = 0; i < path.length; i++) {
        s += (typeof path[i] === "number") ? "[" + path[i] + "]" : "." + path[i];
      }
      return s;
    }
    function walk(v, depth) {
      var r, i, k, plain, desc;
      seen++;
      if (seen > 100000) { return "result too large (more than 100000 values)"; }
      if (v === null || v === undefined || typeof v !== "object") { return null; }
      if (depth >= 64) { return where() + " is nested more than 64 levels (cycle?)"; }
      if (v instanceof Array) {
        for (i = 0; i < v.length; i++) {
          path.push(i);
          r = walk(v[i], depth + 1);
          if (r !== null) { return r; }
          path.pop();
        }
        return null;
      }
      try { plain = (v.constructor === Object); } catch (x) { plain = false; }
      if (!plain) {
        try { desc = String(v); } catch (y) { desc = "object"; }
        return where() + " is a host/class object (" + desc + ")";
      }
      for (k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) { continue; }
        path.push(k);
        r = walk(v[k], depth + 1);
        if (r !== null) { return r; }
        path.pop();
      }
      return null;
    }
    return walk(root, 0);
  }
  var __v;
  try {
    __v = (function () { return eval(__src); })();
  } catch (e) {
    var __lb = null;
    try { (function () { eval("\n\nnull.x"); })(); } catch (p) { __lb = (p && typeof p.line === "number") ? p.line - 3 : null; }
    return __fail(__msg(e), (e && typeof e.line === "number") ? e.line : null, __lb);
  }
  if (__v === undefined) { __v = null; }
  var __bad = __plainErr(__v);
  if (__bad !== null) {
    return __fail("The script ran, but its result is not plain data: " + __bad + " - copy the fields you need into a plain object or array of strings, numbers and booleans.", null, null);
  }
  return { ok: true, value: __v, logs: __logs, logsDropped: __logDropped };
})()`;

/**
 * Wraps a caller's ExtendScript into one ES3 IIFE expression that returns the raw
 * envelope `{ ok, error?: { message, line, lineBase }, value, logs, logsDropped }`.
 * The script enters only as an ASCII string literal (never spliced as code).
 */
export function rawScriptWrapper(script: string): string {
  return "(function () {\n  var __src = " + asciiLiteral(script) + WRAPPER_TAIL;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Maps what the wrapper returned (through the host's JSON) to the public envelope:
 * key order fixed, `lineBase` turned into `bodyLine` and dropped. A value that is not
 * envelope-shaped passes through as `{ ok: true, value }`.
 */
export function toEnvelope(raw: unknown, script: string, durationMs: number): RawScriptEnvelope {
  if (!isRecord(raw) || typeof raw["ok"] !== "boolean") {
    return makeEnvelope({ ok: true, durationMs, value: raw ?? null, logs: [] });
  }
  const logs = Array.isArray(raw["logs"]) ? raw["logs"].map((l) => String(l)) : [];
  const dropped = typeof raw["logsDropped"] === "number" && raw["logsDropped"] > 0 ? raw["logsDropped"] : 0;
  const value = raw["value"] ?? null;
  if (raw["ok"]) return makeEnvelope({ ok: true, durationMs, value, logs, logsDropped: dropped });

  const e = isRecord(raw["error"]) ? raw["error"] : {};
  const message = typeof e["message"] === "string" && e["message"] !== "" ? e["message"] : "script failed without a message";
  const line = typeof e["line"] === "number" && Number.isInteger(e["line"]) ? e["line"] : null;
  const bodyLine = e["lineBase"] === 0 && line !== null && line >= 1 && line <= lineCount(script) ? line : null;
  return makeEnvelope({ ok: false, error: { message, line, bodyLine }, durationMs, value, logs, logsDropped: dropped });
}

/**
 * The envelope for a call that WAS dispatched but failed outside the wrapper: the host
 * rejected it (ScriptError), it timed out, or the panel went away mid-call. Null for
 * anything else (AppNotConnectedError = not dispatched → plain text via guard()).
 */
export function dispatchedFailure(
  error: unknown,
  durationMs: number,
  what: { noun: string; onScriptError: (message: string) => string },
): RawScriptEnvelope | null {
  let message: string | null = null;
  if (error instanceof ScriptError) message = what.onScriptError(error.message);
  else if (error instanceof EvalTimeoutError) {
    message =
      `timed out after ${error.timeoutMs} ms — ${what.noun} may still be running or have partly run; ` +
      "check the document before re-running";
  } else if (error instanceof AppDisconnectedError) {
    message = `the app disconnected while ${what.noun} ran — it may have partly run; check before re-running`;
  }
  if (message === null) return null;
  return makeEnvelope({ ok: false, error: { message, line: null, bodyLine: null }, durationMs, value: null, logs: [] });
}

// ---- the gate ---------------------------------------------------------------

/** X-01's sentence, verbatim. */
export const RAW_SCRIPTS_DISABLED_MESSAGE =
  "Raw scripts are disabled. Set BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1 (or a comma list of app ids, e.g. " +
  "after_effects,photoshop) in the MCP server env and restart.";

export const REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE =
  "Raw scripts are refused for remote (shared HTTP) sessions. Set BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1 " +
  "in the MCP server env and restart to allow them.";

export function appNotEnabledMessage(app: AppId): string {
  return (
    `${APPS[app].displayName} tools are not enabled on this server — add ${app} to BRAINFERNO_MCP_APPS ` +
    "(or rerun npm run install-cc) and restart."
  );
}

export function rawScriptsDisabledMessage(app: AppId, gate: readonly AppId[]): string {
  const list = gate.length === 0 ? "none" : gate.join(", ");
  return `${RAW_SCRIPTS_DISABLED_MESSAGE} (This call targets ${APPS[app].displayName}; currently enabled for: ${list}.)`;
}

export type RawGateState = { open: true } | { open: false; reason: string };

/**
 * Whether a raw call for `app` may run in this session. Refusals, in precedence order:
 * the app's tools are not enabled on this server; the raw-script gate does not include
 * the app; the session is remote and remote raw scripts are not allowed.
 */
export function rawGateState(
  app: AppId,
  gate: readonly AppId[],
  enabled: readonly AppId[],
  session: { remote: boolean; allowRemote: boolean },
): RawGateState {
  if (!enabled.includes(app)) return { open: false, reason: appNotEnabledMessage(app) };
  if (!gate.includes(app)) return { open: false, reason: rawScriptsDisabledMessage(app, gate) };
  if (session.remote && !session.allowRemote) return { open: false, reason: REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE };
  return { open: true };
}

// ---- audit ------------------------------------------------------------------

/**
 * Exactly one always-on audit line per raw call, run or refused. Records a hash and the
 * length of the payload (the script, or the JSON of the descriptors) — never the payload
 * itself; the first 200 characters go to the debug log on a run.
 */
export function auditRawCall(call: {
  tool: string;
  app: AppId;
  payload: string;
  count?: number;
  outcome: "run" | "refused";
  via: string;
}): void {
  const hash = createHash("sha256").update(call.payload).digest("hex").slice(0, 12);
  const count = call.count === undefined ? "" : ` count=${call.count}`;
  log.audit(
    `raw-script tool=${call.tool} app=${call.app} sha256=${hash} len=${call.payload.length}${count} ` +
      `via=${call.via} outcome=${call.outcome}`,
  );
  if (call.outcome === "run") log.debug(`raw-script ${call.tool} ${call.app} [${hash}]: ${call.payload.slice(0, 200)}`);
}

/**
 * Which transport a call came over, for the audit line: "stdio", or "http:" plus the first
 * 8 characters of the session id (matching http.ts's "remote session xxxxxxxx opened" line).
 */
export function viaOf(extra: { sessionId?: string } | undefined): string {
  const id = extra?.sessionId;
  return id === undefined ? "stdio" : `http:${id.slice(0, 8)}`;
}
