/**
 * Redaction and caps for text an error echoes back to the client: tool arguments, lines of a
 * generated script, host messages (AE-16). App-neutral.
 *
 * README promises that the server never writes keys or tokens into an error message itself, and
 * that the typed After Effects tools' script errors (and the After Effects steps of jobs and
 * pipelines) remove them from the host's message, the echoed arguments and the quoted code (so
 * does any app's UNKNOWN_COMMAND text from its panel); other apps' host text is passed on
 * unchanged. Two levels:
 *  - `redactKnown` (R1-R3) for project-derived text (host messages, notes, suggestions):
 *    the configured secrets (also where the host cut a name inside one), Bearer credentials and
 *    Illustrator keys.
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
/** Every form of every secret, and of a long secret's cut prefix: what R1 replaces, longest first. */
let secrets: string[] = [];
/** Every form of every whole secret: what the tail of a name the host cut is checked against. */
let secretForms: string[] = [];
/** How the host cuts the names it quotes; null when the caller gave no cut length. */
let nameCut: { readonly length: number; readonly mark: string } | null = null;

/** C0 and C1 control characters (tab, line feed, VT, FF, NEL, ESC, CSI, …) and U+2028/U+2029. */
const CONTROL_CLASS = "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]";

export interface RedactionOptions {
  /**
   * The length (UTF-16 units) at which a host cuts the names it quotes (After Effects' __q:
   * AE_NAME_CUT). With it, a secret longer than that is also registered by its first `cut` units,
   * in every form (a name that is the secret, cut); and in a quoted name the host cut — exactly
   * `cut` units, then `mark` — the longest tail of at least 8 units that starts a secret is
   * redacted (a name in which other text comes before the secret, so the cut falls inside it, or
   * a short secret that straddles the cut). Names of any other length are left alone.
   */
  readonly cut?: number;
  /** What the host appends to a name it cut (After Effects' __q: AE_CUT_MARK). Defaults to "...". */
  readonly mark?: string;
}

/**
 * Process-wide exact-match secrets (bridge token, httpToken, Illustrator key), set once in
 * buildRuntime like setPreviewMode. Short values (< 8) are ignored. Each secret is registered in
 * every form it can take in error text: raw; jsStringLiteral's and JSON's inner text (a secret
 * holding `"`, `\` or a control character is still found where text was escaped); blanked, the way
 * a host's name quoting writes it (`"` and `\` escaped, every control character a space); and that
 * quoting decoded again (every control character a space, `"` and `\` raw), the name a "did you
 * mean" list reads back from the host's list.
 */
export function setRedactionSecrets(values: readonly (string | undefined)[], options: RedactionOptions = {}): void {
  const all = new Set<string>();
  const whole = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string" || v.length < MIN_SECRET_LENGTH) continue;
    for (const f of forms(v)) {
      all.add(f);
      whole.add(f);
    }
    if (options.cut !== undefined && options.cut >= MIN_SECRET_LENGTH && v.length > options.cut) {
      for (const f of forms(v.slice(0, options.cut))) all.add(f);
    }
  }
  secrets = [...all].sort((a, b) => b.length - a.length);
  secretForms = [...whole];
  nameCut = options.cut === undefined ? null : { length: options.cut, mark: options.mark ?? "..." };
}

const CONTROL_CHAR = new RegExp(CONTROL_CLASS, "g");

/** Every form a value can take in error text (see setRedactionSecrets). */
function forms(v: string): string[] {
  const spaced = v.replace(CONTROL_CHAR, " ");
  return [v, jsStringLiteral(v).slice(1, -1), JSON.stringify(v).slice(1, -1), spaced.replace(/["\\]/g, "\\$&"), spaced];
}

/** R1: every configured secret and its escaped forms, longest first. */
function redactSecrets(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

/** A double-quoted span (its inner text in group 1), and one unit of that text: an escape pair or one UTF-16 unit. */
const QUOTED = /"((?:[^"\\]|\\.)*)"/g;
const QUOTED_UNIT = /\\[\s\S]|[\s\S]/g;

/**
 * R1 where the host cut a name: a quoted span whose decoded text is exactly the cut length and
 * then the cut mark keeps only the start of a secret that came after other text in the name, so
 * neither the secret nor its registered prefix matches. The longest tail of the kept text (at least
 * 8 units) that starts any form of a secret is replaced; the text before it and the mark stay.
 */
function redactCutTails(text: string): string {
  const cut = nameCut;
  if (cut === null || secretForms.length === 0) return text;
  return text.replace(QUOTED, (span: string, inner: string) => {
    const units = inner.match(QUOTED_UNIT) ?? [];
    if (units.length !== cut.length + cut.mark.length) return span;
    const decoded = units.map((u) => (u.length === 2 ? u.charAt(1) : u));
    if (decoded.slice(cut.length).join("") !== cut.mark) return span;
    for (let k = 0; k + MIN_SECRET_LENGTH <= cut.length; k++) {
      const tail = decoded.slice(k, cut.length).join("");
      const written = units.slice(k, cut.length).join("");
      if (secretForms.some((f) => f.startsWith(tail) || f.startsWith(written))) {
        return `"${units.slice(0, k).join("")}${REDACTED}${units.slice(cut.length).join("")}"`;
      }
    }
    return span;
  });
}

/** R2: a credential-shaped Bearer value (the token68 set, at least 16 characters). */
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g;
/** R3: an Illustrator MCP key. */
const ILLUSTRATOR_KEY = /ilst_[A-Za-z0-9_-]{16,}/g;
/** R4: a long opaque run. */
const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/g;

/** R1-R3: for project-derived text (host messages, notes, suggestion names). */
export function redactKnown(text: string): string {
  return redactCutTails(redactSecrets(text)).replace(BEARER, `Bearer ${REDACTED}`).replace(ILLUSTRATOR_KEY, REDACTED);
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
 * Drops bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069), so supplied text
 * cannot reorder what an error paragraph shows after it. Marks (U+200E/U+200F) and letters stay.
 */
export function stripBidi(text: string): string {
  return text.replace(BIDI_CONTROL, "");
}

/**
 * One paragraph: every line break and every other control character (tab, VT, FF, NEL, ESC, CSI,
 * U+2028, U+2029, any C0 or C1), with the whitespace around it, becomes one space, and bidi
 * overrides are dropped (stripBidi), so text a host or a project supplied cannot start a new line,
 * drive a terminal or reorder what follows it. Redact before calling this: it changes the text.
 */
export function oneLine(text: string): string {
  return stripBidi(text.replace(CONTROL_RUN, " "));
}

/** Cut to `max` code points; a cut text ends "…(+N chars)" (N code points dropped). */
export function capCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : `${cps.slice(0, max).join("")}…(+${cps.length - max} chars)`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A string as the echo shows it: redacted on the full text, bidi controls dropped, cut, escaped. */
const echoString = (s: string): string => jsStringLiteral(capCodePoints(stripBidi(redact(s)), ECHO_LIMITS.string));

function echoValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return echoString(value);
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
        parts.push(`${IDENTIFIER.test(k) ? k : jsStringLiteral(stripBidi(k))}: ${echoValue(v, depth + 1)}`);
      }
      return `{${parts.join(", ")}}`;
    }
    default:
      return value === undefined ? "null" : echoString(String(value));
  }
}

/**
 * One-line echo of a tool's arguments (E1-E6): strings redacted (R1-R4), bidi controls dropped,
 * cut at 80 code points and escaped (keys too, unless a plain identifier); numbers/booleans/null as
 * JSON; arrays show 5 items; containers below depth 3 collapse; undefined keys are skipped; the
 * whole echo is cut at 300 code points.
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
