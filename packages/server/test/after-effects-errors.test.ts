import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { AppDisconnectedError, EvalTimeoutError, ScriptError, type AppBridge, type JsonValue } from "../src/bridge/types.js";
import {
  AE_PRELUDE_LINES,
  EFFECT_MISS,
  EffectCatalog,
  HOST_LINE_GUARD,
  LIST_COMPOSITIONS,
  LIST_INSTALLED_EFFECTS,
  SLOW_EFFECTS_READ_MS,
  addLayerScript,
  addMaskScript,
  aeExcerpt,
  aeHelperRanges,
  aeListSuggestions,
  applyEffectScript,
  enrichAeError,
  evaluateAe,
  filteredEffectsScript,
  getCompScript,
  getKeyframesScript,
  getLayerScript,
  getLayerStylesScript,
  locateAeError,
  setEffectParamScript,
  setExpressionScript,
  setLayerPropsScript,
  setTextScript,
  withEffectSuggestions,
  wrapAe,
  type InstalledEffect,
} from "../src/tools/after-effects.js";
import { runAsToolCall } from "../src/tools/call-context.js";
import { MESSAGE_LIMIT, setRedactionSecrets } from "../src/tools/echo.js";
import { lineCount } from "../src/tools/raw-script.js";
import { scriptErrorText } from "../src/tools/result.js";
import { stripAeVendor, suggestionThreshold, fold } from "../src/tools/suggest.js";
import { AE_EFFECT_ITEMS } from "./ae-effects-fixture.js";
import { HOST_JSX_PATH, MAIN, aeHost, type AeHost, type CompSpec, type EvalReply, type HostOptions, type ProjectSpec } from "./ae-host.js";

const SUFFIX = "\n})()";
const PRELUDE = wrapAe("").slice(0, -SUFFIX.length);
const DASH = "—";
const TOKEN40 = "Zq3vT8kLm2Np5Rs7Wx9Yb4Cd6Ef1Gh0Jk2Lm4No";

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
  const host = aeHost(spec, options);
  const r = host.eval(script);
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.value)}`);
  return { ...r.error, host };
}

/** What the socket lane would raise for that failure. */
function scriptError(r: { message: string; line: number | null }): ScriptError {
  return new ScriptError("after_effects", r.message, r.line ?? undefined, { code: "HOST_ERROR" });
}


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

  it("uses no ES5 array or string methods in the helpers (the regex ES3 gate cannot see these)", () => {
    for (const banned of [".map(", ".filter(", ".forEach(", ".indexOf(", ".trim(", "Object.keys", "Array.isArray"]) expect(PRELUDE, banned).not.toContain(banned);
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
    expect(r.message).toMatch(/ \.\.\. and \d+ more /);
    expect(scriptErrorText(enrichAeError(scriptError(r), getCompScript(99)) as ScriptError)).toMatch(/\(ae_list_compositions lists them all\)\.$/);
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
    expect(r.message).toMatch(/ \.\.\. and \d+ more /);
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
      'Property path not found on layer 5 "Twins" (shape): segment "Shape 3" not found under ["ADBE Root Vectors Group"]; children here: ["Shape 1", "Shape 1"] ' +
        `${DASH} some of these names repeat, so a path cannot tell those apart; rename them in After Effects so each is unique, then pass one.`,
    );
    expect(twins.message).not.toContain("use one of these names");
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
    expect(aeListSuggestions(fail(setEffectParamScript(12, 1, 5, "Blurriness", 5), spec).message)).toEqual([]);
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

  it("setEffectParamScript on a layer without effects, and on a camera", () => {
    expect(fail(setEffectParamScript(12, 2, 1, "Blurriness", 5), spec).message).toBe(`Layer 2 "Plain" (solid) has no effects ${DASH} apply one first (ae_apply_effect).`);
    expect(fail(setEffectParamScript(12, 3, 1, "x", 0), spec).message).toBe(
      `Layer 3 "Camera 1" (camera) cannot have effects ${DASH} address a footage, solid, text, shape, adjustment or precomp layer.`,
    );
  });

  it("applyEffectScript on a camera, and an unknown effect at the canAddProperty body line", () => {
    expect(fail(applyEffectScript(12, 3, "ADBE Gaussian Blur 2"), spec).message).toMatch(/^Layer 3 "Camera 1" \(camera\) cannot have effects/);
    const script = applyEffectScript(12, 1, "ADBE Gausian Blur 2");
    const r = fail(script, spec);
    expect(r.message).toBe(
      `${EFFECT_MISS}ADBE Gausian Blur 2 (layer 1 "BG" (solid)) ${DASH} use an installed effect's match name, e.g. 'ADBE Gaussian Blur 2', or its display name.`,
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
});

describe("aeListSuggestions", () => {
  it("parses each of the three list formats", () => {
    expect(aeListSuggestions('Property path not found on layer 1 "T" (text): segment "Positon" not found at the top of the layer; children here: ["Position", "Scale"] — use one of these names.')).toEqual(["Position"]);
    expect(aeListSuggestions('Effect not found on layer 1 "BG" (solid): "Glw"; effects on this layer: ["Glow", "Tint"] — pass one.')).toEqual(["Glow"]);
    expect(aeListSuggestions('Parameter not found on effect "Glow": "Glow Radiuss"; parameters: ["Glow Radius", "Glow Threshold"] — use one.')).toEqual(["Glow Radius"]);
  });

  it("gives nothing for a numeric query, an unparseable or absent list, or a non-list message", () => {
    expect(aeListSuggestions('Effect not found on layer 1 "BG" (solid): "5"; effects on this layer: ["Glow"] — x')).toEqual([]);
    expect(aeListSuggestions('Parameter not found on effect "Glow": "Glw"; parameters: ["Glow", — x')).toEqual([]);
    expect(aeListSuggestions("Layer index 9 is out of range")).toEqual([]);
    expect(aeListSuggestions('Parameter not found on effect "Glow": "Glw"; parameters: [] — x')).toEqual([]);
  });

  it("never suggests a cut (63-character) name, and a cut query gives nothing (M7)", () => {
    const cut = `${"A".repeat(60)}...`;
    expect(aeListSuggestions(`Parameter not found on effect "E": "${"A".repeat(59)}B"; parameters: ["${cut}", "Other"] — x`)).toEqual([]);
    expect(aeListSuggestions(`Parameter not found on effect "E": "${cut}"; parameters: ["${"A".repeat(60)}"] — x`)).toEqual([]);
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
  const STRICT = { caseSensitive: true, displayNamesAccepted: false };
  const LENIENT = { caseSensitive: false, displayNamesAccepted: true };
  const REFUSED = "That effect is installed, but After Effects would not add it to this layer.";

  it("an installed match name gets the layer-refusal note, under either rule", async () => {
    for (const rules of [STRICT, LENIENT]) {
      const out = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("ADBE Gaussian Blur 2"), "ADBE Gaussian Blur 2", rules)) as ScriptError;
      expect(out.details.note).toBe('"ADBE Gaussian Blur 2" (Gaussian Blur) is installed, but After Effects would not add it to this layer.');
      expect(out.details.suggestions).toBeUndefined();
    }
  });

  it("a display name: the match name to pass, or the refusal note when display names are accepted", async () => {
    const strict = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("Gaussian Blur"), "Gaussian Blur", STRICT)) as ScriptError;
    expect(strict.details.suggestions).toEqual([{ name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" }]);
    expect(strict.details.note).toBe(`That effect is installed; pass its match name ${DASH} if that also fails, this layer cannot take it.`);
    const lenient = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("Gaussian Blur"), "Gaussian Blur", LENIENT)) as ScriptError;
    expect(lenient.details).toMatchObject({ note: REFUSED });
    expect(lenient.details.suggestions).toBeUndefined();
  });

  it("a case-folded hit: the exact name and a case note, or the refusal note when case does not matter", async () => {
    const strict = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("adbe gaussian blur 2"), "adbe gaussian blur 2", STRICT)) as ScriptError;
    expect(strict.details.suggestions).toEqual([{ name: "ADBE Gaussian Blur 2", label: "Gaussian Blur" }]);
    expect(strict.details.note).toBe("Names must match exactly, case included.");
    const lenient = (await withEffectSuggestions(fixedCatalog(EFFECTS).catalog, missFor("adbe gaussian blur 2"), "adbe gaussian blur 2", { ...STRICT, caseSensitive: false })) as ScriptError;
    expect(lenient.details.note).toBe(REFUSED);
  });

  it("a typo gets up to 3 ranked names (acceptance 4)", async () => {
    for (const rules of [STRICT, LENIENT]) {
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
});
