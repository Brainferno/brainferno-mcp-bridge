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
  stripBidi,
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

  it("R1: finds a secret with a control character where a host quoting turned it into a space", () => {
    setRedactionSecrets(["abc\tDEFghijkl"]);
    expect(redactKnown('Unable to find "abc DEFghijkl" here')).toBe('Unable to find "[redacted]" here');
  });

  it("R1 with a cut length: a long secret's cut prefix is redacted too, raw, escaped and blanked (K2)", () => {
    setRedactionSecrets([HEX64], { cut: 60 });
    const cut = `${HEX64.slice(0, 60)}...`;
    expect(redactKnown(`No composition with id 9; the project has 1: 12 "${cut}"`)).toBe('No composition with id 9; the project has 1: 12 "[redacted]..."');
    expect(redactKnown(`whole ${HEX64}`)).toBe("whole [redacted]");
    expect(redactKnown(`shorter ${HEX64.slice(0, 59)}`)).toBe(`shorter ${HEX64.slice(0, 59)}`);

    const quoted = `pa"ss\\word\t${"q".repeat(60)}`;
    setRedactionSecrets([quoted], { cut: 60 });
    const prefix = quoted.slice(0, 60);
    expect(redactKnown(`raw ${prefix}...`)).toBe("raw [redacted]...");
    expect(redactKnown(`json ${JSON.stringify(prefix).slice(1, -1)}...`)).toBe("json [redacted]...");
    expect(redactKnown(`blanked ${prefix.replace(/["\\]/g, "\\$&").replace("\t", " ")}...`)).toBe("blanked [redacted]...");
  });

  it("R1 with a cut length: only a secret longer than the cut adds its prefix, and never a short one", () => {
    setRedactionSecrets(["configured-secret-value"], { cut: 60 });
    expect(redactKnown("configured-secret-valu")).toBe("configured-secret-valu");
    setRedactionSecrets(["configured-secret-value"], { cut: 10 });
    expect(redactKnown("configured...")).toBe("[redacted]...");
    setRedactionSecrets(["configured-secret-value"], { cut: 4 });
    expect(redactKnown("conf...")).toBe("conf...");
  });

  it("R1 with a cut length: a name the host cut inside a secret that follows other text keeps no part of the secret (F1)", () => {
    setRedactionSecrets([HEX64], { cut: 60 });
    // "tok " + HEX64 cut at 60 units keeps 56 characters of the secret; "bridge token: " + HEX64 keeps 46.
    expect(redactKnown(`the project has 1: 12 "tok ${HEX64.slice(0, 56)}..." — pass one.`)).toBe('the project has 1: 12 "tok [redacted]..." — pass one.');
    expect(redactKnown(`["bridge token: ${HEX64.slice(0, 46)}...", "Main"]`)).toBe('["bridge token: [redacted]...", "Main"]');

    // A secret no longer than the cut that straddles it registers no prefix of its own.
    setRedactionSecrets([TOKEN40], { cut: 60 });
    expect(redactKnown(`12 "${"n".repeat(30)}${TOKEN40.slice(0, 30)}..."`)).toBe(`12 "${"n".repeat(30)}[redacted]..."`);

    // The host's quoting: a quote and a backslash escaped, a control character a space.
    const quoted = `pa"ss\\word\tXYZ-${"q".repeat(12)}`;
    setRedactionSecrets([quoted], { cut: 60 });
    const lead = "m".repeat(46); // leaves 14 units of the secret: pa"ss\word XYZ
    expect(redactKnown(`12 "${lead}pa\\"ss\\\\word XYZ..."`)).toBe(`12 "${lead}[redacted]..."`);
  });

  it("R1 with a cut length: only the tail of a name the host cut, at least 8 characters long, and never an ordinary name (F1)", () => {
    setRedactionSecrets([HEX64, TOKEN40, "configured-secret-value"], { cut: 60 });
    // An ordinary long name, cut by the host, stays as it is.
    const ordinary = `the project has 2: 12 "${"Instagram_Story_1080x1920_v02_FINAL_extended_cut_for_client_review".slice(0, 60)}...", 13 "Main"`;
    expect(redactKnown(ordinary)).toBe(ordinary);
    // A name the host did not cut (another length) is the project's own text.
    const uncut = `12 "${"n".repeat(51)}${HEX64.slice(0, 8)}..."`;
    expect(redactKnown(uncut)).toBe(uncut);
    // Fewer than 8 characters of a secret at the cut are not a match.
    const short = `12 "${"n".repeat(53)}${HEX64.slice(0, 7)}..."`;
    expect(redactKnown(short)).toBe(short);
    // Without a cut length there is no cut to look at.
    setRedactionSecrets([HEX64]);
    const plain = `12 "tok ${HEX64.slice(0, 56)}..."`;
    expect(redactKnown(plain)).toBe(plain);
  });

  it("R1 with a cut length: a quoted name as long as a cut one that does not end in the mark is the project's own text (F1, G4)", () => {
    setRedactionSecrets([HEX64], { cut: 60 });
    // 63 units, like a cut name, and the first 60 end with 8 characters of the secret, but no "..." follows.
    const uncut = `12 "${"n".repeat(52)}${HEX64.slice(0, 8)}abc", 13 "Main"`;
    expect(redactKnown(uncut)).toBe(uncut);
    // The same name with the mark is a cut name: its tail goes.
    expect(redactKnown(`12 "${"n".repeat(52)}${HEX64.slice(0, 8)}...", 13 "Main"`)).toBe(`12 "${"n".repeat(52)}[redacted]...", 13 "Main"`);
  });

  it("R1 with a cut length: finds the same quoted names as before in an ordinary host message, escapes and all (G1)", () => {
    setRedactionSecrets([HEX64], { cut: 60 });
    // __q's quoting: a quote and a backslash escaped inside the name; nothing escaped outside one.
    const message =
      `No composition with id 99; the project has 4: 11 "say \\"hi\\"", 12 "C:\\\\out\\\\", 13 "tok ${HEX64.slice(0, 56)}...", ` +
      `14 "a \\"q\\" ${HEX64.slice(0, 54)}..." — pass one of these compIds.`;
    expect(redactKnown(message)).toBe(
      'No composition with id 99; the project has 4: 11 "say \\"hi\\"", 12 "C:\\\\out\\\\", 13 "tok [redacted]...", ' +
        '14 "a \\"q\\" [redacted]..." — pass one of these compIds.',
    );
    // A quote that is never closed starts no name, and nothing after it is read as one.
    const open = `13 "tok ${HEX64.slice(0, 56)}..." and "never closed 14 \\"tok ${HEX64.slice(0, 56)}...\\"`;
    expect(redactKnown(open)).toBe(`13 "tok [redacted]..." and "never closed 14 \\"tok ${HEX64.slice(0, 56)}...\\"`);
  });

  it("R2: redacts only a credential-shaped Bearer value (M14)", () => {
    expect(redact("The ring bearer walks in")).toBe("The ring bearer walks in");
    expect(redact("Bearer abc")).toBe("Bearer abc");
    expect(redactKnown(`Authorization: Bearer ${TOKEN40}`)).toBe("Authorization: Bearer [redacted]");
    expect(redactKnown(`"Bearer ${TOKEN40}"`)).toBe('"Bearer [redacted]"');
  });
});

describe("redaction cost (G1)", () => {
  /** Milliseconds one call may take on about 200 KB; a quadratic scan takes seconds (10 s at 180 KB). */
  const LINEAR_MS = 500;
  // An unescaped quote that is never closed, then escaped quotes: every escaped quote looks like
  // the start of a quoted name.
  const escapedQuotes = `x"${'a\\"'.repeat(66_000)}`;
  // A text layer showing JSON that was itself escaped: no unescaped quote at all.
  const escapedJson = JSON.stringify(JSON.stringify({ items: Array.from({ length: 9_000 }, (_, i) => ({ id: i, name: `item ${i}` })) })).slice(1, -1);

  const within = (label: string, f: () => unknown): void => {
    const started = performance.now();
    f();
    expect(performance.now() - started, label).toBeLessThan(LINEAR_MS);
  };

  it("redacts, echoes and quotes about 200 KB of escaped quotes in time linear in its length, with the cut set as buildRuntime sets it", () => {
    setRedactionSecrets([HEX64], { cut: 60, mark: "..." });
    for (const [name, text] of [["escaped quotes", escapedQuotes], ["escaped JSON", escapedJson]] as const) {
      expect(text.length, name).toBeGreaterThan(190_000);
      within(`${name}: redact`, () => redact(text));
      within(`${name}: redactKnown`, () => redactKnown(text));
      within(`${name}: echoArgs`, () => echoArgs({ compId: 99, layerIndex: 1, text }));
      within(`${name}: excerptLine`, () => excerptLine(`var t = ${jsStringLiteral(text)};`));
    }
  });

  it("keeps a long run of spaces on one line in linear time, and collapses only a run that holds a control character", () => {
    const spaces = `x${" ".repeat(200_000)}y`;
    within("oneLine: spaces", () => expect(oneLine(spaces)).toBe(spaces));
    within("oneLine: spaces and a tab", () => expect(oneLine(`x${" ".repeat(200_000)}\ty`)).toBe("x y"));
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

  it("drops bidi embeddings, overrides and isolates from string values and keys, so the echo cannot reorder the paragraph after it (F4)", () => {
    expect(echoArgs({ compId: 12, text: "abc‮def⁦g⁩" })).toBe('{compId: 12, text: "abcdefg"}');
    expect(echoArgs({ "k⁦": 1, list: ["‪x‬"] })).toBe('{"k": 1, list: ["x"]}');
    expect(echoArgs({ s: "‏א Café" })).toBe('{s: "‏א Café"}'); // marks and RTL letters stay
    expect(stripBidi("a‪b‫c‬d‭e‮f⁦g⁧h⁨i⁩j")).toBe("abcdefghij");
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
    expect(oneLine("a\vb \f c\u0085d")).toBe("a b c d");
    expect(oneLine("no breaks")).toBe("no breaks");
  });

  it("turns every other C0 and C1 control into a space and drops bidi overrides (R10)", () => {
    expect(oneLine("a\u001bb\u009bc\u007fd\u0000e")).toBe("a b c d e");
    expect(oneLine("a\u001b[2Jb")).toBe("a [2Jb");
    expect(oneLine("x\u202ey\u2066z\u2069")).toBe("xyz");
    expect(oneLine("Caf\u00e9 \u2014 \u00a0ok")).toBe("Caf\u00e9 \u2014 \u00a0ok");
  });

  it("gives the text the single control-run rule gave, run for run (G1)", () => {
    // The rule as one regex: quadratic on a long run of spaces, so oneLine applies it per run.
    const reference = (text: string): string => stripBidi(text.replace(/\s*[\u0000-\u001f\u007f-\u009f\u2028\u2029]+\s*/g, " "));
    const alphabet = [" ", "\t", "\n", "\r", "\u0000", "\u001b", "\u0085", "\u00a0", "\u2028", "\u3000", "\ufeff", "\u202e", "a", "b"];
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 48271) % 2147483647; // MINSTD: exact in a double, so the cases never change
      return seed % n;
    };
    for (let i = 0; i < 5000; i++) {
      const text = Array.from({ length: 1 + next(12) }, () => alphabet[next(alphabet.length)]).join("");
      expect(oneLine(text), JSON.stringify(text)).toBe(reference(text));
    }
  });

  it("cuts by code points and says how many were dropped", () => {
    expect(capCodePoints("abcdef", 6)).toBe("abcdef");
    expect(capCodePoints("abcdef", 4)).toBe("abcd…(+2 chars)");
    expect(capCodePoints(EMOJI.repeat(3), 2)).toBe(`${EMOJI.repeat(2)}…(+1 chars)`);
  });
});
