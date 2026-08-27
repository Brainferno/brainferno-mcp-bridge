/**
 * Turning a runtime string into a literal that is safe to splice into generated
 * host script source (ExtendScript ES3, or UXP JS).
 *
 * `JSON.stringify` is *not* a correct JS-source escaper: it emits U+2028 (LINE
 * SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) verbatim, and both are line
 * terminators to a JavaScript parser — an ES3 engine treats them as a newline
 * mid-string and throws a syntax error (and, for attacker-influenced input such
 * as a layer or comp name, it is a script-injection seam). Escape them, along
 * with quotes, backslashes, and the other control characters, explicitly.
 */

const SIMPLE_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
  "\v": "\\v",
};

/**
 * Returns a double-quoted JavaScript string literal (quotes included) encoding
 * `value`, safe to embed directly in generated script source.
 */
export function jsStringLiteral(value: string): string {
  let out = '"';
  for (const ch of value) {
    const mapped = SIMPLE_ESCAPES[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // U+2028 / U+2029 are JS line terminators; C0/C1 controls must not appear
    // raw in source. All of these are in the BMP, so a 4-digit \uXXXX escape is
    // always sufficient (and ES3-valid). Everything else passes through.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out + '"';
}
