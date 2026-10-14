import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppDisconnectedError, EvalTimeoutError, ScriptError, type AppBridge, type JsonValue } from "../src/bridge/types.js";
import { JobRegistry } from "../src/jobs.js";
import {
  AE_CUT_MARK,
  AE_NAME_CUT,
  AE_PRELUDE_LINES,
  EFFECT_DISPLAY_NAMES_ACCEPTED,
  EFFECT_MISS,
  EFFECT_NAMES_CASE_SENSITIVE,
  EFFECT_NAME_MAX,
  EffectCatalog,
  HOST_LINE_GUARD,
  LIST_COMPOSITIONS,
  LIST_INSTALLED_EFFECTS,
  SLOW_EFFECTS_READ_MS,
  addLayerScript,
  addLayerStyleScript,
  addMaskScript,
  addToEssentialGraphicsScript,
  aeExcerpt,
  aeHelperRanges,
  aeListSuggestions,
  applyEffectScript,
  enrichAeError,
  evaluateAe,
  exportMogrtScript,
  filteredEffectsScript,
  getCompScript,
  getKeyframesScript,
  getLayerScript,
  getLayerStylesScript,
  importAsCompScript,
  importFootageScript,
  locateAeError,
  openProjectScript,
  queueRenderScript,
  registerAfterEffectsTools,
  removeLayerStyleScript,
  renderCompHeadless,
  saveProjectScript,
  setEffectParamScript,
  setExpressionScript,
  setLayerPropsScript,
  setLayerStyleParamScript,
  setTextScript,
  withEffectSuggestions,
  wrapAe,
  type InstalledEffect,
  // AE-03
  addLayerBody,
  addMarkerScript,
  aeBatchExcerpt,
  aeBatchScript,
  aeNameToIndex,
  buildAeBatch,
  compByNameScript,
  createCompBody,
  deleteLayerBody,
  findLayersScript,
  locateAeBatchError,
  setCompPropsScript,
  setLayerPropsBody,
  setTextBody,
  undoRedoScript,
} from "../src/tools/after-effects.js";
import { runAsToolCall } from "../src/tools/call-context.js";
import { MESSAGE_LIMIT, setRedactionSecrets } from "../src/tools/echo.js";
import { registerJobTools } from "../src/tools/jobs.js";
import { lineCount } from "../src/tools/raw-script.js";
import { scriptErrorText } from "../src/tools/result.js";
import { closestNames, rank, stripAeVendor, suggestionThreshold, fold } from "../src/tools/suggest.js";
import { AE_EFFECTS, AE_EFFECT_ITEMS } from "./ae-effects-fixture.js";
import { CARD_DANCE, CARD_DANCE_MATCH, HOST_JSX_PATH, MAIN, aeHost, type AeHost, type CompSpec, type EvalReply, type HostOptions, type ProjectSpec } from "./ae-host.js";
import { ES5_CALLS, es5Calls } from "./es3.js";

const SUFFIX = "\n})()";
const PRELUDE = wrapAe("").slice(0, -SUFFIX.length);
const DASH = "—";
const TOKEN40 = "Zq3vT8kLm2Np5Rs7Wx9Yb4Cd6Ef1Gh0Jk2Lm4No";
const TOKEN20 = "Zq7Lm2Xp9Rt4Vw8Ys3Bn";
const HEX64 = "0123456789abcdef".repeat(4);

/** The 1-based body line (first statement = 1) of the first body line containing `needle`, read off the body string itself. */
function bodyLineOf(script: string, needle: string): number {
  const body = script.slice(PRELUDE.length, -SUFFIX.length);
  const lines = body.split("\n");
  const lead = body.startsWith("\n") ? 1 : 0;
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no body line contains ${needle}`);
  return i + 1 - lead;
}

/** Run a script in a fresh fake After Effects and return the failure (the test fails if it succeeded). */
function fail(script: string, spec?: ProjectSpec, options?: HostOptions): { message: string; line: number | null; host: AeHost } {
  return failIn(aeHost(spec, options), script);
}

/** fail() in a fake After Effects the test has already set up (stubs, getters that throw). */
function failIn(host: AeHost, script: string): { message: string; line: number | null; host: AeHost } {
  const r = host.eval(script);
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.value)}`);
  return { ...r.error, host };
}

/** enrichAeError's next step for a host error on a body line (a builder's own throw never gets it). */
const NEXT_BODY = "check the values the line marked >>> uses (ae_get_comp and ae_get_layer show what exists), then retry";

/** What the socket lane would raise for that failure. */
function scriptError(r: { message: string; line: number | null }): ScriptError {
  return new ScriptError("after_effects", r.message, r.line ?? undefined, { code: "HOST_ERROR" });
}

/** Names as __list writes them (no name here needs escaping). */
const list = (names: readonly string[]): string => JSON.stringify(names).replace(/","/g, '", "');

/** Match names as __repMatch writes them when each is the effect's match name, "-" and a number: [0010, 0014]. */
const numbers = (...indexes: number[]): string => `[${indexes.map((i) => String(i).padStart(4, "0")).join(", ")}]`;
/** Card Dance's parameter names as a list shows them: its 12 empty names (topic ends) are left out. */
const CARD_NAMES = CARD_DANCE.map(([name]) => name).filter((name) => name !== "");
/** Card Dance's repeated names, in the order __kids finds them (by their second copy); the empty name is not one. */
const CARD_REPEATED = ["Source", "Multiplier", "Offset", "X Rotation", "Y Rotation", "Z Rotation", "Z Position", "Focal Length"];
/** Where each repeats: the numbers After Effects 26.5 gave live (2026-10-10). Source, Multiplier and Offset 6 apart. */
const CARD_COPIES: Readonly<Record<string, string>> = {
  Source: numbers(18, 24, 30, 36, 42, 48, 54, 60),
  Multiplier: numbers(20, 26, 32, 38, 44, 50, 56, 62),
  Offset: numbers(22, 28, 34, 40, 46, 52, 58, 64),
  "X Rotation": numbers(49, 68),
  "Y Rotation": numbers(59, 70),
  "Z Rotation": numbers(69, 72),
  "Z Position": numbers(39, 76),
  "Focal Length": numbers(78, 92),
};
/** The advice after a Card Dance list: every repeated name with every copy's number, in `order`. */
const cardAdvice = (order: readonly string[]): string =>
  `${DASH} a repeated name reaches only the first of them; pass the match name instead (by match name, "${CARD_DANCE_MATCH}-" + the number: ` +
  `${order.map((n) => `"${n}": ${CARD_COPIES[n]}`).join("; ")}).`;
/** CARD_REPEATED with `first` moved to the front. */
const nameFirst = (first: string): string[] => [first, ...CARD_REPEATED.filter((n) => n !== first)];
/** Comp 12 with one layer, "Cards", carrying Card Dance. */
const CARDS: ProjectSpec = { comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: "Cards", effects: [CARD_DANCE_MATCH] }] }] };


describe("prelude contract (U1, A1, A5)", () => {
  it("puts the first body line right after AE_PRELUDE_LINES prelude lines", () => {
    const lines = wrapAe("__AE16_MARK__").split("\n");
    expect(lines.findIndex((l) => l.endsWith("__AE16_MARK__"))).toBe(AE_PRELUDE_LINES);
    expect(AE_PRELUDE_LINES).toBe(lineCount(wrapAe("")) - 2);
    expect(PRELUDE.endsWith("\n")).toBe(true);
    expect(wrapAe("x").startsWith(PRELUDE) && wrapAe("x").endsWith(SUFFIX)).toBe(true);
  });

  it("keeps the host-line guard above the tracked host.jsx's line count, so its lines read as outside (U2)", () => {
    const hostLines = lineCount(readFileSync(HOST_JSX_PATH, "utf8"));
    expect(HOST_LINE_GUARD).toBeGreaterThanOrEqual(hostLines);
    for (let line = 1; line <= hostLines; line++) expect(locateAeError(LIST_COMPOSITIONS, line), `host.jsx line ${line}`).toEqual({ kind: "outside" });
  });

  it("sends pure ASCII: the prelude, and non-ASCII arguments as \\u escapes that decode to the same text", () => {
    expect(/^[\x00-\x7f]*$/.test(PRELUDE)).toBe(true);
    const text = "Café — \u{1F600}";
    const script = addLayerScript({ compId: 12, kind: "text", text });
    expect(/^[\x00-\x7f]*$/.test(script)).toBe(true);
    expect(script).toContain('"Caf\\u00e9 \\u2014 \\ud83d\\ude00"');
    const host = aeHost();
    const r = host.eval(script);
    expect(r.ok).toBe(true);
    expect(host.comp(12).layer(1).property("ADBE Text Properties").property("ADBE Text Document").value.text).toBe(text);
  });

  it("raises helper messages with a real em dash, so the next-step check still sees ' — '", () => {
    const r = fail(getCompScript(99));
    expect(r.message).toContain(` ${DASH} pass one of these compIds`);
  });

  it("uses no ES5-only built-ins in the helpers, nor indexOf/lastIndexOf at all (the regex ES3 gate cannot see these) (R13)", () => {
    expect(es5Calls(PRELUDE)).toEqual([]);
    for (const banned of [".indexOf(", ".lastIndexOf("]) expect(PRELUDE, banned).not.toContain(banned);
  });

  it("the ES5 gate sees the calls an ES3 engine lacks, and passes ES3 string methods (R13)", () => {
    expect(es5Calls("names.some(function (n) { return n; }); var t = Date.now(); f.bind(o); Object.create(null);")).toEqual([".some(", ".bind(", "Object.create", "Date.now"]);
    expect(es5Calls('$.os.indexOf("Windows"); s.lastIndexOf("/"); s.charAt(0); s.substring(1);')).toEqual([]);
    expect(ES5_CALLS).toContain(".reduceRight(");
  });

  it("__q keeps AE_NAME_CUT units of a name and marks a cut with ... (K2)", () => {
    const name = (n: number) => (aeHost().eval(wrapAe(`\n  return __q("${"n".repeat(n)}");`)) as { ok: true; value: string }).value;
    expect(name(AE_NAME_CUT)).toBe(`"${"n".repeat(AE_NAME_CUT)}"`);
    expect(name(AE_NAME_CUT + 1)).toBe(`"${"n".repeat(AE_NAME_CUT)}..."`);
  });

  it("__q writes every C0 and C1 control, U+2028 and U+2029 as a space, and keeps other text (R10)", () => {
    // NUL, ESC, DEL, NEL, CSI, APC (U+009F), LS; then NBSP and é, which stay.
    const r = aeHost().eval(wrapAe('\n  return __q("a\\u0000b\\u001bc\\u007fd\\u0085e\\u009bf\\u009fg\\u2028h\\u00a0i\\u00e9j");'));
    expect(r).toEqual({ ok: true, value: '"a b c d e f g h iéj"' });
  });

  it("a name holding a C1 control is quoted the way a registered secret's blanked form expects (R10, K2)", () => {
    const secret = "Logo\u0085QuietSecretValue";
    setRedactionSecrets([secret]);
    try {
      const r = fail(getCompScript(99), { comps: [{ id: 12, name: secret }] });
      expect(r.message).toContain('12 "Logo QuietSecretValue"');
      const text = scriptErrorText(enrichAeError(scriptError(r), getCompScript(99)) as ScriptError);
      expect(text).toContain('12 "[redacted]"');
      expect(text).not.toContain("QuietSecretValue");
    } finally {
      setRedactionSecrets([]);
    }
  });

  it("a secret holding a control character and a quote or backslash, listed and near-missed, is redacted in the list and in 'did you mean' (F2)", () => {
    for (const [secret, asked] of [
      ['pass"Word\tXYZ12', 'pass"Word XYZ1'],
      ["pass\\Word\tXYZ12", "pass\\Word XYZ1"],
    ] as const) {
      setRedactionSecrets([secret], { cut: AE_NAME_CUT });
      try {
        // A shape group named with the secret, one edit from the segment asked for.
        const shapes: ProjectSpec = { comps: [{ id: 12, name: "Main", layers: [{ kind: "shape", name: "S", shapes: [secret, "Shape 1"] }] }] };
        const script = getKeyframesScript(12, 1, "position", ["ADBE Root Vectors Group", asked]);
        const path = scriptErrorText(enrichAeError(scriptError(fail(script, shapes)), script) as ScriptError);
        expect(path).toContain('children here: ["[redacted]", "Shape 1"]');
        expect(path).toContain('Did you mean "[redacted]"?');
        expect(path).not.toContain("XYZ12");
        // ae_queue_render's composition list.
        const queue = queueRenderScript(asked, "C:/r/a.mov", undefined);
        const comps = scriptErrorText(enrichAeError(scriptError(fail(queue, { comps: [MAIN, { id: 15, name: secret }] })), queue) as ScriptError);
        expect(comps).toContain('compositions: ["Main", "[redacted]"]');
        expect(comps).toContain('Did you mean "[redacted]"?');
        expect(comps).not.toContain("XYZ12");
      } finally {
        setRedactionSecrets([]);
      }
    }
  });
});

describe("helper map and locateAeError", () => {
  it("has one disjoint range per helper, and every helper throw inside one", () => {
    const ranges = aeHelperRanges();
    const declared = PRELUDE.split("\n").filter((l) => /^  function __\w+\(/.test(l)).length;
    expect(ranges).toHaveLength(declared);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.first).toBeGreaterThan(ranges[i - 1]!.last);
    PRELUDE.split("\n").forEach((l, i) => {
      if (l.includes("throw new Error")) expect(ranges.some((r) => i + 1 >= r.first && i + 1 <= r.last), `prelude line ${i + 1}`).toBe(true);
    });
    for (let line = 1; line <= HOST_LINE_GUARD + 1; line++) expect(locateAeError(LIST_COMPOSITIONS, line)).toEqual({ kind: "outside" });
  });

  it("answers unknown for no line, a bad line, or a script wrap() did not build", () => {
    for (const line of [undefined, 0, -3, 2.5]) expect(locateAeError(LIST_COMPOSITIONS, line)).toEqual({ kind: "unknown" });
    expect(locateAeError("(function () { boom; })()", 1)).toEqual({ kind: "unknown" });
  });

  it("reads the empty first body line and the closing line as outside, and a __comp throw as __comp", () => {
    expect(locateAeError(LIST_COMPOSITIONS, AE_PRELUDE_LINES + 1)).toEqual({ kind: "outside" });
    expect(locateAeError(LIST_COMPOSITIONS, lineCount(LIST_COMPOSITIONS))).toEqual({ kind: "outside" });
    expect(locateAeError(LIST_COMPOSITIONS, AE_PRELUDE_LINES + 2)).toEqual({ kind: "body", bodyLine: 1 });
    const r = fail(getCompScript(99));
    expect(locateAeError(getCompScript(99), r.line ?? undefined)).toEqual({ kind: "helper", helper: "__comp" });
  });
});

describe("body lines (acceptance 1)", () => {
  it("a native error on the 3rd statement is body line 3 (the vm reports the real line)", () => {
    const body = "\n  var a = 1;\n  var b = 2;\n  null.boom;\n  return a;";
    const expected = body.split("\n").slice(1).findIndex((l) => l.includes("null.boom")) + 1; // after the empty lead line, 1-based
    expect(expected).toBe(3);
    const r = fail(wrapAe(body));
    expect(locateAeError(wrapAe(body), r.line ?? undefined)).toEqual({ kind: "body", bodyLine: expected });
    expect(r.line).toBe(AE_PRELUDE_LINES + 4);
  });

  it("counts from the first line when a body has no leading newline", () => {
    const body = "  var a = 1;\n  var b = 2;\n  null.boom;\n  return a;";
    const r = fail(wrapAe(body));
    expect(locateAeError(wrapAe(body), r.line ?? undefined)).toEqual({ kind: "body", bodyLine: 3 });
  });

  it("maps a real builder: LIST_COMPOSITIONS failing in app.project.item is body line 3, with its excerpt", () => {
    const host = aeHost();
    host.app.project.item = () => {
      throw new host.VmError("boom");
    };
    const r = host.eval(LIST_COMPOSITIONS) as Extract<EvalReply, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(bodyLineOf(LIST_COMPOSITIONS, "app.project.item(i)")).toBe(3);
    expect(locateAeError(LIST_COMPOSITIONS, r.error.line ?? undefined)).toEqual({ kind: "body", bodyLine: 3 });
    expect(aeExcerpt(LIST_COMPOSITIONS, 3)).toEqual([
      "2: for (var i = 1; i <= app.project.numItems; i++) {",
      ">>> 3: var item = app.project.item(i);",
      "4: if (item instanceof CompItem) { comps.push(__compInfo(item)); }",
    ]);
  });
});

describe("__comp (missing compositions)", () => {
  it("lists the compositions, facts before the dash and the next step after it", () => {
    const r = fail(getCompScript(99), { comps: [MAIN, { id: 15, name: "LT" }] });
    expect(r.message).toBe(`No composition with id 99; the project has 2: 12 "Main", 15 "LT" ${DASH} pass one of these compIds (ae_list_compositions lists them all).`);
    expect(locateAeError(getCompScript(99), r.line ?? undefined)).toEqual({ kind: "helper", helper: "__comp" });
  });

  it("names a footage or folder id for what it is", () => {
    const spec = { comps: [MAIN], footage: [{ id: 7, name: "clip.mov" }], folders: [{ id: 5, name: "Assets" }] };
    expect(fail(getCompScript(7), spec).message).toBe(
      `Item 7 "clip.mov" is a footage item, not a composition; the project has 1: 12 "Main" ${DASH} pass one of these compIds (ae_list_compositions lists them all).`,
    );
    expect(fail(getCompScript(5), spec).message).toMatch(/^Item 5 "Assets" is a folder, not a composition; /);
  });

  it("says how to make one when the project has none (M5)", () => {
    const empty = fail(getCompScript(1), { comps: [] });
    expect(empty.message).toBe(`No composition with id 1; the project has no compositions ${DASH} create one with ae_create_comp and pass its id.`);
    const footageOnly = fail(getCompScript(7), { footage: [{ id: 7, name: "clip.mov" }] });
    expect(footageOnly.message).toBe(
      `Item 7 "clip.mov" is a footage item, not a composition, and the project has no compositions ${DASH} create one with ae_create_comp and pass its id.`,
    );
    for (const m of [empty.message, footageOnly.message]) {
      expect(m).not.toContain("[]");
      expect(m).not.toContain("pass one of these");
    }
  });

  it("cuts a long list by length and keeps the next step (M8)", () => {
    const comps: CompSpec[] = Array.from({ length: 25 }, (_, i) => ({ id: 100 + i, name: `${i}`.padStart(60, "C") }));
    const r = fail(getCompScript(99), { comps });
    expect(r.message.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    // The 20-name cap alone would leave 5 more; the 600-character budget stops the list sooner (R2).
    const more = Number(/ \.\.\. and (\d+) more /.exec(r.message)![1]);
    expect(more).toBeGreaterThan(comps.length - 20);
    expect(r.message.length).toBeLessThan(800);
    expect(scriptErrorText(enrichAeError(scriptError(r), getCompScript(99)) as ScriptError)).toMatch(/\(ae_list_compositions lists them all\)\.$/);
  });

  it("a name holding a whole secret and then the start of another keeps no part of either where the host cut it (H2)", () => {
    // Registered as buildRuntime registers the server's secrets: with __q's cut.
    setRedactionSecrets([TOKEN20, HEX64], { cut: AE_NAME_CUT, mark: AE_CUT_MARK });
    try {
      // Cut at 60: the token whole and 37 characters of the key; the token twice and 14 characters of a third copy.
      const comps: CompSpec[] = [
        { id: 12, name: `${TOKEN20} / ${HEX64}` },
        { id: 13, name: `${TOKEN20} copy ${TOKEN20}${TOKEN20}` },
      ];
      const r = fail(getCompScript(99), { comps });
      expect(r.message).toContain(`12 "${TOKEN20} / ${HEX64.slice(0, 37)}..."`);
      const text = scriptErrorText(enrichAeError(scriptError(r), getCompScript(99)) as ScriptError);
      expect(text).toContain('the project has 2: 12 "[redacted] / [redacted]...", 13 "[redacted] copy [redacted][redacted]..."');
      expect(text).not.toContain(HEX64.slice(0, 8));
      expect(text).not.toContain(TOKEN20.slice(0, 8));
    } finally {
      setRedactionSecrets([]);
    }
  });

  it("a secret holding a quote, raw earlier in the message, does not hide a name the host cut after it (I6)", () => {
    // Raw text (a path, an expression error) is not quoted, so a '"' in a secret there opens a quoted
    // span: until R1 removes the secret, the quotes after it pair up wrongly and the cut name reads as
    // text between names.
    const QUOTED = 'pa"ss12345678';
    setRedactionSecrets([QUOTED, HEX64], { cut: AE_NAME_CUT, mark: AE_CUT_MARK });
    try {
      const kept = `${"n".repeat(AE_NAME_CUT - 8)}${HEX64.slice(0, 8)}`;
      const message = `No file at C:\\${QUOTED}\\x.aep; layer 1 "${kept}${AE_CUT_MARK}" (solid) ${DASH} pass another path.`;
      const text = scriptErrorText(enrichAeError(new ScriptError("after_effects", message, AE_PRELUDE_LINES + 4), LIST_COMPOSITIONS) as ScriptError);
      expect(text).toContain(`No file at C:\\[redacted]\\x.aep; layer 1 "${"n".repeat(AE_NAME_CUT - 8)}[redacted]${AE_CUT_MARK}" (solid) ${DASH} pass another path.`);
      expect(text).not.toContain(HEX64.slice(0, 8));
      expect(text).not.toContain("ss12345678");
    } finally {
      setRedactionSecrets([]);
    }
  });
});

describe("__layer (out-of-range indexes, acceptance 3)", () => {
  it("lists the range and each layer's name and kind", () => {
    const r = fail(getLayerScript(12, 9));
    expect(r.message).toBe(
      `Layer index 9 is out of range (1..3) in "Main" (id 12): 1 "Title" (text), 2 "Logo" (shape), 3 "BG" (solid) ${DASH} pass one of these indexes (ae_get_comp lists every layer).`,
    );
    expect(locateAeError(getLayerScript(12, 9), r.line ?? undefined)).toEqual({ kind: "helper", helper: "__layer" });
  });

  it("lists 20 short names and counts the rest", () => {
    const layers = Array.from({ length: 25 }, (_, i) => ({ kind: "null" as const, name: `N${i + 1}` }));
    const r = fail(getLayerScript(12, 30), { comps: [{ id: 12, name: "Main", layers }] });
    expect(r.message).toContain(`20 "N20" (null) ... and 5 more ${DASH} pass one of these indexes`);
    expect(r.message).not.toContain('"N21"');
  });

  it("stops at the length budget for long names and keeps the next step (M8)", () => {
    const layers = Array.from({ length: 25 }, (_, i) => ({ kind: "solid" as const, name: `${i}`.padStart(60, "L") }));
    const r = fail(getLayerScript(12, 30), { comps: [{ id: 12, name: "Main", layers }] });
    expect(r.message.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(Number(/ \.\.\. and (\d+) more /.exec(r.message)![1])).toBeGreaterThan(layers.length - 20);
    expect(scriptErrorText(enrichAeError(scriptError(r), getLayerScript(12, 30)) as ScriptError)).toMatch(/\(ae_get_comp lists every layer\)\.$/);
  });

  it("says to add a layer when the comp is empty, and names the parent role", () => {
    expect(fail(getLayerScript(12, 1), { comps: [{ id: 12, name: "Main", layers: [] }] }).message).toBe(
      `Layer index 1 is out of range: "Main" (id 12) has no layers ${DASH} add one first (ae_add_layer).`,
    );
    expect(fail(setLayerPropsScript(12, 2, { parentIndex: 9 })).message).toMatch(/^Parent layer index 9 is out of range \(1\.\.3\) in "Main" \(id 12\): /);
  });
});

describe("__prop (property paths, acceptance 2)", () => {
  const FX: CompSpec = {
    id: 12,
    name: "Main",
    layers: [
      { kind: "text", name: "Title" },
      { kind: "shape", name: "Shape Layer 1", shapes: ["Shape 1", "Shape 2"] },
      { kind: "solid", name: "BG", effects: ["ADBE Gaussian Blur 2"] },
      { kind: "solid", name: "Plain" },
      { kind: "shape", name: "Twins", shapes: ["Shape 1", "Shape 1"] },
      { kind: "camera", name: "Camera 1" },
      { kind: "solid", name: "Masked", masks: ["Mask 1", "Mask 2"] },
      { kind: "solid", name: "Painted", effects: ["ADBE Paint"], strokes: ["Brush 1", "Brush 2"] },
      { kind: "shape", name: "Empty Shape" },
      { kind: "solid", name: "Cards", effects: [CARD_DANCE_MATCH] },
      { kind: "solid", name: "Particles", effects: ["ADBE Playgnd"] },
    ],
  };
  const spec = { comps: [FX] };
  const path = (layerIndex: number, p: string[], options?: HostOptions) => fail(getKeyframesScript(12, layerIndex, "position", p), spec, options);

  it("on a text layer names the layer, the resolved part, the failing segment and the children", () => {
    const script = setExpressionScript(12, 1, "position", ["ADBE Text Properties", "ADBE Text Documnt"], "time");
    const r = fail(script, spec);
    expect(r.message).toBe(
      'Property path not found on layer 1 "Title" (text): segment "ADBE Text Documnt" not found under ["ADBE Text Properties"]; ' +
        `children here: ["ADBE Text Document", "ADBE Text Path Options", "ADBE Text More Options", "ADBE Text Animators"] ${DASH} use one of these names.`,
    );
    const list = /children here: (\[.*\]) —/.exec(r.message)![1]!;
    expect(JSON.parse(list)).toContain("ADBE Text Document");
    expect(aeListSuggestions(r.message)).toEqual(["ADBE Text Document"]);
    expect(locateAeError(script, r.line ?? undefined)).toEqual({ kind: "helper", helper: "__prop" });
  });

  it("explains a miss by the layer's kind instead of listing children (D7)", () => {
    const r = path(2, ["ADBE Text Properties", "ADBE Text Document"]);
    expect(r.message).toBe(
      `Property path not found on layer 2 "Shape Layer 1" (shape): "ADBE Text Properties" exists only on text layers ${DASH} address a text layer (ae_get_comp lists each layer's kind).`,
    );
    expect(r.message).not.toContain("children here");
    expect(aeListSuggestions(r.message)).toEqual([]);
  });

  it("stops at a leaf in the middle of a path", () => {
    expect(path(3, ["ADBE Transform Group", "ADBE Position", "X"]).message).toBe(
      `Property path not found on layer 3 "BG" (solid): "ADBE Position" is a property, not a group, so nothing named "X" is under it ${DASH} end the path at "ADBE Position".`,
    );
  });

  it("degrades without PropertyType: the leaf has nothing under it", () => {
    const r = path(3, ["ADBE Transform Group", "ADBE Position", "X"], { noPropertyType: true });
    expect(r.message).toBe(
      'Property path not found on layer 3 "BG" (solid): segment "X" not found under ["ADBE Transform Group", "ADBE Position"], which has nothing under it ' +
        `${DASH} if "ADBE Position" is the property you want, end the path there; otherwise check the path (ae_get_layer lists the layer's effects).`,
    );
    expect(r.message).not.toContain(`[] ${DASH}`);
  });

  it("lists in the caller's vocabulary: display names for a display-name segment (M6)", () => {
    const blur = path(3, ["ADBE Effect Parade", "Gaussian Blur", "Bluriness"]);
    expect(blur.message).toBe(
      'Property path not found on layer 3 "BG" (solid): segment "Bluriness" not found under ["ADBE Effect Parade", "Gaussian Blur"]; ' +
        `children here: ["Blurriness", "Blur Dimensions", "Repeat Edge Pixels"] ${DASH} use one of these names.`,
    );
    expect(aeListSuggestions(blur.message)).toEqual(["Blurriness"]);
    const xf = path(3, ["Transform", "Positon"]);
    expect(xf.message).toContain('children here: ["Anchor Point", "Position", "Scale", "Rotation", "Opacity"]');
    expect(aeListSuggestions(xf.message)).toEqual(["Position"]);
  });

  it("lists shape groups by name, never their shared match name (M17)", () => {
    const r = path(2, ["ADBE Root Vectors Group", "Shape 3"]);
    expect(r.message).toContain(`children here: ["Shape 1", "Shape 2"] ${DASH} use one of these names.`);
    expect(r.message).not.toContain("ADBE Vector Group");
    const twins = path(5, ["ADBE Root Vectors Group", "Shape 3"]);
    expect(twins.message).toBe(
      'Property path not found on layer 5 "Twins" (shape): segment "Shape 3" not found under ["ADBE Root Vectors Group"]; children here: ["Shape 1", "Shape 1"]; ' +
        `repeated: ["Shape 1"] ${DASH} a path cannot tell repeated names apart; rename them in After Effects so each is unique, then pass one.`,
    );
    expect(twins.message).not.toContain("use one of these names");
    // "Shape 1" is one edit from "Shape 3", but it names two groups: never a suggestion (R6).
    const enriched = enrichAeError(scriptError(twins), getKeyframesScript(12, 5, "position", ["ADBE Root Vectors Group", "Shape 3"])) as ScriptError;
    expect(enriched.details.suggestions).toBeUndefined();
    expect(scriptErrorText(enriched)).not.toContain("Did you mean");
  });

  it("repeated names in a group users cannot rename point to every copy's match name, the name asked about first (R18, F5, G2)", () => {
    const r = path(10, ["ADBE Effect Parade", "Card Dance", "Sorce"]);
    // Each match name is "APC CardDanceCam-" and a number, so only the numbers are written. The 68
    // named parameters are counted; the 12 empty-named ones are not.
    expect(r.message).toBe(
      'Property path not found on layer 10 "Cards" (solid): segment "Sorce" not found under ["ADBE Effect Parade", "Card Dance"]; ' +
        `children here: ${list(CARD_NAMES.slice(0, 10))} (+58 more); repeated: ${list(CARD_REPEATED)} ${cardAdvice(nameFirst("Source"))}`,
    );
    expect(r.message).not.toContain("rename");
    // "Source" is close, but it names two parameters: no suggestion (R6).
    expect(aeListSuggestions(r.message)).toEqual([]);
  });

  it("finds a repeat past the listed window, names what repeats, and gives every copy's match name (F5)", () => {
    const shown = ["Cannon", "Position", "Barrel Radius", "Particles Per Second", "Direction", "Direction Random Spread", "Velocity", "Velocity Random Spread", "Color", "Particle Radius"];
    const r = path(11, ["ADBE Effect Parade", "Particle Playground", "Positon"]);
    // Only the first 10 children are listed; the second "Position", "Color" and "Particle Radius" are 21-23.
    // "Position" shares the most leading characters with "Positon", then "Particle Radius" (one).
    expect(r.message).toBe(
      'Property path not found on layer 11 "Particles" (solid): segment "Positon" not found under ["ADBE Effect Parade", "Particle Playground"]; ' +
        `children here: ${list(shown)} (+13 more); repeated: ["Position", "Color", "Particle Radius"] ` +
        `${DASH} a repeated name reaches only the first of them; pass the match name instead (by match name, "ADBE Playgnd-" + the number: ` +
        '"Position": [0002, 0021]; "Particle Radius": [0010, 0023]; "Color": [0009, 0022]).',
    );
    // "Position" is one edit away and listed once, but it names two parameters: no suggestion.
    expect(aeListSuggestions(r.message)).toEqual([]);
    expect(r.message).not.toContain("use one of these names");
  });

  it("an empty group says it is empty and never offers to end the path at it (R11)", () => {
    const animators = path(1, ["ADBE Text Properties", "ADBE Text Animators", "Animator 1", "X"]);
    expect(animators.message).toBe(
      'Property path not found on layer 1 "Title" (text): segment "Animator 1" not found under ["ADBE Text Properties", "ADBE Text Animators"], ' +
        `which is an empty group ${DASH} nothing can be addressed under "ADBE Text Animators" until something is added there; check the path.`,
    );
    const byDisplay = path(1, ["Text", "Animators", "Animator 1"]);
    expect(byDisplay.message).toContain(`which is an empty group ${DASH} nothing can be addressed under "Animators" until something is added there; check the path.`);
    const contents = path(9, ["ADBE Root Vectors Group", "Shape 1"]);
    expect(contents.message).toBe(
      'Property path not found on layer 9 "Empty Shape" (shape): segment "Shape 1" not found under ["ADBE Root Vectors Group"], ' +
        `which is an empty group ${DASH} nothing can be addressed under "ADBE Root Vectors Group" until something is added there; check the path.`,
    );
    for (const m of [animators.message, byDisplay.message, contents.message]) {
      expect(m).not.toContain("end the path there");
      expect(m).not.toContain("ae_get_layer lists the layer's effects");
    }
  });

  it("builds the message head only for a miss, so a path that resolves never reads the layer's name or kind (K4)", () => {
    const host = aeHost(spec);
    const layer = host.comp(12).layer(3);
    const mn = layer.matchName as string;
    let reads = 0;
    Object.defineProperty(layer, "matchName", {
      configurable: true,
      get: () => {
        reads++;
        return mn;
      },
    });
    expect(host.eval(getKeyframesScript(12, 3, "position", ["ADBE Effect Parade", "Gaussian Blur", "Blurriness"])).ok).toBe(true);
    expect(reads).toBe(0);
  });

  it("a layer whose kind cannot be read still gets the path miss, not the read failure (K4)", () => {
    const host = aeHost(spec);
    Object.defineProperty(host.comp(12).layer(3), "matchName", {
      configurable: true,
      get: () => {
        throw new host.VmError("After Effects error: Object is invalid");
      },
    });
    const r = host.eval(getKeyframesScript(12, 3, "position", ["ADBE Text Properties", "ADBE Text Document"])) as Extract<EvalReply, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(
      new RegExp(`^Property path not found on layer 3 "BG" \\(unknown kind\\): segment "ADBE Text Properties" not found at the top of the layer; children here: \\[.*\\] ${DASH} use one of these names\\.$`),
    );
  });

  it("lists shape groups and masks by name for a match-name segment too: the fixed set decides (M17, R19)", () => {
    // Without PropertyType the INDEXED_GROUP check cannot answer, so only the __BY_NAME table can.
    for (const options of [{}, { noPropertyType: true }]) {
      const shapes = path(2, ["ADBE Root Vectors Group", "ADBE Vector Grp"], options);
      expect(shapes.message).toContain('children here: ["Shape 1", "Shape 2"]');
      expect(shapes.message).not.toContain("ADBE Vector Group");
      const masks = path(7, ["ADBE Mask Parade", "ADBE Mask Atm"], options);
      expect(masks.message).toContain('children here: ["Mask 1", "Mask 2"]');
      expect(masks.message).not.toContain("ADBE Mask Atom");
    }
  });

  it("lists an indexed group outside the fixed set by name, not the match name its children share (M17, R16)", () => {
    const r = path(8, ["ADBE Effect Parade", "ADBE Paint", "ADBE Paint Group", "ADBE Paint Atm"]);
    expect(r.message).toContain('children here: ["Brush 1", "Brush 2"]');
    expect(r.message).not.toContain("ADBE Paint Atom");
  });

  it("answers an empty Effect Parade or Mask Parade with the tool that fills it (M5)", () => {
    const fx = path(4, ["ADBE Effect Parade", "Gaussian Blur", "Blurriness"]);
    expect(fx.message).toBe(
      `Property path not found on layer 4 "Plain" (solid): segment "Gaussian Blur" not found under ["ADBE Effect Parade"], which is empty ${DASH} the layer has no effects; apply one first (ae_apply_effect), or check the path.`,
    );
    const masks = path(4, ["ADBE Mask Parade", "Mask 1"]);
    expect(masks.message).toContain(`which is empty ${DASH} the layer has no masks; add one first (ae_add_mask), or check the path.`);
    for (const m of [fx.message, masks.message]) expect(m).not.toContain(`[] ${DASH}`);
  });

  it("says which transform names exist for an unknown shorthand", () => {
    const r = fail(wrapAe('\n  var c = __comp(12);\n  return __prop(c.layer(1), "skew", null);'), spec);
    expect(r.message).toBe(`Unknown transform property "skew" ${DASH} use position, scale, rotation, opacity or anchorPoint, or pass propertyPath.`);
  });
});

describe("list budgets (M8)", () => {
  it("__list keeps 50 names of 60 quote characters within 600 characters plus the count", () => {
    const quotes = '"'.repeat(60);
    const r = aeHost().eval(wrapAe(`\n  var n = [], i;\n  for (i = 0; i < 50; i++) { n.push(${JSON.stringify(quotes)}); }\n  return __list(n, 50, __BUDGET);`));
    expect(r.ok).toBe(true);
    const out = (r as { value: string }).value;
    const m = /^(\[.*\]) \(\+(\d+) more\)$/.exec(out);
    expect(m).not.toBeNull();
    expect(m![1]!.length).toBeLessThanOrEqual(602);
    expect((JSON.parse(m![1]!) as string[]).length + Number(m![2])).toBe(50);
  });

  it("cuts a path prefix at 300 characters", () => {
    const r = aeHost().eval(wrapAe('\n  var p = [], i;\n  for (i = 0; i < 30; i++) { p.push("Segment number " + i + " of the path"); }\n  return __list(p, 30, __PATH_BUDGET);'));
    const out = (r as { value: string }).value;
    const m = /^(\[.*\]) \(\+(\d+) more\)$/.exec(out)!;
    expect(m[1]!.length).toBeLessThanOrEqual(302);
  });
});

describe("message length: a miss that lists children fits under the server's cap (G3)", () => {
  /** What __miss keeps a message within (__MSG in HELPERS): the server's cap less room for redaction. */
  const MSG = 1400;
  /** __q in TypeScript: a name as a host message quotes it. */
  const quoted = (name: string): string => `"${name.slice(0, AE_NAME_CUT).replace(/["\\]/g, "\\$&")}${name.length > AE_NAME_CUT ? "..." : ""}"`;
  /** 64 quote characters: the longest a name gets once quoted (124 units: 60 escaped, the mark, the quotes). */
  const Q = '"'.repeat(64);
  /** 15 names of 64 units, each 124 once quoted (58 quotes, a letter, backslashes), 3 copies of each. */
  const NAMES = Array.from({ length: 15 }, (_, d) => `${'"'.repeat(58)}${String.fromCharCode(65 + d)}\\\\\\\\x`);
  const ASKED = `${NAMES[2]}?`; // nearest to the third name, which must come first

  /** A named group the fake host can hold anywhere. */
  const group = (matchName: string, name: string, kids: unknown[]): Record<string, unknown> => ({
    matchName,
    name,
    propertyType: 6213, // PropertyType.NAMED_GROUP in the fake host
    kids,
    get numProperties() {
      return kids.length;
    },
    property(k: number | string) {
      return typeof k === "number" ? (kids[k - 1] ?? null) : (kids.find((c) => (c as { name: string }).name === k) ?? null);
    },
  });

  type Form = "numbers" | "long prefix" | "whole match names";
  /**
   * Layer 1 (named Q) of comp 12 carries an effect named Q; `depth` groups named Q0, Q1... sit
   * between the effect and the repeated parameters, whose match names take `form`.
   */
  function extreme(form: Form, depth: number): { host: AeHost; path: string[] } {
    const host = aeHost({ comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: Q, effects: [CARD_DANCE_MATCH] }] }] });
    const fx = host.comp(12).layer(1).property("ADBE Effect Parade").property(1);
    fx.name = Q;
    const leafProto = fx.kids[0];
    let parent = fx;
    const path = ["ADBE Effect Parade", Q];
    for (let i = 0; i < depth; i++) {
      const g = group(`VEND Deep ${i}`, `${Q}${i}`, []);
      parent.kids.splice(0, parent.kids.length, g);
      parent = g;
      path.push(`${Q}${i}`);
    }
    if (form === "long prefix") parent.matchName = '"'.repeat(59); // the longest prefix still written whole
    const prefix = `${String(parent.matchName)}-`;
    const kids = [0, 1, 2].flatMap(() => NAMES).map((name, i) => ({
      ...leafProto,
      name,
      matchName: form === "whole match names" ? `${Q}${i}` : `${prefix}${String(i + 1).padStart(4, "0")}`,
    }));
    parent.kids.splice(0, parent.kids.length, ...kids);
    return { host, path: [...path, ASKED] };
  }

  /** The bound, the advice, and the asked-for name's entry first, all inside what the paragraph shows. */
  function checkMiss(host: AeHost, script: string, label: string, entryFirst: boolean): void {
    const r = failIn(host, script);
    expect(r.message.length, label).toBeLessThanOrEqual(MSG);
    expect(scriptErrorText(enrichAeError(scriptError(r), script) as ScriptError), label).toContain(r.message);
    if (entryFirst) {
      expect(r.message, label).toContain("a repeated name reaches only the first of them; pass the match name instead (by match name");
      expect(r.message, label).toMatch(new RegExp(`(?:the number|by match name): ${escapeRegExp(quoted(NAMES[2]!))}: \\[`));
    }
  }

  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("__repMatch keeps to the room __pick gives it when that is under __BUDGET, and always shows the first name", () => {
    // 40 children, "Name 0" to "Name 9" four times each; match names "ADBE X-1000" to "ADBE X-1039".
    const run = (room: number): string =>
      (
        aeHost().eval(
          wrapAe(
            "\n  var kids = [], i;" +
              '\n  for (i = 0; i < 40; i++) { kids.push({ name: "Name " + (i % 10), matchName: "ADBE X-" + (1000 + i) }); }' +
              '\n  var g = { matchName: "ADBE X", numProperties: 40, property: function (k) { return kids[k - 1]; } };' +
              `\n  return __repMatch(g, ["Name 3", "Name 0", "Name 1", "Name 2"], ${room});`,
          ),
        ) as { ok: true; value: string }
      ).value;
    const first = ', "ADBE X-" + the number: "Name 3": [1003, 1013, 1023, 1033]';
    expect(run(70)).toBe(`${first} (+3 more)`); // the second name would need 36 more, and the count 10
    expect(run(70).length).toBeLessThanOrEqual(70);
    expect(run(10)).toBe(`${first} (+3 more)`); // the first name even without room for it
    expect(run(5000)).toBe(`${first}; "Name 0": [1000, 1010, 1020, 1030]; "Name 1": [1001, 1011, 1021, 1031]; "Name 2": [1002, 1012, 1022, 1032]`);
  });

  it("a property path or a parameter, with names full of quotes, a long path, and match names in every form", () => {
    for (const form of ["numbers", "long prefix", "whole match names"] as const) {
      for (const depth of [0, 4]) {
        const { host, path } = extreme(form, depth);
        checkMiss(host, getKeyframesScript(12, 1, "position", path), `${form}, path depth ${depth}`, true);
      }
      const { host } = extreme(form, 0);
      checkMiss(host, setEffectParamScript(12, 1, 1, ASKED, 5), `${form}, ae_set_effect_param`, true);
    }
  });

  it("an effect or a layer-style parameter, with names full of quotes that repeat", () => {
    const effects = aeHost({ comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: Q, effects: Array.from({ length: 45 }, () => "ADBE Glo2") }] }] });
    effects.comp(12).layer(1).property("ADBE Effect Parade").kids.forEach((e: { name: string }, i: number) => (e.name = NAMES[i % 15]!));
    checkMiss(effects, setEffectParamScript(12, 1, ASKED, "Glow Radius", 5), "effect", false);

    const styled = aeHost({ comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: Q, styles: ["dropShadow"] }] }] });
    const shadow = styled.comp(12).layer(1).property("ADBE Layer Styles").property("dropShadow/enabled");
    const proto = shadow.kids[0];
    shadow.kids.splice(0, shadow.kids.length, ...[0, 1, 2].flatMap(() => NAMES).map((name, i) => ({ ...proto, name, matchName: `dropShadow/${Q}${i}` })));
    checkMiss(styled, setLayerStyleParamScript(12, 1, "dropShadow", ASKED, 5), "layer style", false);
  });
});

describe("builders that resolve before the undo group", () => {
  it("setLayerPropsScript checks the parent before changing anything (M9)", () => {
    const r = fail(setLayerPropsScript(12, 2, { opacity: 10, parentIndex: 9 }));
    expect(r.message).toMatch(/^Parent layer index 9 is out of range/);
    expect(r.host.mutations).toEqual([]);
    expect(r.host.undo.begin).toBe(0);
  });

  it("a valid parent still applies", () => {
    const host = aeHost();
    expect(host.eval(setLayerPropsScript(12, 2, { opacity: 10, parentIndex: 1 })).ok).toBe(true);
    expect(host.mutations).toEqual(["Opacity.setValue", "layer.parent"]);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
  });

  it("addLayerScript looks the footage item up first and says what to pass (M4/M11)", () => {
    const spec = { comps: [MAIN], footage: [{ id: 7, name: "clip.mov" }], folders: [{ id: 5, name: "Assets" }] };
    const unknown = fail(addLayerScript({ compId: 12, kind: "footage", itemId: 999 }), spec);
    expect(unknown.message).toBe(`No project item with id 999 ${DASH} pass a footage item id (ae_list_footage) or a composition id (ae_list_compositions).`);
    const none = fail(addLayerScript({ compId: 12, kind: "footage" }), spec);
    expect(none.message).toBe(`kind 'footage' needs itemId ${DASH} pass a footage item id (ae_list_footage) or a composition id (ae_list_compositions).`);
    const folder = fail(addLayerScript({ compId: 12, kind: "footage", itemId: 5 }), spec);
    expect(folder.message).toBe(`Item 5 "Assets" is a folder, not footage or a composition ${DASH} pass a footage item id (ae_list_footage) or a composition id (ae_list_compositions).`);
    for (const r of [unknown, none, folder]) {
      expect(r.host.undo.begin).toBe(0);
      expect(r.host.mutations).toEqual([]);
    }
    const host = aeHost(spec);
    expect(host.eval(addLayerScript({ compId: 12, kind: "footage", itemId: 7 })).ok).toBe(true);
    expect(host.mutations).toEqual(["layers.add"]);
  });
});

describe("effects and parameters", () => {
  const LAYERS: CompSpec = {
    id: 12,
    name: "Main",
    layers: [
      { kind: "solid", name: "BG", effects: ["ADBE Gaussian Blur 2"] },
      { kind: "solid", name: "Plain" },
      { kind: "camera", name: "Camera 1" },
    ],
  };
  const spec = { comps: [LAYERS] };

  it("setEffectParamScript lists the layer's effects for an unknown effect", () => {
    const r = fail(setEffectParamScript(12, 1, "Gausian Blur", "Blurriness", 5), spec);
    expect(r.message).toBe(
      `Effect not found on layer 1 "BG" (solid): "Gausian Blur"; effects on this layer: ["Gaussian Blur"] ${DASH} pass one of these names, or the effect's index (1 = first).`,
    );
    expect(aeListSuggestions(r.message)).toEqual(["Gaussian Blur"]);
  });

  it("setEffectParamScript gives no suggestion for an effect index, even next to a numeric name (R14)", () => {
    const fifty: ProjectSpec = {
      comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: "BG", effects: ["VEND Fifty", "ADBE Gaussian Blur 2"] }] }],
      effects: [...AE_EFFECTS, ["VEND Fifty", "50"]],
    };
    const r = fail(setEffectParamScript(12, 1, 5, "Blurriness", 5), fifty);
    expect(r.message).toContain('"5"; effects on this layer: ["50", "Gaussian Blur"]');
    expect(closestNames("5", ["50", "Gaussian Blur"], { normalize: stripAeVendor })).toEqual(["50"]); // what the guard prevents
    expect(aeListSuggestions(r.message)).toEqual([]);
  });

  it("setEffectParamScript lists parameters in the vocabulary the caller used (M6)", () => {
    const display = fail(setEffectParamScript(12, 1, 1, "Bluriness", 5), spec);
    expect(display.message).toBe(
      `Parameter not found on effect "Gaussian Blur": "Bluriness"; parameters: ["Blurriness", "Blur Dimensions", "Repeat Edge Pixels"] ${DASH} use one of these names.`,
    );
    expect(aeListSuggestions(display.message)).toEqual(["Blurriness"]);
    const match = fail(setEffectParamScript(12, 1, 1, "ADBE Gaussian Blur 2-0009", 5), spec);
    expect(match.message).toContain('parameters: ["ADBE Gaussian Blur 2-0001", "ADBE Gaussian Blur 2-0002", "ADBE Gaussian Blur 2-0003"]');
  });

  it("setEffectParamScript on a layer without effects, and on a camera (null layers, the home of expression controls, are named: R12)", () => {
    expect(fail(setEffectParamScript(12, 2, 1, "Blurriness", 5), spec).message).toBe(`Layer 2 "Plain" (solid) has no effects ${DASH} apply one first (ae_apply_effect).`);
    expect(fail(setEffectParamScript(12, 3, 1, "x", 0), spec).message).toBe(
      `Layer 3 "Camera 1" (camera) cannot have effects ${DASH} address a footage, solid, text, shape, null, adjustment or precomp layer.`,
    );
  });

  it("setEffectParamScript: repeated parameter names point to the match names, never to renaming (R18)", () => {
    const r = fail(setEffectParamScript(12, 1, 1, "Sorce", 5), CARDS);
    expect(r.message).toBe(
      `Parameter not found on effect "Card Dance": "Sorce"; parameters: ${list(CARD_NAMES.slice(0, 20))} (+48 more); ` +
        `repeated: ${list(CARD_REPEATED)} ${cardAdvice(nameFirst("Source"))}`,
    );
    expect(r.message).not.toContain("rename");
    expect(aeListSuggestions(r.message)).toEqual([]);
    // The match name the message offers for the second Source (parameter 15) resolves to it, not to the first (10).
    const host = aeHost(CARDS);
    expect(host.eval(setEffectParamScript(12, 1, 1, `${CARD_DANCE_MATCH}-0024`, 5)).ok).toBe(true);
    const fx = host.comp(12).layer(1).property("ADBE Effect Parade").property(1);
    expect([fx.property(10).value, fx.property(15).value]).toEqual([0, 5]);
  });

  it("the full Card Dance: the name asked about comes first and every repeated name keeps every copy, so the eighth Offset can be passed (G2)", () => {
    const scripts = [setEffectParamScript(12, 1, 1, "Ofset", 5), getKeyframesScript(12, 1, "position", ["ADBE Effect Parade", "Card Dance", "Ofset"])];
    for (const script of scripts) {
      const r = fail(script, CARDS);
      expect(r.message.endsWith(`; repeated: ${list(CARD_REPEATED)} ${cardAdvice(nameFirst("Offset"))}`), r.message).toBe(true);
      expect(r.message).toContain('"Offset": [0022, 0028, 0034, 0040, 0046, 0052, 0058, 0064]; "Source": ');
      // None of it is cut: the paragraph carries the whole host message.
      expect(scriptErrorText(enrichAeError(scriptError(r), script) as ScriptError)).toContain(r.message);
    }
    // The eighth Offset is parameter 47.
    const host = aeHost(CARDS);
    expect(host.eval(setEffectParamScript(12, 1, 1, `${CARD_DANCE_MATCH}-0064`, 7)).ok).toBe(true);
    const fx = host.comp(12).layer(1).property("ADBE Effect Parade").property(1);
    expect([fx.property(12).value, fx.property(47).value]).toEqual([0, 7]);
  });

  it("the stand-in is Card Dance as After Effects 26.5 lists it, and the copies the tests pin are its own (live, 2026-10-10)", () => {
    expect(CARD_DANCE).toHaveLength(80);
    expect(CARD_DANCE.at(-1)).toEqual(["Compositing Options", "ADBE Effect Built In Params"]);
    const blanks = CARD_DANCE.filter(([name]) => name === "").map(([, mn]) => mn.slice(CARD_DANCE_MATCH.length + 1));
    expect(blanks).toEqual(["0027", "0037", "0047", "0057", "0067", "0077", "0087", "0097", "0117", "0133", "0149", "0159"]);
    expect(CARD_NAMES).toHaveLength(68);
    expect(CARD_DANCE.findIndex(([name]) => name === "Light Intensity") + 1).toBe(69);
    for (const name of CARD_REPEATED) {
      const copies = CARD_DANCE.filter(([n]) => n === name).map(([, mn]) => Number(mn.slice(CARD_DANCE_MATCH.length + 1)));
      expect(numbers(...copies), name).toBe(CARD_COPIES[name]);
    }
  });

  it("Card Dance's 12 empty-named parameters are in no list, no count, no repeat and no advice: nobody can pass that name (L2)", () => {
    // What After Effects 26.5 showed before: "" twice among the 20 listed, "" in "repeated:" with 12 numbers.
    const r = fail(setEffectParamScript(12, 1, 1, "Ofset", 5), CARDS);
    expect(r.message).toBe(
      `Parameter not found on effect "Card Dance": "Ofset"; parameters: ${list(CARD_NAMES.slice(0, 20))} (+48 more); ` +
        `repeated: ${list(CARD_REPEATED)} ${cardAdvice(nameFirst("Offset"))}`,
    );
    for (const script of [setEffectParamScript(12, 1, 1, "Ofset", 5), getKeyframesScript(12, 1, "position", ["ADBE Effect Parade", "Card Dance", "Ofset"])]) {
      const m = fail(script, CARDS).message;
      expect(m, m).not.toContain('""');
      expect(m.length).toBeLessThanOrEqual(1400);
      // "Offset" is one edit away but repeats, so nothing farther is offered either (H4); never "".
      expect(aeListSuggestions(m)).toEqual([]);
    }
    // In the match-name vocabulary every parameter has a name to pass, the topic ends included.
    const byMatch = fail(setEffectParamScript(12, 1, 1, "ADBE Nothing", 5), CARDS);
    expect(byMatch.message).toBe(
      `Parameter not found on effect "Card Dance": "ADBE Nothing"; parameters: ${list(CARD_DANCE.slice(0, 20).map(([, mn]) => mn))} (+60 more) ${DASH} use one of these names.`,
    );
    expect(byMatch.message).toContain(`"${CARD_DANCE_MATCH}-0027"`);
  });

  it("a group whose children all have an empty name lists none of them and says to pass a match name, never that it is empty (L2)", () => {
    const blank = (host: AeHost) => {
      for (const p of host.comp(12).layer(1).property("ADBE Effect Parade").property(1).kids) p.name = "";
    };
    const host = aeHost(spec);
    blank(host);
    const param = failIn(host, setEffectParamScript(12, 1, 1, "Blurriness", 5));
    expect(param.message).toBe(`Parameter not found on effect "Gaussian Blur": "Blurriness"; parameters: [] ${DASH} none of the 3 has a name; pass a match name instead.`);
    const pathHost = aeHost(spec);
    blank(pathHost);
    const path = failIn(pathHost, getKeyframesScript(12, 1, "position", ["ADBE Effect Parade", "Gaussian Blur", "Blurriness"]));
    expect(path.message).toBe(
      'Property path not found on layer 1 "BG" (solid): segment "Blurriness" not found under ["ADBE Effect Parade", "Gaussian Blur"]; ' +
        `children here: [] ${DASH} none of the 3 has a name; pass a match name instead.`,
    );
    for (const m of [param.message, path.message]) {
      expect(m).not.toContain("empty");
      expect(aeListSuggestions(m)).toEqual([]);
    }
    // By match name they are all there.
    expect(failIn(pathHost, getKeyframesScript(12, 1, "position", ["ADBE Effect Parade", "Gaussian Blur", "ADBE Nothing"])).message).toContain(
      'children here: ["ADBE Gaussian Blur 2-0001", "ADBE Gaussian Blur 2-0002", "ADBE Gaussian Blur 2-0003"]',
    );
  });

  it("a near miss of a repeated name lists that name first: equal but for case, then by the leading characters it shares (G2)", () => {
    const zpos = fail(setEffectParamScript(12, 1, 1, "Z Positon", 5), CARDS);
    // "Z Position" shares 7, "Z Rotation" 2, the rest none (they keep their order).
    expect(zpos.message).toContain(`${cardAdvice(["Z Position", "Z Rotation", ...CARD_REPEATED.filter((n) => n !== "Z Position" && n !== "Z Rotation")])}`);
    // It repeats, so it is never a suggestion; and it is nearer than any name that does not (H4).
    expect(aeListSuggestions(zpos.message)).toEqual([]);
    const lower = fail(getKeyframesScript(12, 1, "position", ["ADBE Effect Parade", "Card Dance", "offset"]), CARDS);
    expect(lower.message).toContain(cardAdvice(nameFirst("Offset")));
    // A longer repeated name that starts with the same characters, found earlier, still comes after it.
    const host = aeHost(CARDS);
    const fx = host.comp(12).layer(1).property("ADBE Effect Parade").property(1);
    fx.property(2).name = "Offset Random";
    fx.property(3).name = "Offset Random";
    expect(failIn(host, setEffectParamScript(12, 1, 1, "offset", 5)).message).toContain(
      `+ the number: "Offset": ${CARD_COPIES.Offset}; "Offset Random": [0004, 0006]; "Source": `,
    );
  });

  it("a near miss of a repeated name suggests no name farther away; a near miss of a unique name still gets its suggestions (H4)", () => {
    const paragraph = (script: string): string => scriptErrorText(enrichAeError(scriptError(fail(script, CARDS)), script) as ScriptError);
    // "Z Positon" is one edit from "Z Position", which repeats, and two from "X Position" and "Y Position", which do not.
    for (const script of [setEffectParamScript(12, 1, 1, "Z Positon", 5), getKeyframesScript(12, 1, "position", ["ADBE Effect Parade", "Card Dance", "Z Positon"])]) {
      expect(aeListSuggestions(fail(script, CARDS).message)).toEqual([]);
      const text = paragraph(script);
      expect(text).toContain(`the number: "Z Position": ${CARD_COPIES["Z Position"]}; `);
      expect(text).not.toContain("Did you mean");
    }
    // "X Positio" is one edit from "X Position", which does not repeat: the nearest name is unique, so the
    // suggestions stay, "Y Position" too, although "Z Position" (which repeats) is as close as it.
    const param = setEffectParamScript(12, 1, 1, "X Positio", 5);
    expect(aeListSuggestions(fail(param, CARDS).message)).toEqual(["X Position", "Y Position"]);
    expect(paragraph(param)).toContain('Did you mean "X Position" or "Y Position"?');
    // A path lists 10 children, "Y Position" not among them; "Z Position" is named as repeated.
    const path = getKeyframesScript(12, 1, "position", ["ADBE Effect Parade", "Card Dance", "X Positio"]);
    expect(aeListSuggestions(fail(path, CARDS).message)).toEqual(["X Position"]);
    expect(paragraph(path)).toContain('Did you mean "X Position"?');
    // A repeated name as close as the nearest unique one, ranked first among equals, still leaves that one.
    const head = 'Parameter not found on effect "E": "Shape 3"; parameters: ';
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2"]; repeated: ["Shape 1"] ${DASH} x`)).toEqual(["Shape 2"]);
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 22"]; repeated: ["Shape 1"] ${DASH} x`)).toEqual([]);
    // Every name at the smallest distance decides, not the one that sorts first among them: in either
    // order, the repeated name keeps the farther one out (Shape 22 and Shape 11 are two edits away).
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2", "Shape 22"]; repeated: ["Shape 1"] ${DASH} x`)).toEqual(["Shape 2"]);
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2", "Shape 11"]; repeated: ["Shape 2"] ${DASH} x`)).toEqual(["Shape 1"]);
  });

  it("writes whole match names when a copy's is not the effect's match name and a number, still the name asked about first (G2)", () => {
    const host = aeHost(CARDS);
    // Parameter 47 is the eighth Offset.
    host.comp(12).layer(1).property("ADBE Effect Parade").property(1).property(47).matchName = "VEND Card Offset";
    const r = failIn(host, setEffectParamScript(12, 1, 1, "Ofset", 5));
    const matchNames = (name: string): string[] => CARD_DANCE.filter(([n]) => n === name).map(([, mn]) => mn);
    const offsets = [...matchNames("Offset").slice(0, 7), "VEND Card Offset"];
    // Whole match names take more room: the names that do not fit are counted.
    expect(r.message.endsWith(`pass the match name instead (by match name: "Offset": ${list(offsets)}; "Source": ${list(matchNames("Source"))} (+6 more)).`), r.message).toBe(true);
    expect(r.message.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });

  it("setEffectParamScript: a parameter that repeats past the 20 listed still counts, and every copy's match name is given (F5)", () => {
    const particles: ProjectSpec = { comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: "Particles", effects: ["ADBE Playgnd"] }] }] };
    const r = fail(setEffectParamScript(12, 1, 1, "Positon", 5), particles);
    expect(r.message).toMatch(
      new RegExp(
        `; parameters: \\["Cannon", .*"Gravity"\\] \\(\\+3 more\\); repeated: \\["Position", "Color", "Particle Radius"\\] ${DASH} ` +
          'a repeated name reaches only the first of them; pass the match name instead \\(by match name, "ADBE Playgnd-" \\+ the number: "Position": \\[0002, 0021\\]; ',
      ),
    );
    // A positional list of match names cut at 300 characters stopped before the 21st; these never do.
    expect(r.message).toContain('"Particle Radius": [0010, 0023]; "Color": [0009, 0022]).');
    expect(aeListSuggestions(r.message)).toEqual([]);
    // A close name that does not repeat is still suggested.
    expect(aeListSuggestions(fail(setEffectParamScript(12, 1, 1, "Gravty", 5), particles).message)).toEqual(["Gravity"]);
    // The match name offered for the second copy reaches it, not the first.
    const host = aeHost(particles);
    expect(host.eval(setEffectParamScript(12, 1, 1, "ADBE Playgnd-0021", 7)).ok).toBe(true);
    const fx = host.comp(12).layer(1).property("ADBE Effect Parade").property(1);
    expect([fx.property(2).value, fx.property(21).value]).toEqual([0, 7]);
  });

  it("setEffectParamScript: an effect name that repeats past the 20 listed effects still counts (F5)", () => {
    const others = [
      "ADBE Gaussian Blur 2", "ADBE Box Blur2", "ADBE Bilateral", "ADBE Camera Lens Blur", "CC Cross Blur", "CC Radial Blur", "CC Radial Fast Blur",
      "CC Vector Blur", "ADBE Channel Blur", "ADBE Compound Blur", "ADBE Motion Blur", "ADBE Fast Blur", "ADBE Radial Blur", "ADBE Sharpen",
      "ADBE Smart Blur", "ADBE Unsharp Mask", "ADBE Lens Blur", "ADBE Fast Box Blur", "ADBE Noise",
    ];
    const glows: ProjectSpec = { comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: "BG", effects: ["ADBE Glo2", ...others, "ADBE Glo2"] }] }] };
    const r = fail(setEffectParamScript(12, 1, "Glw", "Glow Radius", 5), glows);
    expect(r.message).toContain(`(+1 more); repeated: ["Glow"] ${DASH} a repeated name reaches only the first of them; pass the effect's index (1 = first) instead.`);
    expect(aeListSuggestions(r.message)).toEqual([]);
  });

  it("applyEffectScript on a camera, and an unknown effect at the canAddProperty body line", () => {
    expect(fail(applyEffectScript(12, 3, "ADBE Gaussian Blur 2"), spec).message).toMatch(/^Layer 3 "Camera 1" \(camera\) cannot have effects/);
    const script = applyEffectScript(12, 1, "ADBE Gausian Blur 2");
    const r = fail(script, spec);
    // The requested name is quoted like every other name in a message (R7).
    expect(r.message).toBe(
      `${EFFECT_MISS}"ADBE Gausian Blur 2" (layer 1 "BG" (solid)) ${DASH} use an installed effect's match name, e.g. 'ADBE Gaussian Blur 2', or its display name.`,
    );
    expect(locateAeError(script, r.line ?? undefined)).toEqual({ kind: "body", bodyLine: bodyLineOf(script, "canAddProperty") });
    expect(r.host.mutations).toEqual([]);
  });

  it("the other kind-dependent messages name the layer", () => {
    expect(fail(setTextScript({ compId: 12, layerIndex: 1, text: "x" }), spec).message).toBe(
      `Layer 1 "BG" (solid) is not a text layer ${DASH} address a text layer (ae_get_comp lists each layer's kind).`,
    );
    expect(fail(addMaskScript({ compId: 12, layerIndex: 3, kind: "rectangle" }), spec).message).toBe(
      `Layer 3 "Camera 1" (camera) cannot take masks ${DASH} cameras and lights have none; address another layer.`,
    );
    expect(fail(getLayerStylesScript(12, 3), spec).message).toBe(
      `Layer 3 "Camera 1" (camera) has no layer styles ${DASH} cameras and lights cannot take styles; address another layer.`,
    );
  });

  it("LIST_INSTALLED_EFFECTS returns [matchName, displayName] pairs", () => {
    const r = aeHost().eval(LIST_INSTALLED_EFFECTS) as { ok: true; value: [string, string][] };
    expect(r.ok).toBe(true);
    expect(r.value.length).toBe(AE_EFFECT_ITEMS.length);
    expect(r.value).toContainEqual(["ADBE Gaussian Blur 2", "Gaussian Blur"]);
  });

  it("filteredEffectsScript returns a length-filtered subset that still ranks the right effect first (M22)", async () => {
    const q = stripAeVendor(fold("Gausian Blur"));
    expect(q).toBe("gausian blur");
    expect(suggestionThreshold(q)).toBe(3);
    const r = aeHost().eval(filteredEffectsScript(q, suggestionThreshold(q))) as { ok: true; value: [string, string][] };
    expect(r.ok).toBe(true);
    expect(r.value.length).toBeLessThan(AE_EFFECT_ITEMS.length);
    expect(r.value).toContainEqual(["ADBE Gaussian Blur 2", "Gaussian Blur"]);

    // Through the catalog: a slow full read switches it to the filtered read on the next connection.
    let now = 0;
    let epoch = 1;
    const sent: string[] = [];
    const host = aeHost();
    const bridge = fakeBridge(async (script) => {
      sent.push(script);
      if (script === LIST_INSTALLED_EFFECTS) now += SLOW_EFFECTS_READ_MS + 1;
      const reply = host.eval(script);
      if (!reply.ok) throw scriptError(reply.error);
      return reply.value as JsonValue;
    }, () => epoch);
    const catalog = new EffectCatalog(bridge, () => now);
    await catalog.candidates("x");
    epoch = 2;
    const miss = new ScriptError("after_effects", `${EFFECT_MISS}Gausian Blur (layer 1 "BG" (solid)) ${DASH} use an installed effect's match name.`, 5, { where: "body" });
    const out = (await withEffectSuggestions(catalog, miss, "Gausian Blur")) as ScriptError;
    expect(sent.at(-1)).toBe(filteredEffectsScript(q, 3));
    expect(out.details.suggestions?.[0]).toEqual({ name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" });
  });

  it("filteredEffectsScript's window keeps a margin for UTF-16 and NFC lengths, so it never drops a name the server ranks (K3)", () => {
    const q = stripAeVendor(fold("Gausian Blur"));
    const t = suggestionThreshold(q);
    const astral = ["VEND A Long Match Name Far From The Query", "Gausian Blur\u{1F600}ab"] as const;
    const decomposed = ["VEND Another Long Match Name Far Away", "Gausian Bluréxé"] as const;
    for (const [, displayName] of [astral, decomposed]) {
      // The server (code points, NFC) ranks it, although its UTF-16 length is further from the query than the threshold.
      expect(rank(q, [displayName], (n) => [n], { normalize: stripAeVendor }), displayName).toHaveLength(1);
      expect(Math.abs(displayName.length - q.length), displayName).toBeGreaterThan(t);
    }
    const r = aeHost({ comps: [MAIN], effects: [...AE_EFFECTS, astral, decomposed] }).eval(filteredEffectsScript(q, t)) as { ok: true; value: [string, string][] };
    expect(r.ok).toBe(true);
    expect(r.value).toContainEqual([...astral]);
    expect(r.value).toContainEqual([...decomposed]);
  });
});

// ---- every throw a builder or helper raises says what to do next (R7, R17) --------------

/** File, Folder and import stand-ins: the fake host models none of them. */
function fileStubs(host: AeHost, o: { exists?: boolean; canImportAs?: boolean; imports?: unknown } = {}): void {
  host.ctx["File"] = function (this: Record<string, unknown>, p: string) {
    this["fsName"] = p;
    this["exists"] = o.exists ?? false;
  };
  host.ctx["Folder"] = function (this: Record<string, unknown>) {
    this["exists"] = true;
    this["create"] = () => true;
  };
  host.ctx["ImportOptions"] = function (this: Record<string, unknown>) {
    this["canImportAs"] = () => o.canImportAs ?? false;
  };
  host.ctx["ImportAsType"] = { COMP: 1, COMP_CROPPED_LAYERS: 2 };
  host.app.project.importFile = () => o.imports;
}

/** The message split at its own " — " (one outside the names it quotes): the facts, then the next step. */
function factsAndNext(message: string): [string, string] | null {
  const masked = message.replace(/"(?:[^"\\]|\\.)*"/g, (q) => "x".repeat(q.length));
  const at = masked.indexOf(` ${DASH} `);
  return at < 0 ? null : [message.slice(0, at), message.slice(at + 3)];
}

describe("every throw says what to do next, so none needs the generic step (R7, R17)", () => {
  const STYLED: ProjectSpec = {
    comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: "BG", styles: ["dropShadow"] }, { kind: "camera", name: "Camera 1" }, { kind: "text", name: "Title" }] }],
  };
  const position = (host: AeHost) => host.comp(12).layer(1).property("ADBE Transform Group").property("ADBE Position");

  const cases: { name: string; script: string; spec?: ProjectSpec; setup?: (host: AeHost) => void; message?: string }[] = [
    // helpers
    { name: "__comp", script: getCompScript(99) },
    { name: "__layer", script: getLayerScript(12, 9) },
    { name: "__prop children", script: getKeyframesScript(12, 1, "position", ["ADBE Text Properties", "ADBE Text Documnt"]) },
    { name: "__prop kind", script: getKeyframesScript(12, 3, "position", ["ADBE Text Properties"]) },
    { name: "__prop transform", script: wrapAe('\n  var c = __comp(12);\n  return __prop(c.layer(1), "skew", null);') },
    { name: "__styles", script: getLayerStylesScript(12, 2), spec: STYLED },
    // builders
    { name: "open: no file", script: openProjectScript("C:/p/missing.aep"), setup: (h) => fileStubs(h) },
    { name: "save: never saved", script: saveProjectScript(undefined) },
    { name: "import: no file", script: importFootageScript("C:/p/missing.mov"), setup: (h) => fileStubs(h) },
    { name: "import as comp: no file", script: importAsCompScript("C:/p/missing.psd", false), setup: (h) => fileStubs(h) },
    {
      name: "import as comp: not importable",
      script: importAsCompScript("C:/p/flat.ai", false),
      setup: (h) => fileStubs(h, { exists: true }),
      message: `After Effects cannot import this file as a composition ${DASH} pass a layered .psd, or an .ai saved in RGB (not CMYK) with PDF compatibility.`,
    },
    {
      name: "import as comp: came in as footage",
      script: importAsCompScript("C:/p/flat.psd", false),
      setup: (h) => {
        const FootageItem = h.ctx["FootageItem"] as new () => object;
        fileStubs(h, { exists: true, canImportAs: true, imports: Object.assign(new FootageItem(), { id: 31, name: 'flat "v2".psd' }) });
      },
      message: `Imported "flat \\"v2\\".psd" (id 31) as footage, not as a composition, so the file may have only one layer ${DASH} add that footage with ae_add_layer (kind footage, itemId 31), or pass a layered .psd or .ai.`,
    },
    { name: "add layer: no itemId", script: addLayerScript({ compId: 12, kind: "footage" }) },
    { name: "add layer: unknown item", script: addLayerScript({ compId: 12, kind: "footage", itemId: 999 }) },
    { name: "add mask: camera", script: addMaskScript({ compId: 12, layerIndex: 2, kind: "rectangle" }), spec: STYLED },
    {
      name: "expression error",
      script: setExpressionScript(12, 1, "position", undefined, "wiggle("),
      setup: (h) => {
        const p = position(h);
        Object.defineProperty(p, "expressionError", { configurable: true, get: () => (p.expression === "wiggle(" ? "Syntax error: missing )" : "") });
      },
      message: `Expression error: Syntax error: missing ) ${DASH} fix the expression; the property keeps its previous one.`,
    },
    { name: "apply effect: camera", script: applyEffectScript(12, 2, "ADBE Gaussian Blur 2"), spec: STYLED },
    { name: "apply effect: unknown", script: applyEffectScript(12, 1, "ADBE Gausian Blur 2") },
    { name: "effect param: no effects", script: setEffectParamScript(12, 3, 1, "Blurriness", 5) },
    { name: "set text: not a text layer", script: setTextScript({ compId: 12, layerIndex: 3, text: "x" }) },
    {
      name: "style param: style missing",
      script: setLayerStyleParamScript(12, 1, "innerGlow", "Size", 5),
      spec: STYLED,
      message: `The innerGlow style is not on layer 1 "BG" (solid) ${DASH} add it first with ae_add_layer_style.`,
    },
    {
      name: "style param: parameter missing",
      script: setLayerStyleParamScript(12, 1, "dropShadow", "Distnce", 5),
      spec: STYLED,
      message:
        'Parameter not found on the dropShadow style of layer 1 "BG" (solid): "Distnce"; parameters: ["Blend Mode", "Color", "Opacity", "Angle", "Distance", "Size"] ' +
        `${DASH} use one of these names.`,
    },
    {
      name: "style param: match name missing",
      script: setLayerStyleParamScript(12, 1, "dropShadow", "dropShadow/p9", 5),
      spec: STYLED,
      message:
        'Parameter not found on the dropShadow style of layer 1 "BG" (solid): "dropShadow/p9"; parameters: ' +
        `["dropShadow/p1", "dropShadow/p2", "dropShadow/p3", "dropShadow/p4", "dropShadow/p5", "dropShadow/p6"] ${DASH} use one of these names.`,
    },
    {
      name: "remove style: not there",
      script: removeLayerStyleScript(12, 1, "satin"),
      spec: STYLED,
      message: `The satin style is not on layer 1 "BG" (solid) ${DASH} nothing to turn off; ae_get_layer_styles lists the styles on this layer.`,
    },
    {
      name: "add style: the menu command did not take",
      script: addLayerStyleScript(12, 1, "stroke"),
      spec: STYLED,
      setup: (h) => {
        h.ctx["$"] = { sleep: () => undefined };
        h.app.executeCommand = () => undefined;
        h.app.findMenuCommandId = () => 0;
        h.comp(12).openInViewer = () => undefined;
      },
      message:
        `Could not add the stroke layer style to layer 1 "BG" (solid): the Layer Styles menu command did not take ${DASH} ` +
        "close any open dialog in After Effects and retry; if it keeps failing, add the style from the Layer menu (Layer Styles) in After Effects.",
    },
    {
      name: "essential graphics: cannot add",
      script: addToEssentialGraphicsScript(12, 1, "position", undefined),
      setup: (h) => {
        position(h).canAddToMotionGraphicsTemplate = () => false;
      },
      message:
        'Property "Position" of layer 1 "Title" (text) cannot be added to Essential Graphics: its type is not supported, or the panel already has a control with that name ' +
        `${DASH} pass another property (a transform channel, sourceText or an effect control), or rename that control in the Essential Graphics panel, then retry.`,
    },
    {
      name: "essential graphics: refused",
      script: addToEssentialGraphicsScript(12, 1, "position", undefined),
      setup: (h) => {
        position(h).canAddToMotionGraphicsTemplate = () => true;
        position(h).addToMotionGraphicsTemplate = () => false;
      },
      message: `After Effects refused to add "Position" to the Essential Graphics panel of "Main" ${DASH} check that panel in After Effects, then retry or pass another property.`,
    },
    {
      name: "mogrt: never saved",
      script: exportMogrtScript(12, "C:/m", "LT", true),
      message:
        `The project has never been saved, and exporting a Motion Graphics template needs a saved project ${DASH} ` +
        "save it first with ae_save_project (pass a path ending in .aep), then retry.",
    },
    {
      name: "mogrt: not written",
      script: exportMogrtScript(12, "C:/m", "LT", false),
      setup: (h) => {
        fileStubs(h);
        Object.assign(h.app, { beginSuppressDialogs: () => undefined, endSuppressDialogs: () => undefined });
        Object.assign(h.app.project, { file: {}, save: () => undefined });
        h.comp(12).exportAsMotionGraphicsTemplate = () => false;
      },
      message:
        `After Effects did not write C:/m/LT.mogrt (export returned false): the folder is not writable, or the export failed ${DASH} ` +
        "pass a folder you can write to, then retry.",
    },
    {
      name: "mogrt: already there, overwrite false",
      script: exportMogrtScript(12, "C:/m", "LT", false),
      setup: (h) => {
        fileStubs(h, { exists: true });
        Object.assign(h.app.project, { file: {} });
      },
      message: `A file already exists at C:/m/LT.mogrt ${DASH} pass overwrite: true (the default) or another outputPath.`,
    },
    {
      name: "queue render: unknown name",
      script: queueRenderScript("Mian", "C:/r/main.mov", undefined),
      spec: { comps: [MAIN, { id: 15, name: "LT" }] },
      message: `No composition named "Mian"; compositions: ["Main", "LT"] ${DASH} pass one of these names exactly (ae_list_compositions lists them all).`,
    },
    {
      name: "queue render: no compositions",
      script: queueRenderScript("Main", "C:/r/main.mov", undefined),
      spec: { comps: [] },
      message: `No composition named "Main"; the project has no compositions ${DASH} create one with ae_create_comp, then queue it.`,
    },
    {
      name: "queue render: a dash inside the name",
      script: queueRenderScript(`Intro ${DASH} Final`, "C:/r/main.mov", undefined),
      message: `No composition named "Intro ${DASH} Final"; compositions: ["Main"] ${DASH} pass one of these names exactly (ae_list_compositions lists them all).`,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const host = aeHost(c.spec);
      c.setup?.(host);
      const r = failIn(host, c.script);
      if (c.message !== undefined) expect(r.message).toBe(c.message);
      const split = factsAndNext(r.message);
      expect(split, r.message).not.toBeNull();
      expect(split![0].trim(), r.message).not.toBe("");
      expect(split![1].trim().length, r.message).toBeGreaterThan(8);
      expect((enrichAeError(scriptError(r), c.script) as ScriptError).details.next, r.message).toBeUndefined();
    });
  }

  it("a listed parameter or composition name gets 'did you mean' (R17)", () => {
    expect(aeListSuggestions(fail(setLayerStyleParamScript(12, 1, "dropShadow", "Distnce", 5), STYLED).message)).toEqual(["Distance"]);
    expect(aeListSuggestions(fail(queueRenderScript("Mian", "C:/r/main.mov", undefined)).message)).toEqual(["Main"]);
  });

  it("ae_export_mogrt with overwrite false refuses an existing file before it saves or exports anything; overwrite true exports over it (F6)", () => {
    const setup = (h: AeHost, calls: string[]) => {
      fileStubs(h, { exists: true });
      Object.assign(h.app, { beginSuppressDialogs: () => calls.push("suppress"), endSuppressDialogs: () => undefined });
      Object.assign(h.app.project, { file: {}, save: () => calls.push("save") });
      h.comp(12).exportAsMotionGraphicsTemplate = () => calls.push("export") > 0;
    };
    const refused: string[] = [];
    const host = aeHost();
    setup(host, refused);
    const r = failIn(host, exportMogrtScript(12, "C:/m", "LT", false));
    expect(r.message).toMatch(/^A file already exists at C:\/m\/LT\.mogrt/);
    expect(refused).toEqual([]);
    expect(host.comp(12).motionGraphicsTemplateName).toBeUndefined();

    const written: string[] = [];
    const over = aeHost();
    setup(over, written);
    expect(over.eval(exportMogrtScript(12, "C:/m", "LT", true))).toEqual({ ok: true, value: { compName: "Main", name: "LT", outputPath: "C:/m/LT.mogrt", controllerCount: null } });
    expect(written).toEqual(["suppress", "save", "export"]);
  });

  it("renderCompHeadless's own failures say what to do next too", async () => {
    const answers = (save: JsonValue, info: JsonValue) => fakeBridge(async (script) => (script === saveProjectScript(undefined) ? save : info));
    await expect(renderCompHeadless(answers({ saved: true }, { projectPath: null, appFolder: "x", isWindows: true }), { compName: "Main", outputPath: "C:/r/a.mov" })).rejects.toThrow(
      `The project has no file ${DASH} save it first with ae_save_project (pass a path ending in .aep), then retry.`,
    );
    const missing = join(tmpdir(), "bf-ae16-no-aerender");
    const noExe = renderCompHeadless(answers({ path: "C:/p/a.aep", saved: true }, { projectPath: "C:/p/a.aep", appFolder: missing, isWindows: true }), { compName: "Main", outputPath: "C:/r/a.mov" });
    await expect(noExe).rejects.toThrow(new RegExp(`^aerender not found at .*bf-ae16-no-aerender.aerender\\.exe ${DASH} `));
  });
});

describe("aeListSuggestions", () => {
  it("parses each of the three list formats", () => {
    expect(aeListSuggestions('Property path not found on layer 1 "T" (text): segment "Positon" not found at the top of the layer; children here: ["Position", "Scale"] — use one of these names.')).toEqual(["Position"]);
    expect(aeListSuggestions('Effect not found on layer 1 "BG" (solid): "Glw"; effects on this layer: ["Glow", "Tint"] — pass one.')).toEqual(["Glow"]);
    expect(aeListSuggestions('Parameter not found on effect "Glow": "Glow Radiuss"; parameters: ["Glow Radius", "Glow Threshold"] — use one.')).toEqual(["Glow Radius"]);
  });

  it("gives nothing for a numeric query, an unparseable or absent list, or a non-list message", () => {
    // "50" is within the threshold of "5", so only the numeric-query guard keeps it out (R14).
    expect(aeListSuggestions('Effect not found on layer 1 "BG" (solid): "5"; effects on this layer: ["50", "Glow"] — x')).toEqual([]);
    expect(aeListSuggestions('Effect not found on layer 1 "BG" (solid): "12"; effects on this layer: ["Glow", "Tint", "CC 1"] — x')).toEqual([]);
    expect(aeListSuggestions('Parameter not found on effect "Glow": "Glw"; parameters: ["Glow", — x')).toEqual([]);
    expect(aeListSuggestions("Layer index 9 is out of range")).toEqual([]);
    expect(aeListSuggestions('Parameter not found on effect "Glow": "Glw"; parameters: [] — x')).toEqual([]);
  });

  it("never suggests a cut (63-character) name, and a cut query gives nothing (M7)", () => {
    const cut = `${"A".repeat(60)}...`;
    expect(aeListSuggestions(`Parameter not found on effect "E": "${"A".repeat(59)}B"; parameters: ["${cut}", "Other"] — x`)).toEqual([]);
    expect(aeListSuggestions(`Parameter not found on effect "E": "${cut}"; parameters: ["${"A".repeat(60)}"] — x`)).toEqual([]);
  });

  it("never suggests a name that repeats in the list, since it cannot pick one item; a unique close name still counts (R6)", () => {
    const head = 'Property path not found on layer 5 "Twins" (shape): segment "Shape 3" not found under ["ADBE Root Vectors Group"]; children here: ';
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 1"] — some of these names repeat`)).toEqual([]);
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 1", "Shape 2"] — some of these names repeat`)).toEqual(["Shape 2"]);
    expect(aeListSuggestions('Effect not found on layer 1 "BG" (solid): "Glw"; effects on this layer: ["Glow", "Glow"] — some names repeat; pass the index')).toEqual([]);
    expect(aeListSuggestions('Parameter not found on effect "Glow": "Colr"; parameters: ["Color", "Size", "Color"] — x')).toEqual([]);
  });

  it("leaves out a name the host says repeats, though it is listed once; gives nothing when that list is cut or does not parse (F5)", () => {
    const head = 'Property path not found on layer 5 "S" (shape): segment "Shape 3" not found under ["ADBE Root Vectors Group"]; children here: ';
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2"] — use one of these names.`)).toEqual(["Shape 1", "Shape 2"]);
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2"]; repeated: ["Shape 2"] — x`)).toEqual(["Shape 1"]);
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2"] (+30 more); repeated: ["Shape 2"] — x`)).toEqual(["Shape 1"]);
    // The host could not list every repeated name: any listed name might be one.
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2"]; repeated: ["Shape 2"] (+1 more) — x`)).toEqual([]);
    expect(aeListSuggestions(`${head}["Shape 1", "Shape 2"]; repeated: ["Shape 2" — x`)).toEqual([]);
  });

  it("reads no message longer than the helpers write, and no name longer than __q writes (H1)", () => {
    const head = 'Parameter not found on effect "Glow": "Glw"; parameters: ["Glow", "Tint"]';
    expect(aeListSuggestions(`${head} ${DASH} x`)).toEqual(["Glow"]);
    // A list message is at most __MSG (1400) units; a longer one is not a list message.
    expect(aeListSuggestions(`${head} ${DASH} ${"x".repeat(MESSAGE_LIMIT)}`)).toEqual([]);
    // __q writes at most 63 units of a name (60, then "..."): a longer query or name is not one it wrote.
    const long = "Glow".padEnd(AE_NAME_CUT + 4, "w");
    expect(aeListSuggestions(`Parameter not found on effect "Glow": "${long}x"; parameters: ["${long}"] ${DASH} x`)).toEqual([]);
    expect(aeListSuggestions(`Parameter not found on effect "Glow": "${long.slice(0, -1)}x"; parameters: ["${long}", "Tint"] ${DASH} x`)).toEqual([]);
    expect(aeListSuggestions(`Parameter not found on effect "Glow": "Glw"; parameters: ["Glow", "${long}"] ${DASH} x`)).toEqual(["Glow"]);
  });

  it("never offers the empty name, listed or named as repeated: nobody can pass it (L2)", () => {
    // A short query is within the threshold (2) of "": without the rule it would be offered, even first.
    const head = 'Parameter not found on effect "E": "Ab"; parameters: ';
    expect(aeListSuggestions(`${head}["", "Ac"] ${DASH} x`)).toEqual(["Ac"]);
    expect(aeListSuggestions(`${head}["", "Abcd"] ${DASH} x`)).toEqual(["Abcd"]);
    expect(aeListSuggestions(`${head}["", "Zzzzz"] ${DASH} x`)).toEqual([]);
    expect(aeListSuggestions(`${head}["Ac", "Zzzzz"]; repeated: [""] ${DASH} x`)).toEqual(["Ac"]);
  });

  it("parses ae_queue_render's composition list (R17)", () => {
    expect(aeListSuggestions('No composition named "Mian"; compositions: ["Main", "LT"] — pass one of these names exactly')).toEqual(["Main"]);
  });

  it("still parses a path whose names contain ';'", () => {
    const m = 'Property path not found on layer 1 "a;b" (solid): segment "Blr;x" not found under ["ADBE Effect Parade", "Bl;ur"]; children here: ["Blr;y", "Other"] — use one of these names.';
    expect(aeListSuggestions(m)).toEqual(["Blr;y"]);
  });
});

describe("aeExcerpt", () => {
  afterEach(() => setRedactionSecrets([]));
  const script = wrapAe('\n  var a = 1;\n\n  var b = "x";\n  b.boom();\n  return a;');

  it("shows up to 3 lines with >>> on the failing one, dropping a blank neighbour and clipping at the ends", () => {
    expect(aeExcerpt(script, 4)).toEqual(['3: var b = "x";', ">>> 4: b.boom();", "5: return a;"]);
    expect(aeExcerpt(script, 3)).toEqual([">>> 3: var b = \"x\";", "4: b.boom();"]);
    expect(aeExcerpt(script, 1)).toEqual([">>> 1: var a = 1;"]);
    expect(aeExcerpt(script, 5)).toEqual(["4: b.boom();", ">>> 5: return a;"]);
    expect(aeExcerpt("(function () { x; })()", 1)).toEqual([]);
  });

  it("caps long literals and redacts secrets", () => {
    setRedactionSecrets(["configured-secret-value"]);
    const s = wrapAe(`\n  var a = "${"z".repeat(200)}";\n  var t = "configured-secret-value";\n  boom();`);
    const ex = aeExcerpt(s, 2);
    expect(ex[0]).toBe(`1: var a = "${"z".repeat(80)}…"(+120 chars);`);
    expect(ex[1]).toBe('>>> 2: var t = "[redacted]";');
  });
});

describe("enrichAeError", () => {
  const script = getLayerScript(12, 9);

  it("never changes message, appId or scriptLine, and adds where, next and the tool only inside a tool call", () => {
    const r = fail(script);
    const raw = scriptError(r);
    const out = enrichAeError(raw, script) as ScriptError;
    expect(out).not.toBe(raw);
    expect(out.message).toBe(raw.message);
    expect(out.appId).toBe(raw.appId);
    expect(out.scriptLine).toBe(raw.scriptLine);
    expect(out.details).toEqual({ code: "HOST_ERROR", where: "helper", helper: "__layer" });
    const inCall = runAsToolCall({ tool: "ae_get_layer", args: { compId: 12, layerIndex: 9 } }, () => enrichAeError(raw, script)) as ScriptError;
    expect(inCall.details.tool).toBe("ae_get_layer");
    expect(inCall.details.args).toBe("{compId: 12, layerIndex: 9}");
    expect(inCall.bodyLine).toBeNull();
  });

  it("adds a next step only when the host message has none", () => {
    const body = new ScriptError("after_effects", "boom", AE_PRELUDE_LINES + 4);
    const out = enrichAeError(body, LIST_COMPOSITIONS) as ScriptError;
    expect(out.details.where).toBe("body");
    expect(out.bodyLine).toBe(3);
    expect(out.details.next).toBe("check the values the line marked >>> uses (ae_get_comp and ae_get_layer show what exists), then retry");
    expect(out.details.excerpt).toHaveLength(3);
    const withNext = enrichAeError(new ScriptError("after_effects", `x ${DASH} y`, AE_PRELUDE_LINES + 4), LIST_COMPOSITIONS) as ScriptError;
    expect(withNext.details.next).toBeUndefined();
    const unknown = enrichAeError(new ScriptError("after_effects", "x"), LIST_COMPOSITIONS) as ScriptError;
    expect(unknown.details.where).toBe("unknown");
    expect(unknown.details.next).toMatch(/close and reopen the brainferno-mcp-bridge panel in After Effects$/);
  });

  it("a ' — ' inside a quoted name is not the message's own next step (R7)", () => {
    const at = AE_PRELUDE_LINES + 4;
    const next = (message: string) => (enrichAeError(new ScriptError("after_effects", message, at), LIST_COMPOSITIONS) as ScriptError).details.next;
    expect(next(`Unable to find "Intro ${DASH} Final"`)).toBe(NEXT_BODY);
    expect(next(`Unable to find "say \\"a ${DASH} b\\" twice"`)).toBe(NEXT_BODY);
    expect(next(`Unable to find "Intro ${DASH} Final" ${DASH} pass another name.`)).toBeUndefined();
    expect(next(`Intro ${DASH} Final`)).toBeUndefined(); // unquoted: read as the message's own clause
    // A quote that is never closed quotes nothing: the dash after it is the message's own (G1).
    expect(next(`Expression error: Error: x"a ${DASH} fix the expression; the property keeps its previous one.`)).toBeUndefined();
  });

  it("reads a long host message and a long argument, and writes the paragraph, in time linear in their length (G1, H1, I1, I3)", async () => {
    // As buildRuntime registers the server's secrets: with __q's cut, which turns on the cut-name scan.
    setRedactionSecrets([HEX64, TOKEN40], { cut: AE_NAME_CUT, mark: AE_CUT_MARK });
    try {
      /** A case: its input at n UTF-16 units, built outside the timing, then the timed call that gives the paragraph. */
      type Case = (n: number) => () => string | Promise<string>;
      // An expression that throws a long string: After Effects' own message carries it whole, the call
      // echoes it as an argument, and the code excerpt quotes the line that holds it.
      const expression =
        (make: (n: number) => string): Case =>
        (n) => {
          const thrown = make(n);
          const script = setExpressionScript(12, 1, "position", undefined, thrown);
          const at = AE_PRELUDE_LINES + 1 + bodyLineOf(script, "var e = ");
          const message = `Expression error: Error: ${thrown} ${DASH} fix the expression; the property keeps its previous one.`;
          const args = { compId: 12, layerIndex: 1, property: "position", expression: thrown };
          return () => scriptErrorText(runAsToolCall({ tool: "ae_set_expression", args }, () => enrichAeError(new ScriptError("after_effects", message, at), script)) as ScriptError);
        };
      // ae_apply_effect with a name no installed effect has: its miss path compares, folds and ranks the
      // name against the installed list (cached, as after a first miss).
      const effectMiss =
        (make: (n: number) => string): Case =>
        (n) => {
          const matchName = make(n);
          const script = applyEffectScript(12, 1, matchName);
          const at = AE_PRELUDE_LINES + 1 + bodyLineOf(script, "canAddProperty");
          const message = `${EFFECT_MISS}"${matchName.slice(0, AE_NAME_CUT)}${AE_CUT_MARK}" (layer 1 "BG" (solid)) ${DASH} use an installed effect's match name, e.g. 'ADBE Gaussian Blur 2', or its display name.`;
          const args = { compId: 12, layerIndex: 1, matchName };
          const { catalog } = fixedCatalog(EFFECTS);
          return () =>
            runAsToolCall({ tool: "ae_apply_effect", args }, async () =>
              scriptErrorText((await withEffectSuggestions(catalog, enrichAeError(new ScriptError("after_effects", message, at), script), matchName)) as ScriptError),
            );
        };
      // The message is cut; its own step follows the cut (I4).
      const ownStep = (text: string) => {
        expect(text).toContain(`chars) ${DASH} fix the expression; the property keeps its previous one. Code: `);
        expect(text).toContain(" | >>> 4: var e = ");
      };
      const cases: [string, Case, (text: string) => void][] = [
        ["escaped quotes after a quote never closed", expression((n) => `x"${'a\\"'.repeat(n / 3)}`), ownStep],
        ["a long run of spaces", expression((n) => `x${" ".repeat(n)}y`), ownStep],
        // A parameter miss whose query and listed name are long and one edit apart: ranking measures their edit distance.
        ["a parameter miss with long names", expression((n) => `: "${"a".repeat(n / 2)}"; parameters: ["${"a".repeat(n / 2 - 1)}b"]`), ownStep],
        // Each starts a property-path miss that is looked for up to the end of the text.
        ["property-path misses", expression((n) => 'segment "a" not found '.repeat(n / 22)), ownStep],
        // Each is a quoted name as long as one After Effects cut, its kept text the first character of a key.
        ["names that look cut", expression((n) => `"${"0".repeat(AE_NAME_CUT)}${AE_CUT_MARK}", `.repeat(n / 67)), ownStep],
        // Combining marks in descending class order: NFC (fold) reorders such a run in time quadratic in its length.
        [
          "an effect name of combining marks",
          effectMiss((n) => `a${"\u0301".repeat(n / 2)}${"\u0316".repeat(n / 2)}`),
          (text) => {
            expect(text).toContain(`: ${EFFECT_MISS}"a`);
            expect(text).not.toContain("Did you mean");
          },
        ],
      ];
      for (const [label, prepare, check] of cases) {
        // Each size is 10 times the last, so linear work takes about 10 times as long and quadratic work
        // about 100 times: a run may take at most 40 times the one before it, however fast or slow the
        // machine. The smallest size goes first, so a cost that grows faster than the length fails
        // within seconds instead of running on for minutes at 200 KB. The fastest of 5 runs counts (a
        // GC pause or a busy CI runner does not), and a run before is credited with at least 2 ms
        // (timer noise on a fast machine cannot fail a linear case).
        let before = 0;
        for (const size of [2_000, 20_000, 200_000]) {
          const run = prepare(size);
          let fastest = Number.POSITIVE_INFINITY;
          let text = "";
          for (let i = 0; i < 5; i++) {
            const started = performance.now();
            text = await run();
            fastest = Math.min(fastest, performance.now() - started);
          }
          if (before > 0) {
            expect(fastest, `${label}: ${size} units took ${fastest.toFixed(1)} ms, ${size / 10} took ${before.toFixed(1)} ms`).toBeLessThan(40 * Math.max(before, 2));
          }
          before = fastest;
          expect(text, label).toMatch(/ at body line \d+ /);
          expect(text, label).toMatch(/…\(\+\d+ chars\)/);
          expect(text, label).toContain("Code: ");
          check(text);
        }
      }
    } finally {
      setRedactionSecrets([]);
    }
  });

  it("puts the message's own step back after the cut when the paragraph cuts a message, wherever the cut falls (H3, I4)", () => {
    const fails = (script: string, setup: (host: AeHost) => void = (h) => fileStubs(h)): ScriptError => {
      const host = aeHost();
      setup(host);
      return enrichAeError(scriptError(failIn(host, script)), script) as ScriptError;
    };
    /** The paragraph's message part ends in the cut, then `step`, then the code. */
    const afterCut = (step: string): RegExp => new RegExp(`…\\(\\+\\d+ chars\\) ${DASH} ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Code: `);
    const OPEN = "pass the absolute path of an existing .aep file";
    // ae_open_project with a path longer than the paragraph shows (Windows takes long paths).
    const long = fails(openProjectScript(`C:\\${"a-long-folder-name\\".repeat(95)}project.aep`));
    expect(long.message.length).toBeGreaterThan(MESSAGE_LIMIT);
    expect(long.message.endsWith(`${DASH} ${OPEN}.`)).toBe(true);
    expect(long.details.next).toBe(OPEN);
    expect(scriptErrorText(long)).toMatch(afterCut(OPEN));
    // A path the paragraph shows whole keeps the message's own step and gets no other.
    const short = fails(openProjectScript("C:\\projects\\project.aep"));
    expect(short.details.next).toBeUndefined();
    expect(scriptErrorText(short)).toContain(`project.aep ${DASH} ${OPEN}. Code: `);

    // Every length from one the paragraph shows whole to one it cuts before the dash: the cut falls
    // after the step's period, on it, inside the step, right after the dash, on it and before it.
    // The message part shows the step once, whole: in the message while the cut leaves it so, after
    // the cut otherwise.
    const script = openProjectScript("C:\\p.aep");
    const at = AE_PRELUDE_LINES + 1 + bodyLineOf(script, "No file at");
    const frame = `No file at C:\\.aep ${DASH} ${OPEN}.`;
    const message = (length: number): string => `No file at C:\\${"p".repeat(length - frame.length)}.aep ${DASH} ${OPEN}.`;
    expect(fails(openProjectScript(`C:\\${"p".repeat(1450)}.aep`)).message).toBe(message(1450 + frame.length));
    for (let length = MESSAGE_LIMIT - 2; length <= MESSAGE_LIMIT + OPEN.length + 8; length++) {
      const e = enrichAeError(new ScriptError("after_effects", message(length), at), script) as ScriptError;
      const text = scriptErrorText(e);
      const shown = text.slice(0, text.indexOf(" Code: "));
      expect(shown.split(OPEN).length - 1, `${length}: ${shown.slice(-200)}`).toBe(1);
      if (length <= MESSAGE_LIMIT) {
        expect(e.details.next, String(length)).toBeUndefined();
        expect(text, String(length)).toContain(`.aep ${DASH} ${OPEN}. Code: `);
      } else if (length === MESSAGE_LIMIT + 1) {
        // Only the period is cut: the step still shows whole.
        expect(e.details.next, String(length)).toBeUndefined();
        expect(text, String(length)).toContain(`.aep ${DASH} ${OPEN}…(+1 chars) Code: `);
      } else {
        expect(e.details.next, String(length)).toBe(OPEN);
        expect(text, String(length)).toMatch(afterCut(OPEN));
      }
    }

    // ae_export_mogrt into a folder it cannot write: a long folder, and one holding " — " too. The
    // code excerpt is cut as well, so the step is shown only after the message.
    const notWritten = (h: AeHost) => {
      fileStubs(h);
      Object.assign(h.app, { beginSuppressDialogs: () => undefined, endSuppressDialogs: () => undefined });
      Object.assign(h.app.project, { file: {}, save: () => undefined });
      h.comp(12).exportAsMotionGraphicsTemplate = () => false;
    };
    const WRITE = "pass a folder you can write to, then retry";
    for (const folder of [`C:/${"f".repeat(1380)}`, `/Users/me/Clients/Acme ${DASH} Final/${"a-long-folder-name/".repeat(95)}`]) {
      const e = fails(exportMogrtScript(12, folder, "LT", true), notWritten);
      expect(e.message.length).toBeGreaterThan(MESSAGE_LIMIT);
      expect(e.message.endsWith(`${DASH} ${WRITE}.`)).toBe(true);
      expect(e.details.next).toBe(WRITE);
      expect(scriptErrorText(e)).toMatch(afterCut(WRITE));
    }

    // An expression that throws a long string, with a " — " of its own: the message's step is the last clause.
    const body = AE_PRELUDE_LINES + 4;
    const FIX = "fix the expression; the property keeps its previous one";
    for (const thrown of ["x".repeat(MESSAGE_LIMIT), `Value ${DASH} too big: ${"x".repeat(2000)}`]) {
      const e = enrichAeError(new ScriptError("after_effects", `Expression error: Error: ${thrown} ${DASH} ${FIX}.`, body), LIST_COMPOSITIONS) as ScriptError;
      expect(e.details.next).toBe(FIX);
      expect(scriptErrorText(e)).toMatch(afterCut(FIX));
    }

    // A long message with no step of its own gets the generic one: none at all, a " — " only inside a
    // quoted name, or a last clause far longer than any step a tool writes (other text, not a step).
    const generic = (message: string) => (enrichAeError(new ScriptError("after_effects", message, body), LIST_COMPOSITIONS) as ScriptError).details.next;
    expect(generic(`After Effects error: ${"x".repeat(2000)}`)).toBe(NEXT_BODY);
    expect(generic(`Unable to find "Intro ${DASH} Final" in ${"x".repeat(2000)}`)).toBe(NEXT_BODY);
    expect(generic(`Unable to evaluate ${DASH} ${"x".repeat(2000)}`)).toBe(NEXT_BODY);

    // The cut is counted in code points, after redaction: a step that the paragraph still shows counts.
    const fits = `Expression error: Error: ${"\u{1F600}".repeat(MESSAGE_LIMIT - 120)} ${DASH} fix the expression.`;
    expect(fits.length).toBeGreaterThan(MESSAGE_LIMIT);
    expect((enrichAeError(new ScriptError("after_effects", fits, body), LIST_COMPOSITIONS) as ScriptError).details.next).toBeUndefined();
  });

  it("a host failure inside a helper gets a next step that fits the helper, never one that blames the arguments (R20)", () => {
    const keyframed = (host: AeHost) => {
      host.comp(12).layer(1).property("ADBE Transform Group").property("ADBE Anchor Point").setValue = () => {
        throw new host.VmError("After Effects error: Can't use setValue on a property that has keyframes");
      };
    };
    const ANCHOR_NEXT =
      "most likely the Anchor Point has keyframes, which After Effects will not overwrite: remove them with ae_remove_keyframes (property anchorPoint), then retry. " +
      "What the call changed before this stays; one Ctrl-Z in After Effects undoes it";
    const helpers: string[] = [];
    for (const script of [setTextScript({ compId: 12, layerIndex: 1, text: "New title" }), setTextScript({ compId: 12, layerIndex: 1, anchor: "origin" })]) {
      const host = aeHost();
      keyframed(host);
      const e = enrichAeError(scriptError(failIn(host, script)), script) as ScriptError;
      expect(e.details.where).toBe("helper");
      helpers.push(e.details.helper!);
      expect(e.details.next).toBe(ANCHOR_NEXT);
      expect(scriptErrorText(e)).not.toContain("you passed");
    }
    expect(helpers).toEqual(["__centerAnchor", "__originAnchor"]);
    // Any other helper: a next step that does not blame the ids or the path.
    const host = aeHost();
    Object.defineProperty(host.comp(12), "width", {
      configurable: true,
      get: () => {
        throw new host.VmError("After Effects error: Object is invalid");
      },
    });
    const e = enrichAeError(scriptError(failIn(host, getCompScript(12))), getCompScript(12)) as ScriptError;
    expect(e.details).toMatchObject({ where: "helper", helper: "__compInfo" });
    expect(e.details.next).toBe(
      "After Effects itself refused an operation inside a shared helper (a bad id or path gets its own message); check the current state with ae_get_comp or ae_get_layer, then retry",
    );
  });

  it("returns other apps' errors, plain errors and already-enriched errors as they are", () => {
    const ps = new ScriptError("photoshop", "x", 3);
    expect(enrichAeError(ps, LIST_COMPOSITIONS)).toBe(ps);
    const plain = new Error("x");
    expect(enrichAeError(plain, LIST_COMPOSITIONS)).toBe(plain);
    const done = new ScriptError("after_effects", "x", 3, { where: "outside" });
    expect(enrichAeError(done, LIST_COMPOSITIONS)).toBe(done);
  });

  it("redacts the excerpt and the args echo end to end (M12)", async () => {
    const p = { compId: 12, layerIndex: 1, text: `code:\n${TOKEN40}`, fontSize: 5000 };
    const script = setTextScript(p);
    const host = aeHost();
    const bridge = fakeBridge(async (s) => {
      const reply = host.eval(s);
      if (!reply.ok) throw scriptError(reply.error);
      return reply.value as JsonValue;
    });
    const error = await runAsToolCall({ tool: "ae_set_text", args: p }, () => evaluateAe(bridge, script).catch((e: unknown) => e));
    const e = error as ScriptError;
    expect(e.details.where).toBe("body");
    expect(e.bodyLine).toBe(bodyLineOf(script, "td.fontSize = v"));
    expect(e.details.excerpt!.join("\n")).toContain('v = "code:\\n[redacted]"');
    expect(e.details.args).toContain('text: "code:\\n[redacted]"');
    const text = scriptErrorText(e);
    expect(text).not.toContain(TOKEN40);
    expect(text).toContain("(ae_set_text, args {compId: 12, layerIndex: 1, ");
  });
});

// ---- effect "did you mean" ----------------------------------------------------------

const EFFECTS: InstalledEffect[] = AE_EFFECT_ITEMS;
const missFor = (name: string) =>
  new ScriptError("after_effects", `${EFFECT_MISS}${name} (layer 1 "BG" (solid)) ${DASH} use an installed effect's match name, e.g. 'ADBE Gaussian Blur 2', or its display name.`, 5, {
    where: "body",
    bodyLine: 5,
  });

function fixedCatalog(effects: readonly InstalledEffect[] | Error): { catalog: EffectCatalog; calls: () => number } {
  let n = 0;
  const catalog = {
    candidates: async () => {
      n++;
      if (effects instanceof Error) throw effects;
      return effects;
    },
  } as unknown as EffectCatalog;
  return { catalog, calls: () => n };
}

function fakeBridge(evaluate: (script: string) => Promise<JsonValue>, epoch?: () => number): AppBridge {
  return {
    appId: "after_effects",
    isConnected: () => true,
    execute: async () => null,
    evaluate: (script) => evaluate(script),
    close: async () => {},
    ...(epoch !== undefined ? { connectionEpoch: epoch } : {}),
  };
}

describe("withEffectSuggestions (M20)", () => {
  /** The rules After Effects 26.5 showed live (probe 13): what withEffectSuggestions uses when given none. */
  const LIVE = { caseSensitive: true, displayNamesAccepted: true };
  /** Display names refused: the rule assumed before the live probes, kept so the other branch stays covered. */
  const STRICT = { caseSensitive: true, displayNamesAccepted: false };
  const LENIENT = { caseSensitive: false, displayNamesAccepted: true };
  const REFUSED = "That effect is installed, but After Effects would not add it to this layer.";
  const CASE_NOTE = "Names must match exactly, case included.";

  it("ships the rules the live probes found: case-sensitive, display names accepted (After Effects 26.5, probe 13)", async () => {
    // 13a: "adbe gaussian blur 2" was refused; 13b: "Gaussian Blur" was applied.
    expect({ caseSensitive: EFFECT_NAMES_CASE_SENSITIVE, displayNamesAccepted: EFFECT_DISPLAY_NAMES_ACCEPTED }).toEqual(LIVE);
    const paragraph = async (requested: string): Promise<string> => {
      const script = applyEffectScript(12, 1, requested);
      const host = aeHost({ comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: "BG" }] }] });
      // This layer takes no effect, the way After Effects refuses one a layer cannot take.
      host.comp(12).layer(1).property("ADBE Effect Parade").canAddProperty = () => false;
      const miss = enrichAeError(scriptError(failIn(host, script)), script);
      return scriptErrorText((await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, miss, requested)) as ScriptError);
    };
    // An installed display name After Effects refused: the layer would not take it (it takes display names).
    const display = await paragraph("Gaussian Blur");
    expect(display).toContain(`or its display name. ${REFUSED}`);
    expect(display).not.toContain("Did you mean");
    // A display name with a case slip: that exactly cased name, and why.
    expect(await paragraph("gaussian blur")).toContain(`Did you mean "Gaussian Blur"? ${CASE_NOTE}`);
    // A match name with a case slip: that exactly cased match name, and why.
    expect(await paragraph("adbe gaussian blur 2")).toContain(`Did you mean "ADBE Gaussian Blur 2" (Gaussian Blur)? ${CASE_NOTE}`);
  });

  it("an installed match name gets the layer-refusal note, under any rule", async () => {
    for (const rules of [LIVE, STRICT, LENIENT]) {
      const out = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("ADBE Gaussian Blur 2"), "ADBE Gaussian Blur 2", rules)) as ScriptError;
      expect(out.details.note).toBe('"ADBE Gaussian Blur 2" (Gaussian Blur) is installed, but After Effects would not add it to this layer.');
      expect(out.details.suggestions).toBeUndefined();
    }
  });

  it("a display name: the refusal note, since display names are accepted; the match name to pass under the old assumption", async () => {
    for (const rules of [undefined, LIVE, LENIENT]) {
      const accepted = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("Gaussian Blur"), "Gaussian Blur", rules)) as ScriptError;
      expect(accepted.details).toMatchObject({ note: REFUSED });
      expect(accepted.details.suggestions).toBeUndefined();
    }
    const strict = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("Gaussian Blur"), "Gaussian Blur", STRICT)) as ScriptError;
    expect(strict.details.suggestions).toEqual([{ name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" }]);
    expect(strict.details.note).toBe(`That effect is installed; pass its match name ${DASH} if that also fails, this layer cannot take it.`);
  });

  it("a case-folded hit: the exact name and a case note, or the refusal note when case does not matter", async () => {
    for (const rules of [undefined, LIVE, STRICT]) {
      const out = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("adbe gaussian blur 2"), "adbe gaussian blur 2", rules)) as ScriptError;
      expect(out.details.suggestions).toEqual([{ name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" }]);
      expect(out.details.note).toBe(CASE_NOTE);
    }
    const lenient = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("adbe gaussian blur 2"), "adbe gaussian blur 2", { ...STRICT, caseSensitive: false })) as ScriptError;
    expect(lenient.details.note).toBe(REFUSED);
  });

  it("a case-folded display name: the display-name rule decides first, then case, under all four rules (R1)", async () => {
    const PASS_MATCH = `That effect is installed; pass its match name ${DASH} if that also fails, this layer cannot take it.`;
    const cases: [{ caseSensitive: boolean; displayNamesAccepted: boolean }, { suggestions?: unknown; note: string }][] = [
      [{ caseSensitive: true, displayNamesAccepted: false }, { suggestions: [{ name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" }], note: PASS_MATCH }],
      [{ caseSensitive: false, displayNamesAccepted: false }, { suggestions: [{ name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" }], note: PASS_MATCH }],
      [{ caseSensitive: true, displayNamesAccepted: true }, { suggestions: [{ name: "Gaussian Blur" }], note: "Names must match exactly, case included." }],
      [{ caseSensitive: false, displayNamesAccepted: true }, { note: REFUSED }],
    ];
    for (const [rules, want] of cases) {
      const out = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("gaussian blur"), "gaussian blur", rules)) as ScriptError;
      expect({ suggestions: out.details.suggestions, note: out.details.note }, JSON.stringify(rules)).toEqual({ suggestions: want.suggestions, note: want.note });
    }
    // The shipped rules (LIVE, the third row) are what a call without rules gets.
    const shipped = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("gaussian blur"), "gaussian blur")) as ScriptError;
    expect({ suggestions: shipped.details.suggestions, note: shipped.details.note }).toEqual({ suggestions: [{ name: "Gaussian Blur" }], note: CASE_NOTE });
  });

  it("a typo gets up to 3 ranked names (acceptance 4)", async () => {
    for (const rules of [LIVE, STRICT, LENIENT]) {
      const out = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("ADBE Gausian Blur 2"), "ADBE Gausian Blur 2", rules)) as ScriptError;
      expect(out.details.suggestions).toEqual([
        { name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" },
        { name: "ADBE Gaussian Blur", label: "Gaussian Blur (Legacy)" },
      ]);
      expect(out.details.note).toBeUndefined();
    }
  });

  it("returns the error unchanged when nothing is close, the catalog fails, or the error is not a miss", async () => {
    const none = missFor("Optical Flares");
    expect(await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, none, "Optical Flares")).toBe(none);
    const typo = missFor("ADBE Gausian Blur 2");
    expect(await withEffectSuggestions(fixedCatalog(new Error("read failed")).catalog, typo, "ADBE Gausian Blur 2")).toBe(typo);
    const other = new ScriptError("after_effects", "Layer index 9 is out of range", 5);
    const c = fixedCatalog(EFFECTS);
    expect(await withEffectSuggestions(c.catalog, other, "x")).toBe(other);
    expect(c.calls()).toBe(0);
    const plain = new Error("x");
    expect(await withEffectSuggestions(c.catalog, plain, "x")).toBe(plain);
  });

  it("folds and ranks no name longer than EFFECT_NAME_MAX, and still checks it exactly first (I1)", async () => {
    // NFC reorders a run of combining marks in time quadratic in its length: the name must never reach fold().
    const lengths: number[] = [];
    const normalize = String.prototype.normalize;
    const spy = vi.spyOn(String.prototype, "normalize").mockImplementation(function (this: string, form?: string) {
      lengths.push(this.length);
      return normalize.call(this, form);
    });
    try {
      // One past the limit; NFC would put the marks in order, and the name would then fold to an installed one.
      const installed: InstalledEffect = { matchName: "VEND Long", displayName: `a${"\u0316\u0301".repeat(EFFECT_NAME_MAX / 2)}` };
      const requested = `a${"\u0301\u0316".repeat(EFFECT_NAME_MAX / 2)}`;
      expect(requested.length).toBe(EFFECT_NAME_MAX + 1);
      const miss = missFor(`"${requested.slice(0, AE_NAME_CUT)}${AE_CUT_MARK}"`);
      for (const rules of [LIVE, STRICT, LENIENT]) {
        expect(await withEffectSuggestions(fixedCatalog([...EFFECTS, installed]).catalog, miss, requested, rules)).toBe(miss);
      }
      // Compared exactly, an installed name that long is still found: that folds nothing. It is a
      // display name, which After Effects takes, so the layer refused it.
      const out = (await withEffectSuggestions(fixedCatalog([...EFFECTS, installed]).catalog, miss, installed.displayName)) as ScriptError;
      expect(out).not.toBe(miss);
      expect(out.details.note).toBe(REFUSED);
      const strict = (await withEffectSuggestions(fixedCatalog([...EFFECTS, installed]).catalog, miss, installed.displayName, STRICT)) as ScriptError;
      expect(strict.details.suggestions).toEqual([{ name: "VEND Long", label: installed.displayName }]);
    } finally {
      spy.mockRestore();
    }
    expect(Math.max(0, ...lengths)).toBeLessThanOrEqual(EFFECT_NAME_MAX);
    // One unit shorter, the same name is folded: the case-folded display-name rule finds the effect,
    // and gives that display name as After Effects spells it.
    const near = `a${"\u0301\u0316".repeat(EFFECT_NAME_MAX / 2 - 1)}\u0301`;
    const installedNear: InstalledEffect = { matchName: "VEND Near", displayName: `a${"\u0316\u0301".repeat(EFFECT_NAME_MAX / 2 - 1)}\u0301` };
    expect(near.length).toBe(EFFECT_NAME_MAX);
    const found = (await withEffectSuggestions(fixedCatalog([...EFFECTS, installedNear]).catalog, missFor("x"), near)) as ScriptError;
    expect(found.details.suggestions).toEqual([{ name: installedNear.displayName }]);
    expect(found.details.note).toBe(CASE_NOTE);
  });
});

describe("EffectCatalog (M18, M19, M22)", () => {
  const LIST: JsonValue = [["ADBE Gaussian Blur 2", "Gaussian Blur"], ["ADBE Glo2", "Glow"]];

  function harness(answers: ((script: string) => Promise<JsonValue>)[], options: { epoch?: boolean } = {}) {
    let epoch = 1;
    let now = 0;
    const sent: string[] = [];
    let i = 0;
    const bridge = fakeBridge(
      async (script) => {
        sent.push(script);
        const answer = answers[Math.min(i++, answers.length - 1)]!;
        return answer(script);
      },
      options.epoch === false ? undefined : () => epoch,
    );
    const catalog = new EffectCatalog(bridge, () => now);
    return {
      catalog,
      sent,
      bump: () => epoch++,
      advance: (ms: number) => (now += ms),
    };
  }

  it("reads once and serves later misses from the cache; concurrent misses share the read", async () => {
    const h = harness([async () => LIST]);
    const [a, b] = await Promise.all([h.catalog.candidates("x"), h.catalog.candidates("y")]);
    expect(a).toEqual([{ matchName: "ADBE Gaussian Blur 2", displayName: "Gaussian Blur" }, { matchName: "ADBE Glo2", displayName: "Glow" }]);
    expect(b).toBe(a);
    await h.catalog.candidates("z");
    expect(h.sent).toEqual([LIST_INSTALLED_EFFECTS]);
  });

  it("retries after a failed or empty read (an empty list is never a cached success)", async () => {
    const h = harness([
      async () => Promise.reject(new ScriptError("after_effects", "busy", 3)),
      async () => Promise.reject(new AppDisconnectedError("after_effects", "socket closed")),
      async () => [],
      async () => LIST,
    ]);
    await expect(h.catalog.candidates("x")).rejects.toBeInstanceOf(ScriptError);
    await expect(h.catalog.candidates("x")).rejects.toBeInstanceOf(AppDisconnectedError);
    await expect(h.catalog.candidates("x")).rejects.toThrow(/empty/);
    expect(await h.catalog.candidates("x")).toHaveLength(2);
    expect(h.sent).toHaveLength(4);
  });

  it("drops malformed entries", async () => {
    const h = harness([async () => [["ADBE Glo2", "Glow"], ["only one"], [1, 2], "x", null, ["ADBE Tint", "Tint", "extra"]] as JsonValue]);
    expect(await h.catalog.candidates("x")).toEqual([{ matchName: "ADBE Glo2", displayName: "Glow" }]);
  });

  it("re-reads after the panel reconnects (M19)", async () => {
    const h = harness([async () => LIST]);
    await h.catalog.candidates("x");
    h.bump();
    await h.catalog.candidates("x");
    expect(h.sent).toEqual([LIST_INSTALLED_EFFECTS, LIST_INSTALLED_EFFECTS]);
  });

  it("stops reading for the rest of a connection after a timeout, then reads filtered (M18)", async () => {
    const h = harness([async () => Promise.reject(new EvalTimeoutError("after_effects", 10_000)), async () => LIST]);
    await expect(h.catalog.candidates("Gausian Blur")).rejects.toBeInstanceOf(EvalTimeoutError);
    await expect(h.catalog.candidates("Gausian Blur")).rejects.toThrow(/timed out/);
    await expect(h.catalog.candidates("Gausian Blur")).rejects.toThrow(/timed out/);
    expect(h.sent).toHaveLength(1);
    h.bump();
    await h.catalog.candidates("Gausian Blur");
    expect(h.sent[1]).toBe(filteredEffectsScript("gausian blur", 3));
  });

  it("keeps a slow full read for this connection and reads filtered after a reconnect (O7)", async () => {
    const h = harness([
      async () => {
        h.advance(SLOW_EFFECTS_READ_MS + 1);
        return LIST;
      },
      async () => [["ADBE Gaussian Blur 2", "Gaussian Blur"]],
    ]);
    expect(await h.catalog.candidates("ADBE Gausian Blur 2")).toHaveLength(2);
    expect(await h.catalog.candidates("ADBE Gausian Blur 2")).toHaveLength(2);
    expect(h.sent).toEqual([LIST_INSTALLED_EFFECTS]);
    h.bump();
    expect(await h.catalog.candidates("ADBE Gausian Blur 2")).toHaveLength(1);
    expect(h.sent[1]).toBe(filteredEffectsScript("gausian blur 2", 4));
  });

  it("a fast read after a reconnect is a second full read", async () => {
    const h = harness([async () => LIST]);
    h.advance(1);
    await h.catalog.candidates("x");
    h.bump();
    await h.catalog.candidates("x");
    expect(h.sent).toEqual([LIST_INSTALLED_EFFECTS, LIST_INSTALLED_EFFECTS]);
  });

  it("treats a bridge without connectionEpoch as one connection", async () => {
    const h = harness([async () => LIST], { epoch: false });
    await h.catalog.candidates("x");
    await h.catalog.candidates("x");
    expect(h.sent).toHaveLength(1);
  });

  it("the filtered read folds and sends no name longer than EFFECT_NAME_MAX: no installed name is near one (I1)", async () => {
    const h = harness([async () => Promise.reject(new EvalTimeoutError("after_effects", 10_000)), async () => LIST]);
    await expect(h.catalog.candidates("x")).rejects.toBeInstanceOf(EvalTimeoutError);
    h.bump();
    expect(await h.catalog.candidates(`a${"\u0301\u0316".repeat(EFFECT_NAME_MAX / 2)}`)).toEqual([]);
    expect(h.sent).toHaveLength(1);
    // At the limit, the filtered read runs.
    const atLimit = "x".repeat(EFFECT_NAME_MAX);
    expect(await h.catalog.candidates(atLimit)).toHaveLength(2);
    expect(h.sent[1]).toBe(filteredEffectsScript(atLimit, suggestionThreshold(atLimit)));
  });
});

// ---- the other evaluate sites: ae_render_frame and job steps (R3, R5) ---------------

describe("ae_render_frame and ae_render_comp's job step keep the tool context (R3)", () => {
  const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
  /** The body's first statement (line 1) failing the way a closed project fails a save. */
  const noProject = async (): Promise<JsonValue> => {
    throw new ScriptError("after_effects", "No project is open", AE_PRELUDE_LINES + 2, { code: "HOST_ERROR" });
  };

  /** registerAfterEffectsTools with a job registry and the job tools, over an in-memory MCP session. */
  async function session(evaluate: (script: string) => Promise<JsonValue>) {
    const workRoot = mkdtempSync(join(tmpdir(), "bf-ae16-jobs-"));
    const jobs = new JobRegistry({ workRoot });
    const server = new McpServer({ name: "ae16-jobs", version: "0" });
    registerAfterEffectsTools(server, fakeBridge(evaluate), { jobs, defaultWait: true, rawScriptApps: [], remote: false, allowRemoteRawScripts: false });
    registerJobTools(server, jobs);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ae16-jobs", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    return {
      call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
      tools: async () => (await client.listTools()).tools,
      close: async () => {
        await client.close();
        await server.close();
        rmSync(workRoot, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  }

  it("ae_render_comp names the tool, its arguments and the body line, waited on or polled with cc_job_wait", async () => {
    const s = await session(noProject);
    const head = /^Script failed in After Effects \(ae_render_comp, args \{compName: "Main", outputPath: "C:\/r\/main\.mov", wait: (true|false)\}\) at body line 1 \(script line \d+\): No project is open/;

    const waited = await s.call("ae_render_comp", { compName: "Main", outputPath: "C:/r/main.mov", wait: true });
    expect(waited.isError).toBe(true);
    const view = JSON.parse(textOf(waited)) as { error: { step: string; message: string } };
    expect(view.error.step).toBe("Render with aerender");
    expect(view.error.message).toMatch(head);
    expect(view.error.message).toContain("Code: >>> 1: ");

    // wait:false returns at once; the step runs later, still inside the call's context.
    const queued = JSON.parse(textOf(await s.call("ae_render_comp", { compName: "Main", outputPath: "C:/r/main.mov", wait: false }))) as { jobId: string };
    const polled = await s.call("cc_job_wait", { jobId: queued.jobId, timeoutSeconds: 10 });
    expect(polled.isError).toBe(true);
    const later = (JSON.parse(textOf(polled)) as { error: { message: string } }).error.message;
    expect(later).toMatch(head);
    expect(later).toContain("wait: false");
    await s.close();
  });

  it("ae_set_effect_param describes the value shapes it takes (K6)", async () => {
    const s = await session(noProject);
    const tool = (await s.tools()).find((t) => t.name === "ae_set_effect_param");
    const value = (tool!.inputSchema["properties"] as Record<string, { description?: string }>)["value"];
    expect(value?.description).toMatch(/number/i);
    expect(value?.description).toMatch(/\[r, g, b\]/);
    expect(value?.description).toMatch(/string/i);
    await s.close();
  });

  it("ae_apply_effect takes an effect name up to EFFECT_NAME_MAX units and refuses a longer one before After Effects sees it (I1)", async () => {
    // Far above any name After Effects has: the fixture's longest match or display name is a few dozen characters.
    expect(Math.max(...AE_EFFECT_ITEMS.flatMap((e) => [e.matchName.length, e.displayName.length])) * 10).toBeLessThan(EFFECT_NAME_MAX);
    const sent: string[] = [];
    const s = await session(async (script) => {
      sent.push(script);
      return { index: 1, name: "x", matchName: "x", params: [] };
    });
    const tool = (await s.tools()).find((t) => t.name === "ae_apply_effect");
    const matchName = (tool!.inputSchema["properties"] as Record<string, { maxLength?: number; description?: string }>)["matchName"];
    expect(matchName?.maxLength).toBe(EFFECT_NAME_MAX);
    expect(matchName?.description).toContain(`at most ${EFFECT_NAME_MAX} characters`);
    const call = (name: string) => s.call("ae_apply_effect", { compId: 12, layerIndex: 1, matchName: name }).then((r) => r.isError === true, () => true);
    expect(await call("x".repeat(EFFECT_NAME_MAX))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(await call("x".repeat(EFFECT_NAME_MAX + 1))).toBe(true);
    expect(sent).toHaveLength(1);
    await s.close();
  });

  it("ae_render_frame names the tool and its arguments", async () => {
    const s = await session(noProject);
    const r = await s.call("ae_render_frame", { compId: 12 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Script failed in After Effects \(ae_render_frame, args \{compId: 12\}\) at body line 1 \(script line \d+\): No project is open/);
    await s.close();
  });

  it("a panel that drops during a job step says the step may have partly run (R5)", async () => {
    const s = await session(async () => {
      throw new AppDisconnectedError("after_effects", "socket closed");
    });
    const r = await s.call("ae_render_comp", { compName: "Main", outputPath: "C:/r/main.mov", wait: true });
    expect((JSON.parse(textOf(r)) as { error: { message: string } }).error.message).toBe(
      `The "after_effects" panel disconnected before the command completed (socket closed) ${DASH} it may have partly run; check After Effects, ` +
        "reconnect the brainferno-mcp-bridge panel (cc_connected_apps shows when it is back), then retry.",
    );
    await s.close();
  });
});

// ---- the source rule: every evaluate goes through evaluateAe, every tool through withToolContext (R4)

describe("After Effects call sites (R4)", () => {
  const read = (file: string) => readFileSync(new URL(`../src/tools/${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const AE_SRC = read("after-effects.ts");

  /** The 0-based line range [first, last] of a top-level declaration, closed by a line that is exactly "}". */
  function span(lines: string[], start: RegExp): [number, number] {
    const first = lines.findIndex((l) => start.test(l));
    const last = lines.findIndex((l, i) => i > first && l === "}");
    if (first < 0 || last < 0) throw new Error(`after-effects.ts has no ${start}`);
    return [first, last];
  }

  it("calls the bridge only inside evaluateAe and the effect catalog", () => {
    const lines = AE_SRC.split("\n");
    const allowed = [span(lines, /^export async function evaluateAe\(/), span(lines, /^export class EffectCatalog /)];
    const sites = lines.flatMap((l, i) => (/\.(evaluate|execute)\(/.test(l) ? [i] : []));
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const i of sites) expect(allowed.some(([a, b]) => i > a && i < b), `after-effects.ts:${i + 1}: ${lines[i]!.trim()}`).toBe(true);
    // The pipelines' After Effects steps go through evaluateAe (or renderCompHeadless) too.
    const pipelines = read("pipelines.ts");
    expect(pipelines).not.toMatch(/afterEffects\.(evaluate|execute)\(/);
    expect(pipelines).toMatch(/evaluateAe\(deps\.afterEffects,/);
  });

  it("registers every After Effects tool on the withToolContext server", () => {
    const lines = AE_SRC.split("\n");
    const [first, last] = span(lines, /^export function registerAfterEffectsTools\(/);
    const body = lines.slice(first, last + 1).join("\n");
    // `mcp` is the parameter and is used once: to build the wrapper every registration goes through. It never
    // registers a tool itself, and nothing reaches its low-level Server (AE-01 consent is the chat's, not the client's).
    expect(body.match(/(?<![\w-])mcp(?![\w-])/g)).toHaveLength(2);
    expect(body).toContain("const server = withToolContext(mcp, ");
    expect(body).not.toMatch(/\bmcp\.(registerTool|tool|server)\b/);
    const registrations = lines.flatMap((l, i) => (/registerTool\(/.test(l) ? [i] : []));
    expect(registrations.length).toBeGreaterThan(30);
    for (const i of registrations) {
      expect(lines[i]!.trim(), `after-effects.ts:${i + 1}`).toBe("server.registerTool(");
      expect(i > first && i < last, `after-effects.ts:${i + 1} is outside registerAfterEffectsTools`).toBe(true);
    }
  });
});

// ---- AE-03: name addressing, the batch's line map, the undo history -----------------------------

describe("AE-03 name lookups (__compNamed, __layerNamed; AT2)", () => {
  /** Comp 12 "Main": two layers named "dup" at 2 (text) and 5 (shape). */
  const DUPS: ProjectSpec = {
    comps: [
      {
        id: 12,
        name: "Main",
        layers: [
          { kind: "null", name: "Ctrl" },
          { kind: "text", name: "dup", text: "x" },
          { kind: "solid", name: "BG" },
          { kind: "solid", name: "Plate" },
          { kind: "shape", name: "dup" },
        ],
      },
    ],
  };

  it("a repeated layer name fails with the matching layers (FR:26 verbatim) before anything changes", () => {
    const script = setLayerPropsScript(12, "dup", { opacity: 50 });
    const r = fail(script, DUPS);
    expect(r.message).toBe(`The name "dup" matches 2 layers in "Main" (id 12): 2 "dup" (text), 5 "dup" (shape) ${DASH} pass layerIndex to pick one.`);
    expect(locateAeError(script, r.line ?? undefined)).toEqual({ kind: "helper", helper: "__layerNamed" });
    expect(r.host.mutations).toEqual([]);
    expect(r.host.undo.begin).toBe(0);
  });

  it("a repeated parent name names the parent role", () => {
    const r = fail(setLayerPropsScript(12, "BG", { parentIndex: "dup" }), DUPS);
    expect(r.message).toBe(`The name "dup" matches 2 layers in "Main" (id 12): 2 "dup" (text), 5 "dup" (shape) ${DASH} pass parentIndex to pick one.`);
    expect(r.host.undo.begin).toBe(0);
  });

  it("a repeated composition name lists each match with its id, before anything changes", () => {
    const spec: ProjectSpec = { comps: [{ id: 12, name: "dup" }, { id: 14, name: "Other" }, { id: 15, name: "dup" }] };
    const script = setCompPropsScript("dup", { duration: 5 });
    const r = fail(script, spec);
    expect(r.message).toBe(`The name "dup" matches 2 compositions: 12 "dup", 15 "dup" ${DASH} pass compId to pick one.`);
    expect(locateAeError(script, r.line ?? undefined)).toEqual({ kind: "helper", helper: "__compNamed" });
    expect(r.host.undo.begin).toBe(0);
  });

  it("a layer name that is not there lists the layers (FR:26 verbatim), and says so for an empty comp", () => {
    const script = setLayerPropsScript(12, "Titel", { opacity: 50 });
    const r = fail(script);
    expect(r.message).toBe(
      `No layer named "Titel" in "Main" (id 12): 1 "Title" (text), 2 "Logo" (shape), 3 "BG" (solid) ${DASH} names match exactly, case included; pass one of these names or its layerIndex.`,
    );
    expect(locateAeError(script, r.line ?? undefined)).toEqual({ kind: "helper", helper: "__layerNamed" });
    expect(r.host.undo.begin).toBe(0);
    // Case counts.
    expect(fail(getLayerScript(12, "title")).message).toMatch(/^No layer named "title" in "Main"/);
    expect(fail(getLayerScript(12, "A"), { comps: [{ id: 12, name: "Main", layers: [] }] }).message).toBe(
      `No layer named "A": "Main" (id 12) has no layers ${DASH} add one first (ae_add_layer).`,
    );
    expect(fail(setLayerPropsScript(12, 1, { parentIndex: "Nope" })).message).toBe(
      `No parent layer named "Nope" in "Main" (id 12): 1 "Title" (text), 2 "Logo" (shape), 3 "BG" (solid) ${DASH} names match exactly, case included; pass one of these names or its parentIndex.`,
    );
    expect(fail(setLayerPropsScript(12, 1, { parentIndex: "Nope" }), { comps: [{ id: 12, name: "Main", layers: [{ kind: "null", name: "X" }] }] }).message).toMatch(
      /^No parent layer named "Nope" in "Main" \(id 12\): 1 "X" \(null\) — /,
    );
  });

  it("a composition name that is not there lists the compositions, or says how to make one", () => {
    const script = getCompScript("Mian");
    const r = fail(script, { comps: [MAIN, { id: 15, name: "LT" }] });
    expect(r.message).toBe(`No composition named "Mian"; the project has 2: 12 "Main", 15 "LT" ${DASH} names match exactly, case included; pass one of these names or its compId.`);
    expect(locateAeError(script, r.line ?? undefined)).toEqual({ kind: "helper", helper: "__compNamed" });
    expect(fail(getCompScript("Main"), { comps: [] }).message).toBe(
      `No composition named "Main"; the project has no compositions ${DASH} create one with ae_create_comp and pass its name or id.`,
    );
    // A folder or footage item of that name is not a composition.
    expect(fail(getCompScript("Assets"), { comps: [MAIN], folders: [{ id: 5, name: "Assets" }] }).message).toMatch(/^No composition named "Assets"; the project has 1: 12 "Main" — /);
  });

  it("a name resolves to the one matching layer or composition, whatever the order (AT1 at the host)", () => {
    for (const order of [["A", "B", "C"], ["C", "B", "A"], ["B", "C", "A"]]) {
      const host = aeHost({ comps: [{ id: 12, name: "Main", layers: order.map((name) => ({ kind: "solid" as const, name })) }] });
      expect(host.eval(setLayerPropsScript("Main", "B", { opacity: 50 })).ok).toBe(true);
      expect(host.changes).toEqual(["B: Opacity.setValue"]);
      expect(host.layers(12).map((l) => [l.name, l.opacity])).toEqual(order.map((n) => [n, n === "B" ? 50 : 100]));
    }
  });

  it("a name never matches a layer whose name cannot be read", () => {
    const host = aeHost({ comps: [{ id: 12, name: "Main", layers: [{ kind: "solid", name: "B" }, { kind: "solid", name: "B" }] }] });
    Object.defineProperty(host.comp(12).layer(1), "name", { get: () => { throw new host.VmError("unreadable"); } });
    expect(host.eval(setLayerPropsScript(12, "B", { opacity: 50 })).ok).toBe(true);
    expect(host.comp(12).layer(2).property("ADBE Transform Group").property("ADBE Opacity").value).toBe(50);
  });

  it("a layer that would be its own parent by name is refused before the undo group (spec 11.2)", () => {
    const r = fail(setLayerPropsScript(12, "BG", { parentIndex: "BG" }));
    expect(r.message).toBe(`Layer 3 "BG" (solid) cannot be its own parent ${DASH} pass a different parentIndex or parentName, or parentIndex null to unparent.`);
    expect(r.host.undo.begin).toBe(0);
    expect(fail(setLayerPropsScript(12, 3, { parentIndex: "BG" })).message).toMatch(/cannot be its own parent/);
  });

  it("ae_add_marker: a layer miss changes nothing; a layer marker names its layer; a comp marker has no layerName", () => {
    const miss = fail(addMarkerScript(12, 1, "m", "Nope", undefined));
    expect(miss.message).toMatch(/^No layer named "Nope" in "Main"/);
    expect(miss.host.undo.begin).toBe(0);
    expect(miss.host.mutations).toEqual([]);
    const host = aeHost();
    expect(host.eval(addMarkerScript(12, 1, "m", "Logo", 0.5))).toEqual({ ok: true, value: { time: 1, comment: "m", on: "layer 2", layerName: "Logo" } });
    expect(host.eval(addMarkerScript(12, 1, "m", 2, undefined))).toEqual({ ok: true, value: { time: 1, comment: "m", on: "layer 2", layerName: "Logo" } });
    expect(host.eval(addMarkerScript(12, 2, "c", undefined, undefined))).toEqual({ ok: true, value: { time: 2, comment: "c", on: "comp" } });
    expect(host.changes).toEqual(["Logo: marker at 1", "Logo: marker at 1", "comp Main: marker at 2"]);
  });

  it("ae_queue_render: a repeated name fails through __compNamed; a unique one still queues", () => {
    const spec: ProjectSpec = { comps: [{ id: 12, name: "dup" }, { id: 15, name: "dup" }] };
    const r = fail(queueRenderScript("dup", "C:/r/a.mov", undefined), spec);
    // ae_queue_render takes no compId, so the next step cannot be "pass compId".
    expect(r.message).toBe(`The name "dup" matches 2 compositions: 12 "dup", 15 "dup" ${DASH} rename all but one with ae_set_comp_props (name), then retry.`);
    expect(r.host.undo.begin).toBe(0);
  });

  it("compByNameScript answers the one composition, and fails for a repeated name (ae_render_comp's check, spec 11.4)", () => {
    expect(aeHost().eval(compByNameScript("Main"))).toEqual({ ok: true, value: { id: 12, name: "Main" } });
    const dup = fail(compByNameScript("dup"), { comps: [{ id: 12, name: "dup" }, { id: 15, name: "dup" }] }).message;
    expect(dup).toMatch(/^The name "dup" matches 2 compositions: /);
    // ae_render_comp takes no compId: neither next step may offer one.
    expect(dup).not.toMatch(/compId/);
    expect(dup).toMatch(/rename all but one with ae_set_comp_props \(name\), then retry\.$/);
    const miss = fail(compByNameScript("Mian"), { comps: [MAIN] }).message;
    expect(miss).toBe(`No composition named "Mian"; the project has 1: 12 "Main" ${DASH} names match exactly, case included; pass one of these names.`);
  });

  it("cuts a long list of repeats by length and keeps the next step", () => {
    const long = "d".repeat(60);
    const spec: ProjectSpec = { comps: [{ id: 12, name: "Main", layers: Array.from({ length: 40 }, () => ({ kind: "solid" as const, name: long })) }] };
    const r = fail(getLayerScript(12, long), spec);
    expect(r.message.length).toBeLessThan(1000);
    expect(r.message).toMatch(/ \.\.\. and \d+ more — pass layerIndex to pick one\.$/);
    const comps: ProjectSpec = { comps: Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, name: long })) };
    const c = fail(getCompScript(long), comps);
    expect(c.message.length).toBeLessThan(1000);
    expect(c.message).toMatch(/ \.\.\. and \d+ more — pass compId to pick one\.$/);
  });
});

describe("AE-03 ae_find_layers at the host (AT3)", () => {
  const KINDS: ProjectSpec = {
    comps: [
      {
        id: 12,
        name: "Main",
        layers: [
          { kind: "text", name: "Title", text: "Hello World" },
          { kind: "text", name: "Sub", text: "goodbye" },
          { kind: "shape", name: "Logo" },
          { kind: "solid", name: "BG" },
          { kind: "null", name: "Ctrl" },
          { kind: "adjustment", name: "Grade" },
          { kind: "camera", name: "Camera 1" },
          { kind: "light", name: "Light 1" },
          { kind: "footage", name: "clip.mov" },
        ],
      },
    ],
  };
  const find = (f: Parameters<typeof findLayersScript>[1], spec: ProjectSpec = KINDS) => {
    const r = aeHost(spec).eval(findLayersScript(12, f));
    if (!r.ok) throw new Error(r.error.message);
    return r.value as { index: number; name: string; kind: string; enabled: boolean }[];
  };

  it("returns only text layers for kind text, in timeline order (FR acceptance 3)", () => {
    expect(find({ kind: "text" })).toEqual([
      { index: 1, name: "Title", kind: "text", enabled: true },
      { index: 2, name: "Sub", kind: "text", enabled: true },
    ]);
    expect(aeHost().eval(findLayersScript(12, { kind: "text" }))).toEqual({ ok: true, value: [{ index: 1, name: "Title", kind: "text", enabled: true }] });
  });

  it("finds every kind __kind reports, cameras and lights included", () => {
    for (const [kind, name] of [["shape", "Logo"], ["solid", "BG"], ["null", "Ctrl"], ["adjustment", "Grade"], ["camera", "Camera 1"], ["light", "Light 1"], ["footage", "clip.mov"]] as const) {
      expect(find({ kind }).map((l) => l.name), kind).toEqual([name]);
    }
    expect(find({ kind: "precomp" })).toEqual([]);
  });

  it("matches nameContains and textContains case-insensitively, text on text layers only, every filter ANDed", () => {
    expect(find({ nameContains: "t" }).map((l) => l.name)).toEqual(["Title", "Ctrl", "Light 1"]);
    expect(find({ textContains: "WORLD" }).map((l) => l.name)).toEqual(["Title"]);
    expect(find({ textContains: "o" }).map((l) => l.name)).toEqual(["Title", "Sub"]);
    expect(find({ textContains: "o", nameContains: "su" }).map((l) => l.name)).toEqual(["Sub"]);
    expect(find({ kind: "shape", textContains: "o" })).toEqual([]);
  });

  it("filters on enabled, and an empty result is [] (not an error)", () => {
    const host = aeHost(KINDS);
    host.comp(12).layer(4).enabled = false;
    const r = host.eval(findLayersScript(12, { enabled: false }));
    expect(r).toEqual({ ok: true, value: [{ index: 4, name: "BG", kind: "solid", enabled: false }] });
    expect(find({ nameContains: "zzz" })).toEqual([]);
    expect(host.mutations).toEqual([]);
    expect(host.undo.begin).toBe(0);
  });

  it("a bad comp ref is __comp's error", () => {
    expect(fail(findLayersScript(99, {})).message).toMatch(/^No composition with id 99; /);
    expect(fail(findLayersScript("Nope", {})).message).toMatch(/^No composition named "Nope"; /);
  });
});

describe("AE-03 ae_undo / ae_redo at the host (AT6)", () => {
  it("undo reverses the last tool call, redo restores it, and neither adds an entry", () => {
    const host = aeHost();
    expect(host.eval(setLayerPropsScript(12, 2, { opacity: 50 })).ok).toBe(true);
    expect(host.history()).toEqual({ undo: 1, redo: 0 });
    const opacity = () => host.comp(12).layer(2).property("ADBE Transform Group").property("ADBE Opacity").value;
    expect(opacity()).toBe(50);
    expect(host.eval(undoRedoScript("undo"))).toEqual({ ok: true, value: { command: "Undo", menuId: 16 } });
    expect(opacity()).toBe(100);
    expect(host.history()).toEqual({ undo: 0, redo: 1 });
    expect(host.eval(undoRedoScript("redo"))).toEqual({ ok: true, value: { command: "Redo", menuId: 2035 } });
    expect(opacity()).toBe(50);
    expect(host.history()).toEqual({ undo: 1, redo: 0 });
    expect(host.undo.begin).toBe(1);
  });

  it("undo reverses edits whose setters the host does not log: comp duration and a layer's enabled", () => {
    const host = aeHost();
    expect(host.eval(setCompPropsScript(12, { duration: 5 })).ok).toBe(true);
    expect(host.eval(setLayerPropsScript(12, 1, { enabled: false })).ok).toBe(true);
    expect(host.history()).toEqual({ undo: 2, redo: 0 });
    expect(host.mutations).toEqual([]);
    expect(host.eval(undoRedoScript("undo")).ok).toBe(true);
    expect(host.comp(12).layer(1).enabled).toBe(true);
    expect(host.comp(12).duration).toBe(5);
    expect(host.eval(undoRedoScript("undo")).ok).toBe(true);
    expect(host.comp(12).duration).toBe(10);
    expect(host.history()).toEqual({ undo: 0, redo: 2 });
  });

  it("with nothing to undo it is a silent no-op (live L3)", () => {
    const host = aeHost();
    expect(host.eval(undoRedoScript("undo"))).toEqual({ ok: true, value: { command: "Undo", menuId: 16 } });
    expect(host.history()).toEqual({ undo: 0, redo: 0 });
  });

  it("the label lookup the FR asked for would purge the history: the host returns Purge > Undo for it", () => {
    const host = aeHost();
    host.eval(setLayerPropsScript(12, 2, { opacity: 50 }));
    expect(host.eval(wrapAe('\n  return app.findMenuCommandId("Undo");'))).toEqual({ ok: true, value: 2371 });
    host.eval(wrapAe('\n  app.executeCommand(app.findMenuCommandId("Undo"));\n  return 1;'));
    expect(host.history()).toEqual({ undo: 0, redo: 0 });
  });
});

describe("AE-03 ae_batch at the host (AT4, AT5)", () => {
  const shotOps = [
    { tool: "ae_create_comp", body: createCompBody({ name: "Shot", width: 1920, height: 1080, frameRate: 30, duration: 10, pixelAspect: 1 }) },
    { tool: "ae_add_layer", body: addLayerBody({ compId: "Shot", kind: "solid", name: "A" }) },
    { tool: "ae_add_layer", body: addLayerBody({ compId: "Shot", kind: "solid", name: "B" }) },
    { tool: "ae_add_layer", body: addLayerBody({ compId: "Shot", kind: "solid", name: "C" }) },
    { tool: "ae_set_layer_props", body: setLayerPropsBody("Shot", "B", { opacity: 50 }) },
  ];
  type Ok = { ok: true; results: unknown[]; names: { id: number; layers: [number, string][] }[] };
  type Failed = { ok: false; at: number; message: string; line: number | null; results: unknown[]; rolledBack?: boolean | null; names?: unknown };

  it("runs 5 operations in one undo group, removes its sentinel inside it, and one Undo restores everything (AT4)", () => {
    const host = aeHost();
    const r = host.eval(aeBatchScript(shotOps, true, "Batch"));
    if (!r.ok) throw new Error(r.error.message);
    const v = r.value as Ok;
    expect(v.ok).toBe(true);
    expect(v.results).toHaveLength(5);
    expect(host.undo).toEqual({ begin: 1, end: 1 });
    expect(host.itemsNamed("__acm_batch")).toEqual([]);
    const shot = host.itemsNamed("Shot")[0];
    expect(v.names).toEqual([{ id: shot.id, layers: [[1, "C"], [2, "B"], [3, "A"]] }]);
    expect(aeNameToIndex(v.names)).toEqual({ [String(shot.id)]: { C: 1, B: 2, A: 3 } });
    expect(host.history()).toEqual({ undo: 1, redo: 0 });
    expect(host.eval(undoRedoScript("undo")).ok).toBe(true);
    expect(host.itemsNamed("Shot")).toEqual([]);
    expect(host.history()).toEqual({ undo: 0, redo: 1 });
  });

  it("a bad operation 3 with atomic true leaves the project as it was, rolled back in the same eval (AT5)", () => {
    const host = aeHost();
    // The operator's own earlier step, which the rollback must not touch.
    host.eval(setLayerPropsScript(12, 1, { opacity: 10 }));
    const before = host.layers(12);
    const ops = [shotOps[0]!, shotOps[1]!, { tool: "ae_set_layer_props", body: setLayerPropsBody("Shot", "nope", { opacity: 50 }) }, shotOps[2]!, shotOps[3]!];
    const batch = buildAeBatch(ops, true, "Batch");
    const r = host.eval(batch.script);
    if (!r.ok) throw new Error(r.error.message);
    const v = r.value as Failed;
    expect(v).toMatchObject({ ok: false, at: 3, rolledBack: true });
    expect(v.message).toMatch(/^No layer named "nope" in "Shot"/);
    expect(v.results).toHaveLength(2);
    expect(host.itemsNamed("Shot")).toEqual([]);
    expect(host.itemsNamed("__acm_batch")).toEqual([]);
    expect(host.layers(12)).toEqual(before);
    // The failed batch sits on the Redo stack; the operator's step is still the next Undo.
    expect(host.history()).toEqual({ undo: 1, redo: 1 });
    expect(locateAeBatchError(batch, v.line ?? undefined, v.at)).toEqual({ kind: "helper", helper: "__layerNamed" });
  });

  it("with atomic false, what ran stays as one undo entry and the current names come back", () => {
    const host = aeHost();
    const ops = [shotOps[0]!, shotOps[1]!, { tool: "ae_set_layer_props", body: setLayerPropsBody("Shot", "nope", { opacity: 50 }) }];
    const r = host.eval(aeBatchScript(ops, false, "Batch"));
    if (!r.ok) throw new Error(r.error.message);
    const v = r.value as Failed;
    expect(v).toMatchObject({ ok: false, at: 3 });
    expect(v.rolledBack).toBeUndefined();
    expect(host.itemsNamed("Shot")).toHaveLength(1);
    expect(host.itemsNamed("__acm_batch")).toEqual([]);
    expect(v.names).toEqual([{ id: host.itemsNamed("Shot")[0].id, layers: [[1, "A"]] }]);
    expect(host.history()).toEqual({ undo: 1, redo: 0 });
  });

  it("a lookup failing in operation 1 rolls back only the sentinel: the operator's earlier step stays (AT5, L7)", () => {
    const host = aeHost();
    host.eval(setLayerPropsScript(12, 1, { opacity: 10 }));
    const r = host.eval(aeBatchScript([{ tool: "ae_delete_layer", body: deleteLayerBody(12, "nope") }], true, "Batch"));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ ok: false, at: 1, rolledBack: true, results: [] });
    expect(host.comp(12).layer(1).property("ADBE Transform Group").property("ADBE Opacity").value).toBe(10);
    expect(host.history()).toEqual({ undo: 1, redo: 1 });
    // A non-atomic batch that fails before changing anything leaves no entry at all.
    const loose = aeHost();
    loose.eval(setLayerPropsScript(12, 1, { opacity: 10 }));
    const lr = loose.eval(aeBatchScript([{ tool: "ae_delete_layer", body: deleteLayerBody(12, "nope") }], false, "Batch"));
    // entered false: no operation reached its change step, so the server can say nothing changed.
    expect(lr).toMatchObject({ ok: true, value: { ok: false, at: 1, entered: false } });
    expect(loose.history()).toEqual({ undo: 1, redo: 0 });
  });

  it("reports rolledBack false when Edit > Undo does not remove the batch, and never touches the sentinel after the group", () => {
    const host = aeHost();
    host.app.executeCommand = () => undefined;
    const ops = [shotOps[0]!, { tool: "ae_delete_layer", body: deleteLayerBody("Shot", "nope") }];
    const r = host.eval(aeBatchScript(ops, true, "Batch"));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ ok: false, at: 2, rolledBack: false });
    expect(host.itemsNamed("__acm_batch")).toHaveLength(1);
    expect(host.mutations.filter((m) => m === "folder.remove")).toEqual([]);
  });

  it("the operations' own __undo calls open no nested group", () => {
    const host = aeHost();
    let depth = 0;
    let deepest = 0;
    const begin = host.app.beginUndoGroup;
    const end = host.app.endUndoGroup;
    host.app.beginUndoGroup = (n: string) => {
      deepest = Math.max(deepest, ++depth);
      begin.call(host.app, n);
    };
    host.app.endUndoGroup = () => {
      depth--;
      end.call(host.app);
    };
    expect(host.eval(aeBatchScript(shotOps, true, "Batch")).ok).toBe(true);
    expect(deepest).toBe(1);
  });

  it("maps a body line to that operation's body line, a helper line to the helper, a frame line to outside", () => {
    const ops = [shotOps[0]!, { tool: "ae_add_layer", body: addLayerBody({ compId: 12, kind: "solid", name: "X" }) }, { tool: "ae_set_text", body: setTextBody({ compId: 12, layerIndex: 3, text: "x" }) }];
    const batch = buildAeBatch(ops, true, "Batch");
    const host = aeHost();
    const r = host.eval(batch.script);
    if (!r.ok) throw new Error(r.error.message);
    const v = r.value as Failed;
    expect(v.at).toBe(3);
    expect(v.message).toMatch(/is not a text layer/);
    const body = ops[2]!.body;
    const k = body.split("\n").findIndex((l) => l.includes("is not a text layer")); // body line (lead line is index 0)
    expect(locateAeBatchError(batch, v.line ?? undefined, 3)).toEqual({ kind: "body", bodyLine: k });
    expect(aeBatchExcerpt(batch, 3, k)[1]).toMatch(new RegExp(`^>>> ${k}: if \\(l\\.matchName !== "ADBE Text Layer"\\)`));
    // A frame line (the __undo shim) and a line of another operation's body read as outside.
    const frameLine = batch.script.split("\n").findIndex((l) => l.includes("__undo = function (n, f)")) + 1;
    expect(locateAeBatchError(batch, frameLine, 3)).toEqual({ kind: "outside" });
    expect(locateAeBatchError(batch, batch.segments[1]!.first, 3)).toEqual({ kind: "outside" });
    expect(locateAeBatchError(batch, lineCount(batch.script) + 5, 3)).toEqual({ kind: "outside" });
    expect(locateAeBatchError(batch, undefined, 3)).toEqual({ kind: "unknown" });
    const helperLine = aeHelperRanges().find((h) => h.name === "__comp")!.first + 1;
    expect(locateAeBatchError(batch, helperLine, 3)).toEqual({ kind: "helper", helper: "__comp" });
  });

  it("builds nameToIndex from plain data: repeated names give arrays, and __proto__ or toString are ordinary keys", () => {
    const map = aeNameToIndex([{ id: 12, layers: [[1, "__proto__"], [2, "toString"], [3, "dup"], [4, "constructor"], [5, "dup"]] }]);
    expect(Object.getPrototypeOf(map["12"])).toBe(Object.prototype);
    expect(Object.keys(map["12"]!)).toEqual(["__proto__", "toString", "dup", "constructor"]);
    expect(map["12"]!["dup"]).toEqual([3, 5]);
    expect(JSON.parse(JSON.stringify(map))).toEqual(JSON.parse('{"12":{"__proto__":1,"toString":2,"dup":[3,5],"constructor":4}}'));
    expect(aeNameToIndex("garbage")).toEqual({});
  });
});
