import { afterEach, describe, expect, it } from "vitest";

import { jsStringLiteral } from "../src/bridge/script-escape.js";
import {
  ECHO_LIMITS,
  EXCERPT_LIMITS,
  capCodePoints,
  echoArgs,
  excerptLine,
  oneLine,
  redact,
  redactKnown,
  setRedactionSecrets,
} from "../src/tools/echo.js";

const EMOJI = String.fromCodePoint(0x1f600);
const HEX64 = "0123456789abcdef".repeat(4);
const HEX32 = "0123456789abcdef".repeat(2);
const ILST = `ilst_${HEX64}`;
const B64URL32 = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"; // a generated httpToken shape, with a digit
const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const TOKEN40 = "Zq3vT8kLm2Np5Rs7Wx9Yb4Cd6Ef1Gh0Jk2Lm4No"; // 40 chars, letters and digits

afterEach(() => setRedactionSecrets([]));

describe("redact (R1-R4: echoed arguments and code excerpts)", () => {
  it("redacts generated tokens, keys, Bearer values and bare UUIDs", () => {
    expect(redact(`token ${HEX64} here`)).toBe("token [redacted] here");
    expect(redact(`key ${ILST}`)).toBe("key [redacted]");
    expect(redact(`http ${B64URL32}`)).toBe("http [redacted]");
    expect(redact(`id ${UUID}`)).toBe("id [redacted]");
  });

  it("keeps font names, effect names and path segments", () => {
    for (const kept of [
      "Arial-BoldMT",
      "AcuminVariableConcept-ExtraCondensedSemiboldItalic",
      "SourceHanSansSC-ExtraLight",
      "ADBE Gaussian Blur 2",
      `C:/cache/${HEX32}/plate.png`,
      `C:\\cache\\${HEX32}\\plate.png`,
      `/tmp/brainferno-mcp-bridge/previews/${UUID}.png`,
    ]) {
      expect(redact(kept), kept).toBe(kept);
    }
  });

  it("R1: redacts a configured secret exactly, and ignores short ones", () => {
    setRedactionSecrets(["mysecretvaluezzz", "short", undefined, ""]);
    expect(redact("a mysecretvaluezzz b")).toBe("a [redacted] b");
    expect(redact("short stays")).toBe("short stays");
  });

  it("R1: finds a secret holding quotes and backslashes raw, as a script literal and as JSON (M2)", () => {
    const secret = 'pa"ss\\word-xyz';
    setRedactionSecrets([secret]);
    expect(redact(`raw ${secret} end`)).toBe("raw [redacted] end");
    expect(redact(`lit ${jsStringLiteral(secret)} end`)).toBe('lit "[redacted]" end');
    expect(redact(`json ${JSON.stringify(secret)} end`)).toBe('json "[redacted]" end');
  });

  it("R2: redacts only a credential-shaped Bearer value (M14)", () => {
    expect(redact("The ring bearer walks in")).toBe("The ring bearer walks in");
    expect(redact("Bearer abc")).toBe("Bearer abc");
    expect(redactKnown(`Authorization: Bearer ${TOKEN40}`)).toBe("Authorization: Bearer [redacted]");
    expect(redactKnown(`"Bearer ${TOKEN40}"`)).toBe('"Bearer [redacted]"');
  });
});

describe("redactKnown (R1-R3: host messages, notes, suggestions)", () => {
  it("leaves project names and long hex runs alone (M13)", () => {
    expect(redactKnown('No composition with id 9; the project has 1: 12 "Instagram_Story_1080x1920_v02_FINAL"')).toBe(
      'No composition with id 9; the project has 1: 12 "Instagram_Story_1080x1920_v02_FINAL"',
    );
    expect(redactKnown(`layer ${HEX64}`)).toBe(`layer ${HEX64}`);
  });

  it("still redacts a configured secret, a Bearer value and an Illustrator key", () => {
    setRedactionSecrets(["configured-secret-value"]);
    expect(redactKnown("x configured-secret-value y")).toBe("x [redacted] y");
    expect(redactKnown(`Bearer ${TOKEN40}`)).toBe("Bearer [redacted]");
    expect(redactKnown(`k=${ILST}`)).toBe("k=[redacted]");
  });
});

describe("echoArgs (E1-E6)", () => {
  it("renders the documented example", () => {
    const keys = Array.from({ length: 100 }, (_, i) => ({ time: i, value: i % 2 === 0 ? 0 : 100 }));
    expect(echoArgs({ compId: 12, layerIndex: 2, property: "opacity", keys })).toBe(
      '{compId: 12, layerIndex: 2, property: "opacity", keys: [{time: 0, value: 0}, {time: 1, value: 100}, {time: 2, value: 0}, {time: 3, value: 100}, {time: 4, value: 0}, …(+95 more)]}',
    );
  });

  it("E1: caps strings at 80 code points without splitting one, and escapes line breaks", () => {
    expect(ECHO_LIMITS.string).toBe(80);
    expect(echoArgs({ s: EMOJI.repeat(100) })).toBe(`{s: "${EMOJI.repeat(80)}…(+20 chars)"}`);
    expect(echoArgs({ s: "a\nb\u2028c\"d" })).toBe('{s: "a\\nb\\u2028c\\"d"}');
  });

  it("E1: redacts before cutting, so a secret straddling the cut leaves no fragment", () => {
    setRedactionSecrets(["mysecretvaluezzz"]);
    const out = echoArgs({ s: "x".repeat(75) + "mysecretvaluezzz" });
    expect(out).not.toMatch(/mysec|valuez/);
    expect(out).toBe(`{s: "${"x".repeat(75)}[reda…(+5 chars)"}`);
    expect(echoArgs({ comment: HEX64 })).toBe('{comment: "[redacted]"}');
  });

  it("E2: numbers, booleans and null as JSON; non-finite as null; undefined keys skipped", () => {
    expect(echoArgs({ a: 1.5, b: true, c: null, d: undefined, e: Number.POSITIVE_INFINITY })).toBe("{a: 1.5, b: true, c: null, e: null}");
  });

  it("E3/E4: arrays keep 5 items; identifier keys are bare, others quoted", () => {
    expect(echoArgs({ a: [1, 2, 3, 4, 5, 6, 7] })).toBe("{a: [1, 2, 3, 4, 5, …(+2 more)]}");
    expect(echoArgs({ a: [1, 2, 3, 4, 5] })).toBe("{a: [1, 2, 3, 4, 5]}");
    expect(echoArgs({ "a-b": 1, $ok: 2, _x: 3 })).toBe('{"a-b": 1, $ok: 2, _x: 3}');
    expect(echoArgs({})).toBe("{}");
  });

  it("E5: containers deeper than 3 levels collapse", () => {
    expect(echoArgs({ a: { b: { c: { d: 1 } } } })).toBe("{a: {b: {c: {…}}}}");
    expect(echoArgs({ a: [[[1]]] })).toBe("{a: [[[…]]]}");
    expect(echoArgs({ a: [[1]] })).toBe("{a: [[1]]}");
  });

  it("E6: caps the whole echo at 300 code points", () => {
    const out = echoArgs({ a: "x".repeat(80), b: "y".repeat(80), c: "z".repeat(80), d: "w".repeat(80) });
    expect(ECHO_LIMITS.total).toBe(300);
    expect(out).toMatch(/…\(\+\d+ chars\)$/);
    expect(Array.from(out.replace(/…\(\+\d+ chars\)$/, ""))).toHaveLength(300);
  });
});

describe("excerptLine (X1-X5)", () => {
  it("decodes literals before redacting, so an escape cannot shield a token (M12)", () => {
    const line = `    v = "code:\\n${TOKEN40}"; if (v !== null) { td.text = v; }`;
    expect(excerptLine(line)).toBe('v = "code:\\n[redacted]"; if (v !== null) { td.text = v; }');
  });

  it("redacts a configured secret holding quotes and backslashes inside a literal", () => {
    const secret = 'pa"ss\\word-xyz';
    setRedactionSecrets([secret]);
    expect(excerptLine(`var s = ${jsStringLiteral(`before ${secret} after`)};`)).toBe('var s = "before [redacted] after";');
  });

  it("keeps a hex directory in a Windows path literal (its decoded neighbours are backslashes)", () => {
    const line = `var f = new File("C:\\\\cache\\\\${HEX32}\\\\x.png");`;
    expect(excerptLine(line)).toBe(line);
  });

  it("redacts code between literals too", () => {
    expect(excerptLine(`var t = ${HEX64}; var u = "ok";`)).toBe('var t = [redacted]; var u = "ok";');
  });

  it("cuts a long literal at 80 code points after decoding, never inside an escape or a code point", () => {
    expect(EXCERPT_LIMITS.literal).toBe(80);
    const ascii = `var s = "${"a".repeat(200)}";`;
    expect(excerptLine(ascii)).toBe(`var s = "${"a".repeat(80)}…"(+120 chars);`);
    const escaped = `var s = "${"\\u00e9".repeat(100)}";`;
    expect(excerptLine(escaped)).toBe(`var s = "${"\u00e9".repeat(80)}…"(+20 chars);`);
    const astral = `var s = "${"\\ud83d\\ude00".repeat(90)}";`;
    expect(excerptLine(astral)).toBe(`var s = "${EMOJI.repeat(80)}…"(+10 chars);`);
  });

  it("decodes \\v, \\uXXXX and an unknown escape", () => {
    expect(excerptLine('x = "a\\vb\\u00e9\\q";')).toBe('x = "a\\vb\u00e9q";');
  });

  it("leaves an unterminated quote as code", () => {
    expect(excerptLine('x = "abc')).toBe('x = "abc');
  });

  it("caps the rebuilt line at 120 code points", () => {
    expect(EXCERPT_LIMITS.line).toBe(120);
    const out = excerptLine(`${"f(1); ".repeat(40)}`);
    expect(out).toMatch(/…\(\+\d+ chars\)$/);
    expect(Array.from(out.replace(/…\(\+\d+ chars\)$/, ""))).toHaveLength(120);
  });
});

describe("oneLine and capCodePoints", () => {
  it("collapses every kind of line break (and tabs) with the spaces around it", () => {
    expect(oneLine("a\r\nb \n  c\u2028d\u2029e\tf\rg")).toBe("a b c d e f g");
    expect(oneLine("no breaks")).toBe("no breaks");
  });

  it("cuts by code points and says how many were dropped", () => {
    expect(capCodePoints("abcdef", 6)).toBe("abcdef");
    expect(capCodePoints("abcdef", 4)).toBe("abcd…(+2 chars)");
    expect(capCodePoints(EMOJI.repeat(3), 2)).toBe(`${EMOJI.repeat(2)}…(+1 chars)`);
  });
});
