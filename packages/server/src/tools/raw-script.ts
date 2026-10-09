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
import { AppDisconnectedError, EvalTimeoutError, RunnerExitedError, ScriptError } from "../bridge/types.js";
import { log } from "../logging.js";
import { errorResult, jsonResult } from "./result.js";

// ---- envelope ---------------------------------------------------------------

export interface RawScriptError {
  message: string;
  /** The line the host reported, as it reported it (null when it gave none). */
  line: number | null;
  /**
   * The line in the caller's script that failed; null when the error was raised outside the
   * caller's own text (a $.evalFile'd library, a helper an earlier call left as a global) or the
   * host's numbering cannot be calibrated.
   */
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
 *   counts the rest in logsDropped. The kept lines are always a prefix of what was
 *   logged: once one line is dropped, every later one is too. `__log` never throws (a
 *   value whose String() throws is logged as "[unprintable]").
 * - On a throw, a second tiny eval calibrates how the host numbers lines inside eval'd
 *   code: lineBase 0 means the reported line is a line of the caller's script. The
 *   server turns that into bodyLine and strips lineBase. An error whose `source` (the
 *   text ExtendScript says it happened in) is not the caller's script gets no lineBase.
 * - `__plainErr` checks exactly what the hosts' `__acmJson` will serialize — every key a
 *   plain `for (k in v)` reaches, inherited ones included, function values skipped —
 *   without enumerating any host object: arrays and plain objects are walked (depth and
 *   node budgets bound it, so a cycle fails fast); anything else object-typed is refused
 *   with its path. Plainness ignores an own data key named "constructor".
 * - Data (non-function) properties on Object.prototype are inherited by every object, so the
 *   serializer would write them into every object it serializes — an object value contains
 *   itself and overflows — and the engine persists between calls, so every later call to the
 *   app, typed tools included, would break too. The engine is also shared (other CEP
 *   extensions, startup scripts), so the guard blames only this script: at entry, before the
 *   eval, it snapshots the enumerable keys of Object.prototype and their values in two
 *   parallel arrays (not an object: an object would inherit the very keys it records). Before
 *   any envelope is built (on success, and on every failure path), `__protoLeft` compares:
 *   a data key that is new is deleted; a data key whose value changed is set back to its
 *   snapshot value; members it did not change are left alone. It then re-checks each one and
 *   fails the call naming what it removed, what it restored and what it could not, after the
 *   script's own error if it had one. (`__acmJson` itself stays as it is: host.jsx carries the
 *   same code, and the two must match.)
 */
const WRAPPER_TAIL = String.raw`;
  var __unread = [], __pk = [], __pv = [], __pi;
  function __protoGet(k) {
    try { return Object.prototype[k]; } catch (x) { return __unread; }
  }
  for (__pi in {}) { __pk[__pk.length] = __pi; __pv[__pv.length] = __protoGet(__pi); }
  var __logs = [], __logChars = 0, __logDropped = 0;
  function __log(m) {
    var s;
    try { s = String(m); } catch (x) { s = "[unprintable]"; }
    if (s.length > 2000) { s = s.substring(0, 2000) + "..."; }
    if (__logDropped > 0 || __logs.length >= 200 || __logChars + s.length > 20000) { __logDropped++; return; }
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
      var r, i, k, item, plain, desc;
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
      try {
        if (Object.prototype.hasOwnProperty.call(v, "constructor")) {
          plain = Object.prototype.toString.call(v) === "[object Object]";
        } else {
          plain = (v.constructor === Object);
        }
      } catch (x) { plain = false; }
      if (!plain) {
        try { desc = String(v); } catch (y) { desc = "object"; }
        return where() + " is a host/class object (" + desc + ")";
      }
      for (k in v) {
        item = v[k];
        if (typeof item === "function") { continue; }
        path.push(k);
        r = walk(item, depth + 1);
        if (r !== null) { return r; }
        path.pop();
      }
      return null;
    }
    return walk(root, 0);
  }
  function __same(a, b) {
    return a === b || (a !== a && b !== b);
  }
  function __protoLeft() {
    var now = [], gone = [], back = [], keep = [], hold = [], parts = [], k, v, i, j, at, why;
    for (k in {}) { now[now.length] = k; }
    for (i = 0; i < now.length; i++) {
      k = now[i];
      v = __protoGet(k);
      if (typeof v === "function") { continue; }
      at = -1;
      for (j = 0; j < __pk.length; j++) {
        if (__pk[j] === k) { at = j; break; }
      }
      if (at === -1) {
        try { delete Object.prototype[k]; } catch (x) {}
        if (k in {}) { keep[keep.length] = k; } else { gone[gone.length] = k; }
      } else if (!__same(v, __pv[at])) {
        if (__pv[at] !== __unread) {
          try { Object.prototype[k] = __pv[at]; } catch (y) {}
        }
        if ((k in {}) && __same(__protoGet(k), __pv[at])) { back[back.length] = k; } else { hold[hold.length] = k; }
      }
    }
    if (gone.length + back.length + keep.length + hold.length === 0) { return null; }
    why = " because they break the host's JSON serializer for every later call.";
    if (gone.length > 0) {
      parts[parts.length] = "The script left data properties on Object.prototype (" + gone.join(", ") + "); they were removed" + why;
      why = ".";
    }
    if (back.length > 0) {
      parts[parts.length] = "The script changed data properties that were already on Object.prototype (" + back.join(", ") + "); they were restored to their values from before the call" + why;
    }
    if (keep.length > 0) {
      parts[parts.length] = "The script left data properties on Object.prototype that could not be removed (" + keep.join(", ") + ").";
    }
    if (hold.length > 0) {
      parts[parts.length] = "The script changed data properties on Object.prototype that could not be restored (" + hold.join(", ") + ").";
    }
    if (keep.length + hold.length > 0) {
      parts[parts.length] = "They are still there and break the host's JSON serializer, so later calls to this app may fail until it is restarted.";
    }
    parts[parts.length] = (back.length + hold.length > 0) ? "Do not add or change data properties on Object.prototype." : "Do not add data properties to Object.prototype.";
    return parts.join(" ");
  }
  function __then(msg, more) {
    return more === null ? msg : msg + " " + more;
  }
  var __v, __left;
  try {
    __v = (function () { return eval(__src); })();
  } catch (e) {
    var __lb = null;
    var __own = !(e && typeof e.source === "string") || e.source === __src;
    try { (function () { eval("\n\nnull.x"); })(); } catch (p) { __lb = (p && typeof p.line === "number") ? p.line - 3 : null; }
    __left = __protoLeft();
    return __fail(__then(__msg(e), __left), (e && typeof e.line === "number") ? e.line : null, __own ? __lb : null);
  }
  __left = __protoLeft();
  if (__v === undefined) { __v = null; }
  var __bad = __plainErr(__v);
  if (__bad !== null) {
    return __fail(__then("The script ran, but its result is not plain data: " + __bad + " - copy the fields you need into a plain object or array of strings, numbers and booleans.", __left), null, null);
  }
  if (__left !== null) { return __fail(__left, null, null); }
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
 * rejected it (ScriptError), it timed out, the panel went away mid-call, or the os-script
 * runner failed after the script may have reached the app (an error marked
 * `dispatched === true`, i.e. RunnerExitedError). Null for anything else — a plain
 * AppNotConnectedError means nothing was dispatched → plain text via guard().
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
  } else if (error instanceof RunnerExitedError && error.dispatched === true) {
    message =
      `The script runner failed (${error.runnerOutput}) — ${what.noun} was sent; it may have partly run — ` +
      `check ${APPS[error.appId].displayName} before re-running`;
  }
  if (message === null) return null;
  return makeEnvelope({ ok: false, error: { message, line: null, bodyLine: null }, durationMs, value: null, logs: [] });
}

/**
 * cc_eval_script's text for an Illustrator call that left no result file. The os-script lane
 * says NO_RESULT_MESSAGE ("probably failed to parse"), which is right for the typed ai_* tools
 * but not for a raw script: the wrapper catches the caller's syntax errors and reports them.
 */
export const ILLUSTRATOR_RAW_NO_RESULT_MESSAGE =
  "Illustrator produced no result file — the script may not have run (a modal dialog, or the temp .jsx/result " +
  "file could not be read or written). Syntax errors in your script come back as ok:false with a message, not " +
  "like this — check Illustrator before re-running.";

// ---- the gate ---------------------------------------------------------------

/** X-01's sentence, verbatim. */
export const RAW_SCRIPTS_DISABLED_MESSAGE =
  "Raw scripts are disabled. Set BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1 (or a comma list of app ids, e.g. " +
  "after_effects,photoshop) in the MCP server env and restart.";

export const REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE =
  "Raw scripts are refused for remote (shared HTTP) sessions. Set BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1 " +
  "in the MCP server env and restart to allow them.";

/**
 * BRAINFERNO_MCP_APPS replaces the installer's saved app list rather than adding to it, so the
 * text asks for the full list: "add <app> to it" would leave only that app's tools.
 */
export function appNotEnabledMessage(app: AppId): string {
  const name = APPS[app].displayName;
  return (
    `${name} tools are not enabled on this server — rerun npm run install-cc and pick ${name}, or set ` +
    `BRAINFERNO_MCP_APPS to the full list of apps you want including ${app} (it replaces the installer's ` +
    "choice), then restart."
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
 * The debug excerpt as one printable-ASCII token: JSON-quoted (CR, LF and other control
 * characters escaped), then every remaining non-ASCII character — DEL, NEL, U+2028/U+2029 —
 * as a \uXXXX escape, so a script cannot start a new log line and forge an AUDIT record.
 */
function logExcerpt(payload: string): string {
  return JSON.stringify(payload.slice(0, 200)).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Exactly one always-on audit line per raw call, run or refused. Records a hash and the
 * length of the payload (the script, or the JSON of the descriptors) — never the payload
 * itself; the first 200 characters go to the debug log on a run, escaped onto one line.
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
  if (call.outcome === "run") log.debug(`raw-script ${call.tool} ${call.app} [${hash}]: ${logExcerpt(call.payload)}`);
}

/**
 * Which transport a call came over, for the audit line: "stdio", or "http:" plus the first
 * 8 characters of the session id (matching http.ts's "remote session xxxxxxxx opened" line).
 */
export function viaOf(extra: { sessionId?: string } | undefined): string {
  const id = extra?.sessionId;
  return id === undefined ? "stdio" : `http:${id.slice(0, 8)}`;
}
