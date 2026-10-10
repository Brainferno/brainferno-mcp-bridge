/**
 * Redaction and caps for text an error echoes back to the client: tool arguments, lines of a
 * generated script, host messages (AE-16). App-neutral.
 *
 * README promises that keys and tokens never appear in error messages. Two levels:
 *  - `redactKnown` (R1-R3) for project-derived text (host messages, notes, suggestions):
 *    the configured secrets, Bearer credentials and Illustrator keys.
 *  - `redact` (R1-R4) for echoed arguments and code excerpts: also any long opaque run that
 *    mixes letters and digits and is not a path segment.
 * Redaction always runs on the full text before any cut or reflow (oneLine), so neither leaves a
 * fragment of a secret that would no longer match. Never redact by argument name (`keys` is a real
 * argument).
 */

import { jsStringLiteral } from "../bridge/script-escape.js";

export const ECHO_LIMITS = { string: 80, array: 5, depth: 3, total: 300 } as const;
export const EXCERPT_LIMITS = { literal: 80, line: 120 } as const;
/** Code points of host message kept in an error paragraph. */
export const MESSAGE_LIMIT = 1500;

const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";
let secrets: string[] = [];

/** C0 and C1 control characters (tab, line feed, VT, FF, NEL, ESC, CSI, …) and U+2028/U+2029. */
const CONTROL_CLASS = "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]";

export interface RedactionOptions {
  /**
   * The length (UTF-16 units) at which a host cuts the names it quotes (After Effects' __q:
   * AE_NAME_CUT). A secret longer than that is also registered by its first `cut` units, in every
   * form, so a secret used as a project item name cannot leak its prefix where the host cut it.
   */
  readonly cut?: number;
}

/**
 * Process-wide exact-match secrets (bridge token, httpToken, Illustrator key), set once in
 * buildRuntime like setPreviewMode. Short values (< 8) are ignored. Each secret is registered in
 * every form it can take in error text: raw; jsStringLiteral's and JSON's inner text (a secret
 * holding `"`, `\` or a control character is still found where text was escaped); and blanked, the
 * way a host's name quoting writes it (`"` and `\` escaped, every control character a space).
 */
export function setRedactionSecrets(values: readonly (string | undefined)[], options: RedactionOptions = {}): void {
  const all = new Set<string>();
  const add = (v: string): void => {
    if (v.length < MIN_SECRET_LENGTH) return;
    all.add(v);
    all.add(jsStringLiteral(v).slice(1, -1));
    all.add(JSON.stringify(v).slice(1, -1));
    all.add(blanked(v));
  };
  for (const v of values) {
    if (typeof v !== "string") continue;
    add(v);
    if (options.cut !== undefined && v.length >= MIN_SECRET_LENGTH && v.length > options.cut) add(v.slice(0, options.cut));
  }
  secrets = [...all].sort((a, b) => b.length - a.length);
}

const CONTROL_CHAR = new RegExp(CONTROL_CLASS, "g");

/** A value as a host's name quoting writes it (After Effects' __q): `"` and `\` escaped, every control character a space. */
function blanked(v: string): string {
  return v.replace(/["\\]/g, "\\$&").replace(CONTROL_CHAR, " ");
}

/** R1: every configured secret and its escaped forms, longest first. */
function redactSecrets(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

/** R2: a credential-shaped Bearer value (the token68 set, at least 16 characters). */
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g;
/** R3: an Illustrator MCP key. */
const ILLUSTRATOR_KEY = /ilst_[A-Za-z0-9_-]{16,}/g;
/** R4: a long opaque run. */
const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/g;

/** R1-R3: for project-derived text (host messages, notes, suggestion names). */
export function redactKnown(text: string): string {
  return redactSecrets(text).replace(BEARER, `Bearer ${REDACTED}`).replace(ILLUSTRATOR_KEY, REDACTED);
}

/** R1-R4: for echoed arguments and code excerpts. */
export function redact(text: string): string {
  return redactKnown(text).replace(OPAQUE_RUN, (run: string, offset: number, whole: string) => {
    if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) return run;
    const before = whole.charAt(offset - 1);
    const after = whole.charAt(offset + run.length);
    const pathSegment = before === "/" || before === "\\" || after === "/" || after === "\\";
    return pathSegment ? run : REDACTED;
  });
}

/** A run of control characters with the whitespace around it. */
const CONTROL_RUN = new RegExp(`\\s*${CONTROL_CLASS}+\\s*`, "g");
/** Bidi embeddings, overrides and isolates: they reorder how the text after them is shown. */
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * One paragraph: every line break and every other control character (tab, VT, FF, NEL, ESC, CSI,
 * U+2028, U+2029, any C0 or C1), with the whitespace around it, becomes one space, and bidi
 * overrides are dropped, so text a host or a project supplied cannot start a new line, drive a
 * terminal or reorder what follows it. Redact before calling this: it changes the text.
 */
export function oneLine(text: string): string {
  return text.replace(CONTROL_RUN, " ").replace(BIDI_CONTROL, "");
}

/** Cut to `max` code points; a cut text ends "…(+N chars)" (N code points dropped). */
export function capCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : `${cps.slice(0, max).join("")}…(+${cps.length - max} chars)`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function echoValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return jsStringLiteral(capCodePoints(redact(value), ECHO_LIMITS.string));
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        if (depth > ECHO_LIMITS.depth) return "[…]";
        const shown = value.slice(0, ECHO_LIMITS.array).map((v) => echoValue(v, depth + 1));
        if (value.length > ECHO_LIMITS.array) shown.push(`…(+${value.length - ECHO_LIMITS.array} more)`);
        return `[${shown.join(", ")}]`;
      }
      if (depth > ECHO_LIMITS.depth) return "{…}";
      const parts: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        parts.push(`${IDENTIFIER.test(k) ? k : jsStringLiteral(k)}: ${echoValue(v, depth + 1)}`);
      }
      return `{${parts.join(", ")}}`;
    }
    default:
      return value === undefined ? "null" : jsStringLiteral(capCodePoints(redact(String(value)), ECHO_LIMITS.string));
  }
}

/**
 * One-line echo of a tool's arguments (E1-E6): strings redacted (R1-R4), cut at 80 code points and
 * escaped; numbers/booleans/null as JSON; arrays show 5 items; containers below depth 3 collapse;
 * undefined keys are skipped; the whole echo is cut at 300 code points.
 */
export function echoArgs(args: unknown): string {
  return capCodePoints(echoValue(args, 1), ECHO_LIMITS.total);
}

const LITERAL = /"(?:[^"\\]|\\.)*"/g;
const SIMPLE_DECODE: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };

/** The value of a double-quoted literal written with jsStringLiteral's escape set (any other `\c` reads as c). */
function decodeLiteral(literal: string): string {
  const inner = literal.slice(1, -1);
  return inner.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_m, e: string) => {
    if (e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    return SIMPLE_DECODE[e] ?? e;
  });
}

function excerptLiteral(literal: string): string {
  const value = redact(decodeLiteral(literal));
  const cps = Array.from(value);
  if (cps.length <= EXCERPT_LIMITS.literal) return jsStringLiteral(value);
  return `${jsStringLiteral(`${cps.slice(0, EXCERPT_LIMITS.literal).join("")}…`)}(+${cps.length - EXCERPT_LIMITS.literal} chars)`;
}

/**
 * One line of generated script, safe to show (X1-X5): each double-quoted literal is decoded,
 * redacted (R1-R4), cut at 80 code points and re-encoded; the code between literals is
 * redacted; the rebuilt line is cut at 120 code points and kept on one line.
 */
export function excerptLine(code: string): string {
  const line = code.trim();
  let out = "";
  let last = 0;
  for (const m of line.matchAll(LITERAL)) {
    out += redact(line.slice(last, m.index)) + excerptLiteral(m[0]);
    last = m.index + m[0].length;
  }
  out += redact(line.slice(last));
  return oneLine(capCodePoints(out, EXCERPT_LIMITS.line));
}
