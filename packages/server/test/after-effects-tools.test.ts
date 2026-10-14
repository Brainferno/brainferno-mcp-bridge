import { describe, expect, it } from "vitest";

import * as AE from "../src/tools/after-effects.js";
import {
  AERENDER_INFO,
  aerenderExecutable,
  filteredEffectsScript,
  LIST_COMPOSITIONS,
  LIST_FOOTAGE,
  LIST_INSTALLED_EFFECTS,
  PROJECT_INFO,
  wrapAe,
  queueRenderScript,
  addLayerScript,
  addLayerStyleScript,
  addMarkerScript,
  addMaskScript,
  addShapeScript,
  addToEssentialGraphicsScript,
  exportMogrtScript,
  applyEffectScript,
  createCompScript,
  deleteLayerScript,
  duplicateLayerScript,
  getCompScript,
  getKeyframesScript,
  getLayerScript,
  getLayerStylesScript,
  importAsCompScript,
  importFootageScript,
  openProjectScript,
  removeKeyframesScript,
  removeLayerStyleScript,
  renderFrameScript,
  saveProjectScript,
  setCompPropsScript,
  setEffectParamScript,
  setExpressionScript,
  setKeyframesScript,
  setLayerPropsScript,
  setLayerStyleParamScript,
  setTextScript,
  runRawScript,
  aeArgsLiteral,
  RUN_SCRIPT_MANAGED_REFUSAL,
  // AE-03
  AE_BATCH_EXCLUDED,
  AE_BATCH_OPS,
  AE_BATCH_TOOLS,
  AE_REDO_COMMAND,
  AE_UNDO_COMMAND,
  addLayerBody,
  addMarkerBody,
  addMaskBody,
  addShapeBody,
  addToEssentialGraphicsBody,
  aeBatchScript,
  applyEffectBody,
  buildAeBatch,
  compByNameScript,
  createCompBody,
  deleteLayerBody,
  duplicateLayerBody,
  findLayersScript,
  queueRenderBody,
  removeKeyframesBody,
  removeLayerStyleBody,
  setCompPropsBody,
  setEffectParamBody,
  setExpressionBody,
  setKeyframesBody,
  setLayerPropsBody,
  setLayerStyleParamBody,
  setTextBody,
  undoRedoScript,
} from "../src/tools/after-effects.js";
import { readFileSync } from "node:fs";
import { asciiLiteral, lineCount, rawScriptWrapper } from "../src/tools/raw-script.js";
import { es3Violations, es5Calls } from "./es3.js";

/** aeArgsLiteral's literal, or a thrown error naming its refusal. */
const litOf = (v: Record<string, unknown>): string => {
  const r = aeArgsLiteral(v);
  if (!("literal" in r)) throw new Error(r.refusal);
  return r.literal;
};

// Escapes, so this source stays free of a raw U+2028 (a line terminator in source).
const LS = "\u2028";
const U_UML = "\u00fc";
const E_ACUTE = "\u00e9";

const SAMPLES: Record<string, string> = {
  LIST_COMPOSITIONS,
  PROJECT_INFO,
  LIST_FOOTAGE,
  AERENDER_INFO,
  getComp: getCompScript(12),
  getLayer: getLayerScript(12, 1),
  open: openProjectScript("C:/p/a.aep"),
  saveInPlace: saveProjectScript(undefined),
  saveAs: saveProjectScript("C:/p/b.aep"),
  import: importFootageScript("C:/p/clip.mov"),
  shapeRect: addShapeScript({ compId: 12, kind: "rectangle", width: 300, height: 200, fill: "#ff5522", stroke: "#000000", strokeWidth: 8 }),
  shapeStar: addShapeScript({ compId: 12, kind: "star", points: 6, outerRadius: 120, innerRadius: 60, fill: null }),
  maskRect: addMaskScript({ compId: 12, layerIndex: 1, kind: "rectangle", left: 100, top: 50, right: 400, bottom: 300, feather: 20 }),
  maskEllipse: addMaskScript({ compId: 12, layerIndex: 1, kind: "ellipse", mode: "subtract" }),
  importPsdComp: importAsCompScript("C:/p/art.psd", false),
  importAiCropped: importAsCompScript("C:/p/logo.ai", true),
  createComp: createCompScript({ name: "Main", width: 1920, height: 1080, frameRate: 30, duration: 10, pixelAspect: 1 }),
  solid: addLayerScript({ compId: 12, kind: "solid", color: "#ff8800", name: "bg" }),
  text: addLayerScript({ compId: 12, kind: "text", text: 'Say "hi"' }),
  footage: addLayerScript({ compId: 12, kind: "footage", itemId: 7 }),
  nullLayer: addLayerScript({ compId: 12, kind: "null" }),
  adjustment: addLayerScript({ compId: 12, kind: "adjustment" }),
  props: setLayerPropsScript(12, 2, { name: "x", position: [100, 200], opacity: 50, parentIndex: 1 }),
  unparent: setLayerPropsScript(12, 2, { parentIndex: null }),
  dup: duplicateLayerScript(12, 2, "copy"),
  del: deleteLayerScript(12, 2),
  keys: setKeyframesScript({ compId: 12, layerIndex: 2, property: "position", keys: [{ time: 0, value: [0, 0] }, { time: 1, value: [100, 100], easy: true }] }),
  keysPath: setKeyframesScript({ compId: 12, layerIndex: 2, property: "opacity", propertyPath: ["ADBE Effect Parade", "Gaussian Blur", "Blurriness"], keys: [{ time: 0, value: 0 }] }),
  getKeys: getKeyframesScript(12, 2, "scale", undefined),
  removeKeys: removeKeyframesScript(12, 2, "rotation", undefined),
  expr: setExpressionScript(12, 2, "rotation", undefined, "time * 90"),
  clearExpr: setExpressionScript(12, 2, "rotation", undefined, null),
  effect: applyEffectScript(12, 2, "ADBE Gaussian Blur 2"),
  effectParam: setEffectParamScript(12, 2, 1, "Blurriness", 25),
  effectParamByName: setEffectParamScript(12, 2, "Tint", "Map Black To", [0, 0, 1]),
  setText: setTextScript({ compId: 12, layerIndex: 1, text: "Hello\nWorld", fontSize: 72, font: "Arial-BoldMT", color: "#f5a623", justification: "center" }),
  marker: addMarkerScript(12, 2.5, "beat", undefined, undefined),
  layerMarker: addMarkerScript(12, 2.5, "hit", 3, 0.5),
  frame: renderFrameScript(12, 1.5, "C:/tmp/f.png", 1024),
  addStyle: addLayerStyleScript(12, 2, "dropShadow"),
  addStyleMapped: addLayerStyleScript(12, 2, "stroke"),
  getStyles: getLayerStylesScript(12, 2),
  styleParam: setLayerStyleParamScript(12, 2, "dropShadow", "Distance", 12),
  styleParamColor: setLayerStyleParamScript(12, 2, "stroke", "Color", "#ff8800"),
  styleParamMatchName: setLayerStyleParamScript(12, 2, "dropShadow", "dropShadow/blur", 3),
  footageNoItem: addLayerScript({ compId: 12, kind: "footage" }),
  removeStyle: removeLayerStyleScript(12, 2, "satin"),
  egpTransform: addToEssentialGraphicsScript(12, 1, "position", undefined),
  egpText: addToEssentialGraphicsScript(12, 1, "position", ["ADBE Text Properties", "ADBE Text Document"]),
  exportMogrt: exportMogrtScript(12, "C:/mogrts", "Fancy Lower Third", true),
  exportMogrtKeep: exportMogrtScript(12, "C:/mogrts", 'Say "hi"', false),
  effectNamed: applyEffectScript(12, 2, "ADBE Slider Control", "Speed"),
  importPsdTimed: importAsCompScript("C:/p/art.psd", false, { duration: 8, frameRate: 29.97 }),
  compProps: setCompPropsScript(12, { name: "LT", duration: 8, frameRate: 29.97, width: 1920, height: 1080 }),
  compDurationOnly: setCompPropsScript(12, { duration: 5 }),
  textOrigin: addLayerScript({ compId: 12, kind: "text", text: "Hi", anchor: "origin" }),
  setTextOrigin: setTextScript({ compId: 12, layerIndex: 1, justification: "left", anchor: "origin" }),
  queueRender: queueRenderScript("Main", "C:/renders/main.mov", "H.264 - Match Render Settings"),
  listEffects: LIST_INSTALLED_EFFECTS,
  filteredEffects: filteredEffectsScript("gausian blur", 3),
  propsParentOnly: setLayerPropsScript(12, 2, { parentIndex: 1 }),
  // AE-01 (F6, T5): ES3-clean caller text with quotes, args and a name with non-ASCII, quotes, a backslash and U+2028.
  runRawScript: runRawScript('var s = "say \\"hi\\" " + __args.n;\n__log(s);\ns', {
    args: litOf({ n: `a"b\\c${LS}${E_ACUTE}` }),
    undoGroupName: `Schritt "${U_UML}"`,
    suppressDialogs: true,
  }),
  // AE-03: name addressing (a name with quotes, so escaping is exercised), the new builders.
  propsByName: setLayerPropsScript('Say "hi"', 'Say "hi"', { opacity: 50, parentIndex: "Parent" }),
  propsNamedParentOnly: setLayerPropsScript(12, 2, { parentIndex: "Ctrl" }),
  getCompByName: getCompScript("Main"),
  getLayerByName: getLayerScript("Main", "Title"),
  markerByName: addMarkerScript("Main", 1, "beat", "Title", undefined),
  findLayers: findLayersScript(12, {}),
  findLayersFiltered: findLayersScript('Say "hi"', { nameContains: 'a"b', kind: "text", textContains: "Hello", enabled: true }),
  compByName: compByNameScript('Say "hi"'),
  undo: undoRedoScript("undo"),
  redo: undoRedoScript("redo"),
  batchAtomic: aeBatchScript(
    [
      { tool: "ae_create_comp", body: createCompBody({ name: "Shot", width: 1920, height: 1080, frameRate: 30, duration: 10, pixelAspect: 1 }) },
      { tool: "ae_add_layer", body: addLayerBody({ compId: "Shot", kind: "solid", name: "A" }) },
      { tool: "ae_set_layer_props", body: setLayerPropsBody("Shot", "A", { opacity: 50 }) },
    ],
    true,
    'Batch "x"',
  ),
  batchLoose: aeBatchScript([{ tool: "ae_delete_layer", body: deleteLayerBody(12, 1) }], false, "Batch"),
};

// Exported builders whose script only reads the project. The "classifies every
// exported script builder" test below collects every exported function whose name
// ends in "Script" and fails if one is in none of READ_ONLY_BUILDERS, MUST_UNDO and
// NO_UNDO_OK, or if one of those three sets names something that is not such a
// builder - so a new mutating builder can't silently skip the __undo check. It does
// not look at SAMPLES (the ES3 test covers only what SAMPLES lists) and does not
// discover constants (READ_ONLY_CONSTS is kept by hand). aerenderExecutable is a
// pure path helper, not a script builder; the stale check exempts it by name.
const READ_ONLY_BUILDERS = new Set([
  "getCompScript",
  "getLayerScript",
  "getKeyframesScript",
  "getLayerStylesScript",
  "filteredEffectsScript", // AE-16: the effect catalog's filtered read
  "aerenderExecutable", // pure path helper, not a script
  "findLayersScript", // AE-03: ae_find_layers
  "compByNameScript", // AE-03: ae_render_comp's check that its composition name is unique
]);
const READ_ONLY_CONSTS = new Set(["LIST_COMPOSITIONS", "LIST_FOOTAGE", "PROJECT_INFO", "AERENDER_INFO", "LIST_INSTALLED_EFFECTS"]);

// Mutating builders that MUST wrap their change in __undo (one tool call = one Ctrl-Z).
const MUST_UNDO = new Set([
  "addLayerScript", "setLayerPropsScript", "duplicateLayerScript", "deleteLayerScript",
  "setKeyframesScript", "removeKeyframesScript", "setExpressionScript", "applyEffectScript",
  "setEffectParamScript", "setTextScript", "addMarkerScript", "importFootageScript",
  "importAsCompScript", "createCompScript", "addLayerStyleScript", "setLayerStyleParamScript",
  "removeLayerStyleScript", "addToEssentialGraphicsScript", "addShapeScript", "addMaskScript",
  "setCompPropsScript", "queueRenderScript",
  "runRawScript", // AE-01: ae_run_script runs the caller's whole script as one undo step
]);
// Builders that change state but legitimately do not use __undo: app-level ops
// (open/save), a self-cleaning preview render, and the Essential Graphics export
// (it saves the project and suppresses dialogs). Each is here on purpose.
// AE-03: undoRedoScript runs Edit > Undo/Redo, and an undo group around it is undefined; aeBatchScript
// opens its own app.beginUndoGroup (its operations' __undo is shimmed to run inside that one group).
const NO_UNDO_OK = new Set(["openProjectScript", "saveProjectScript", "renderFrameScript", "exportMogrtScript", "undoRedoScript", "aeBatchScript"]);

describe("After Effects tool scripts", () => {
  it("are all ES3-clean", () => {
    for (const [name, src] of Object.entries(SAMPLES)) expect(es3Violations(src), name).toEqual([]);
  });

  it("call no ES5-only built-in, in the helpers or in any builder body (the syntax gate cannot see these)", () => {
    for (const [name, src] of Object.entries(SAMPLES)) expect(es5Calls(src), name).toEqual([]);
  });

  it("give every throw its own next step: an em dash clause, or __pick's (directly, or as __miss's when it is given none) (AE-16, R17, G3)", () => {
    // A throw with no " — " would get enrichAeError's generic step, which cannot fit every message.
    let throws = 0;
    for (const [name, src] of Object.entries(SAMPLES)) {
      for (const line of src.split("\n").filter((l) => l.includes("throw new Error("))) {
        throws++;
        expect(line.includes("\\u2014") || line.includes("__pick(") || /__miss\(.*, null\)\);/.test(line), `${name}: ${line.trim()}`).toBe(true);
      }
    }
    expect(throws).toBeGreaterThan(40);
  });

  it("classifies every exported script builder (so a new mutating tool can't skip __undo)", () => {
    const exported = [
      ...Object.keys(AE).filter((k) => /Script$/.test(k) && typeof (AE as Record<string, unknown>)[k] === "function"),
      ...READ_ONLY_CONSTS,
    ];
    const classified = new Set([...MUST_UNDO, ...NO_UNDO_OK, ...READ_ONLY_BUILDERS, ...READ_ONLY_CONSTS]);
    const unclassified = exported.filter((k) => !classified.has(k));
    expect(unclassified, "classify these in after-effects-tools.test.ts: MUST_UNDO / NO_UNDO_OK / READ_ONLY_BUILDERS").toEqual([]);
    const exportedSet = new Set(exported);
    const stale = [...classified].filter((k) => !exportedSet.has(k) && k !== "aerenderExecutable");
    expect(stale, "these classifications name builders that no longer exist").toEqual([]);
  });

  it("every MUST_UNDO builder wraps its mutation in an undo group", () => {
    // Call each mutating builder once with representative args and check the script.
    const calls: Record<string, () => string> = {
      addLayerScript: () => addLayerScript({ compId: 12, kind: "solid", color: "#112233" }),
      setLayerPropsScript: () => setLayerPropsScript(12, 1, { opacity: 50 }),
      duplicateLayerScript: () => duplicateLayerScript(12, 1, "c"),
      deleteLayerScript: () => deleteLayerScript(12, 1),
      setKeyframesScript: () => setKeyframesScript({ compId: 12, layerIndex: 1, property: "opacity", keys: [{ time: 0, value: 0 }] }),
      removeKeyframesScript: () => removeKeyframesScript(12, 1, "opacity", undefined),
      setExpressionScript: () => setExpressionScript(12, 1, "opacity", undefined, "0"),
      applyEffectScript: () => applyEffectScript(12, 1, "ADBE Gaussian Blur 2"),
      setEffectParamScript: () => setEffectParamScript(12, 1, 1, "Blurriness", 5),
      setTextScript: () => setTextScript({ compId: 12, layerIndex: 1, text: "x" }),
      addMarkerScript: () => addMarkerScript(12, 1, "m", undefined, undefined),
      importFootageScript: () => importFootageScript("C:/x.mov"),
      importAsCompScript: () => importAsCompScript("C:/x.psd", false),
      createCompScript: () => createCompScript({ name: "C", width: 1920, height: 1080, frameRate: 30, duration: 10, pixelAspect: 1 }),
      addLayerStyleScript: () => addLayerStyleScript(12, 1, "dropShadow"),
      setLayerStyleParamScript: () => setLayerStyleParamScript(12, 1, "dropShadow", "Distance", 5),
      removeLayerStyleScript: () => removeLayerStyleScript(12, 1, "dropShadow"),
      addToEssentialGraphicsScript: () => addToEssentialGraphicsScript(12, 1, "position", undefined),
      addShapeScript: () => addShapeScript({ compId: 12, kind: "rectangle" }),
      addMaskScript: () => addMaskScript({ compId: 12, layerIndex: 1, kind: "rectangle" }),
      setCompPropsScript: () => setCompPropsScript(12, { duration: 5 }),
      queueRenderScript: () => queueRenderScript("Main", "C:/r.mov", undefined),
      runRawScript: () => runRawScript("1", { args: "{}", undoGroupName: "x", suppressDialogs: true }),
    };
    // The prelude itself defines __undo, so "contains __undo(" would hold for any wrapAe script: check
    // what follows the prelude, where a builder calls it (T4, AE-01).
    const PRELUDE = wrapAe("").slice(0, -"\n})()".length);
    for (const name of MUST_UNDO) {
      const build = calls[name];
      expect(build, `add a sample call for ${name}`).toBeDefined();
      const src = build!();
      if (name === "runRawScript") {
        // Not built on wrapAe (D2): pin the call, before the caller's text (T4).
        const call = 'return __undo("x", function () {';
        expect(src, name).toContain(call);
        expect(src.indexOf(call), name).toBeLessThan(src.indexOf("var __src"));
      } else {
        expect(src.startsWith(PRELUDE), name).toBe(true);
        expect(src.slice(PRELUDE.length), name).toContain("__undo(");
      }
    }
  });

  it("escape strings as JS literals", () => {
    expect(SAMPLES["text"]).toContain('addText("Say \\"hi\\"")');
    expect(SAMPLES["setText"]).toContain('"Hello\\nWorld"');
    expect(setLayerPropsScript(1, 1, { name: "a\u2028b" })).toContain('"a\\u2028b"');
    // AE-01 (T5): ae_run_script's undo group name and args are pure-ASCII literals (asciiLiteral, not lit).
    expect(SAMPLES["runRawScript"]).toContain('"Schritt \\"\\u00fc\\""');
    expect(SAMPLES["runRawScript"]).toContain('"a\\"b\\\\c\\u2028\\u00e9"');
    expect(SAMPLES["runRawScript"]).not.toContain(U_UML);
    expect(SAMPLES["runRawScript"]).not.toContain(E_ACUTE);
  });

  it("uses match names for transform properties and honors propertyPath", () => {
    expect(SAMPLES["keys"]).toContain('__prop(l, "position", null)');
    expect(SAMPLES["keysPath"]).toContain('["ADBE Effect Parade", "Gaussian Blur", "Blurriness"]');
    expect(SAMPLES["props"]).toContain('v = [100, 200]; if (v !== null) { t.property("ADBE Position").setValue(v); }');
    // AE-16 (M9): the parent is resolved before the undo group, with the "Parent" role in its message,
    // so an out-of-range parentIndex fails before anything changes (was: l.parent = __layer(c, 1); inside it).
    expect(SAMPLES["props"]).toContain('var parentLayer = __layer(c, 1, "Parent");');
    expect(SAMPLES["props"]).toContain("l.parent = parentLayer;");
    expect(SAMPLES["props"]!.indexOf('__layer(c, 1, "Parent")')).toBeLessThan(SAMPLES["props"]!.indexOf('__undo("Set layer properties"'));
    expect(SAMPLES["propsParentOnly"]).toContain('var parentLayer = __layer(c, 1, "Parent");');
    expect(SAMPLES["unparent"]).toContain("l.parent = null;");
    expect(SAMPLES["unparent"]).not.toContain("parentLayer");
  });

  it("travels as pure ASCII, every script built on the one prelude (AE-16)", () => {
    const suffix = "\n})()";
    const prelude = wrapAe("").slice(0, -suffix.length);
    for (const [name, src] of Object.entries(SAMPLES)) {
      expect(/^[\x00-\x7f]*$/.test(src), name).toBe(true);
      if (name === "runRawScript") continue; // D2: deliberately not built on wrapAe
      expect(src.startsWith(prelude), name).toBe(true);
      expect(src.endsWith(suffix), name).toBe(true);
    }
  });

  it("says which names exist when an effect, parameter or footage lookup fails (AE-16)", () => {
    expect(SAMPLES["effect"]).toContain('throw new Error("Effect not available: " + __q("ADBE Gaussian Blur 2")');
    expect(SAMPLES["effectParam"]).toContain("effects on this layer: ");
    expect(SAMPLES["effectParam"]).toContain("parameters: ");
    // The footage item is looked up (and a bad id reported) before the undo group opens.
    const footage = SAMPLES["footage"]!;
    expect(footage).toContain("app.project.itemByID(7)");
    expect(footage.indexOf("app.project.itemByID(7)")).toBeLessThan(footage.indexOf('__undo("Add layer"'));
    const body = (s: string) => s.slice(wrapAe("").length - "\n})()".length);
    expect(body(SAMPLES["solid"]!)).not.toContain("itemByID");
    expect(body(addLayerScript({ compId: 12, kind: "footage" }))).not.toContain("itemByID");
  });

  it("converts hex colors to 0–1 RGB arrays", () => {
    expect(SAMPLES["solid"]).toContain("addSolid([1, 0.5333333333333333, 0]");
    expect(SAMPLES["setText"]).toContain("v = [0.9607843137254902, 0.6509803921568628, 0.13725490196078433]; if (v !== null) { td.applyFill = true; td.fillColor = v; }");
  });

  it("applies easy ease only on keys that ask for it", () => {
    expect(SAMPLES["keys"]).toContain("{ t: 0, v: [0, 0], e: false }");
    expect(SAMPLES["keys"]).toContain("{ t: 1, v: [100, 100], e: true }");
    expect(SAMPLES["keys"]).toContain("setTemporalEaseAtKey");
  });

  it("adds layer styles via the stable Layer Styles menu command and matchName lookup", () => {
    // addProperty does not work for layer styles — the fixed menu id runs first,
    // the localized label is only a retry, and groups are found by "<key>/enabled".
    expect(SAMPLES["addStyle"]).toContain("app.executeCommand(9000)");
    expect(SAMPLES["addStyle"]).toContain('findMenuCommandId("Drop Shadow")');
    expect(SAMPLES["addStyle"]).toContain('__styleGroup(g, "dropShadow")');
    expect(SAMPLES["addStyleMapped"]).toContain("app.executeCommand(9008)");
    expect(SAMPLES["addStyleMapped"]).toContain('__styleGroup(g, "frameFX")');
    // satin maps to chromeFX; "remove" turns the style off rather than deleting it.
    expect(SAMPLES["removeStyle"]).toContain('__styleGroup(g, "chromeFX")');
    expect(SAMPLES["removeStyle"]).toContain("s.enabled = false");
    // Hex colors become [r, g, b, 1] arrays for setValue.
    expect(SAMPLES["styleParamColor"]).toContain("q.setValue([1, 0.5333333333333333, 0, 1])");
  });

  it("centers the text anchor on the text bounds by default", () => {
    expect(SAMPLES["setText"]).toContain("__centerAnchor(l);");
    expect(SAMPLES["text"]).toContain("__centerAnchor(l);");
  });

  it("puts the text anchor at the origin when asked, so position is the left baseline", () => {
    // Lower thirds place text by its left baseline; a centred anchor shoves the
    // text half its width to the left.
    for (const name of ["textOrigin", "setTextOrigin"]) {
      expect(SAMPLES[name], name).not.toContain("__centerAnchor(l);");
      expect(SAMPLES[name], name).toContain('property("ADBE Anchor Point").setValue([0, 0])');
    }
  });

  it("names a freshly applied effect when a name is given", () => {
    // Essential Graphics shows a slider under its effect name, so "Speed" must be settable here.
    expect(SAMPLES["effectNamed"]).toContain('e.name = "Speed";');
    expect(SAMPLES["effect"]).not.toContain("e.name =");
  });

  it("sets comp duration and frame rate on import and trims layers to the new duration", () => {
    // A PSD comp comes in at the project default length (hundreds of seconds).
    expect(SAMPLES["importPsdTimed"]).toContain("item.frameRate = 29.97;");
    expect(SAMPLES["importPsdTimed"]).toContain("item.duration = 8;");
    expect(SAMPLES["importPsdTimed"]).toContain("__trimLayers(item, 8)");
    expect(SAMPLES["importPsdComp"]).not.toContain("item.duration =");
  });

  it("sets comp properties and trims layers when the duration shrinks", () => {
    expect(SAMPLES["compProps"]).toContain('c.name = "LT";');
    expect(SAMPLES["compProps"]).toContain("c.frameRate = 29.97;");
    expect(SAMPLES["compProps"]).toContain("c.width = 1920;");
    expect(SAMPLES["compProps"]).toContain("c.height = 1080;");
    expect(SAMPLES["compProps"]).toContain("c.duration = 8;");
    expect(SAMPLES["compProps"]).toContain("__trimLayers(c, 8)");
    expect(SAMPLES["compDurationOnly"]).not.toContain("c.name =");
    expect(SAMPLES["compDurationOnly"]).toContain("__undo(");
  });

  it("retries the layer-style menu command with a pause, reselecting the layer each time", () => {
    // Seen live: the command did not take when other scripts were queued behind it.
    expect(SAMPLES["addStyle"]).toContain("for (var attempt = 0; attempt < 3 && !added; attempt++)");
    expect(SAMPLES["addStyle"]).toContain("$.sleep(150)");
  });

  it("builds shape layers through the vector group tree", () => {
    expect(SAMPLES["shapeRect"]).toContain('addShape()');
    expect(SAMPLES["shapeRect"]).toContain('l.property("ADBE Root Vectors Group")');
    expect(SAMPLES["shapeRect"]).toContain('addProperty("ADBE Vector Shape - Rect")');
    expect(SAMPLES["shapeRect"]).toContain('addProperty("ADBE Vector Graphic - Fill")');
    expect(SAMPLES["shapeRect"]).toContain('addProperty("ADBE Vector Graphic - Stroke")');
    // star uses the polystar shape; a null fill adds no fill.
    expect(SAMPLES["shapeStar"]).toContain('addProperty("ADBE Vector Shape - Star")');
    expect(SAMPLES["shapeStar"]).not.toContain("ADBE Vector Graphic - Fill");
  });

  it("adds masks as closed Shapes with the right mode", () => {
    expect(SAMPLES["maskRect"]).toContain('parade.addProperty("ADBE Mask Atom")');
    expect(SAMPLES["maskRect"]).toContain("s.vertices = [[L, T], [R, T], [R, B], [L, B]]");
    expect(SAMPLES["maskRect"]).toContain("mask.maskMode = MaskMode.ADD");
    // ellipse gets bezier handles; subtract maps to the SUBTRACT enum; default bounds are the comp.
    expect(SAMPLES["maskEllipse"]).toContain("0.5522847498");
    expect(SAMPLES["maskEllipse"]).toContain("mask.maskMode = MaskMode.SUBTRACT");
    expect(SAMPLES["maskEllipse"]).toContain("R = c.width");
  });

  it("imports PSD/AI as a composition with the right import kind", () => {
    expect(SAMPLES["importPsdComp"]).toContain("io.importAs = ImportAsType.COMP;");
    expect(SAMPLES["importPsdComp"]).toContain("canImportAs(ImportAsType.COMP)");
    expect(SAMPLES["importAiCropped"]).toContain("ImportAsType.COMP_CROPPED_LAYERS");
    // Rejects a flat/single-layer import instead of silently returning footage.
    expect(SAMPLES["importPsdComp"]).toContain("instanceof CompItem");
  });

  it("wires Essential Graphics add + Motion Graphics template export", () => {
    expect(SAMPLES["egpTransform"]).toContain("canAddToMotionGraphicsTemplate(c)");
    expect(SAMPLES["egpTransform"]).toContain("addToMotionGraphicsTemplate(c)");
    expect(SAMPLES["egpText"]).toContain('["ADBE Text Properties", "ADBE Text Document"]');
    expect(SAMPLES["exportMogrt"]).toContain("exportAsMotionGraphicsTemplate(true");
    expect(SAMPLES["exportMogrt"]).toContain('motionGraphicsTemplateName = "Fancy Lower Third"');
    expect(SAMPLES["exportMogrt"]).toContain('"Fancy Lower Third" + ".mogrt"');
    // Export saves the project first; a project with no file errors instead of hanging on a prompt.
    expect(SAMPLES["exportMogrt"]).toContain("app.project.save()");
  });

  it("rolls an expression back to the previous one when it fails to compile", () => {
    expect(SAMPLES["expr"]).toContain("var prev = prop.expression;");
    expect(SAMPLES["expr"]).toContain("prop.expression = prev;");
    expect(SAMPLES["expr"]).toContain("if (prop.expressionError)");
  });

  it("renders a frame through a temporary downscaled comp that is removed", () => {
    expect(SAMPLES["frame"]).toContain('addComp("__acm_preview"');
    expect(SAMPLES["frame"]).toContain("saveFrameToPng(1.5");
    expect(SAMPLES["frame"]).toContain("tmp.remove();");
  });
});

describe("ae_run_script's builder and args encoder (AE-01)", () => {
  const TAKES = "args takes JSON data only: strings, finite numbers, booleans, null, arrays and plain objects";
  /** n arrays, nested: nest(1) is [], nest(2) is [[]]. */
  const nest = (n: number): unknown => {
    let v: unknown = [];
    for (let i = 1; i < n; i++) v = [v];
    return v;
  };
  const refusalOf = (v: Record<string, unknown>): string => {
    const r = aeArgsLiteral(v);
    if (!("refusal" in r)) throw new Error(`expected a refusal, got ${r.literal}`);
    return r.refusal;
  };

  it("opens the undo group around the X-01 wrapper, which it embeds verbatim", () => {
    const script = 'var s = "say \\"hi\\" " + __args.n;\n__log(s);\ns';
    const src = SAMPLES["runRawScript"]!;
    const call = `return __undo(${asciiLiteral(`Schritt "${U_UML}"`)}, function () {`;
    expect(call).toBe('return __undo("Schritt \\"\\u00fc\\"", function () {');
    expect(src).toContain(call);
    expect(src.indexOf(call)).toBeLessThan(src.indexOf("var __src"));
    expect(src).toContain(rawScriptWrapper(script));
    // __args is declared in the outer IIFE, before the wrapper (never inside __src, which would shift bodyLine).
    expect(src.indexOf("var __args = ")).toBeLessThan(src.indexOf("var __src"));
    expect(src.startsWith("(function () {\n  var __args = {")).toBe(true);
    expect(src.endsWith("\n})()")).toBe(true);
  });

  it("does not scan the user's script: only the builder's own text must be ES3", () => {
    const es6 = "const f = (x) => `${x}`";
    const built = runRawScript(es6, { args: "{}", undoGroupName: "x", suppressDialogs: true });
    expect(es3Violations(built)).toEqual(["arrow function", "const", "template literal"]);
    expect(es3Violations(built.replace(asciiLiteral(es6), '""'))).toEqual([]);
    expect(es5Calls(built.replace(asciiLiteral(es6), '""'))).toEqual([]);
  });

  it("suppresses dialogs only when asked", () => {
    const on = runRawScript("1", { args: "{}", undoGroupName: "x", suppressDialogs: true });
    expect(on).toContain("app.beginSuppressDialogs();");
    expect(on).toContain("app.endSuppressDialogs(false);");
    const off = runRawScript("1", { args: "{}", undoGroupName: "x", suppressDialogs: false });
    expect(off).not.toContain("SuppressDialogs");
    expect(off).toContain('return __undo("x", function () {');
  });

  it("encodes args as one pure-ASCII ES3 object literal, every key quoted", () => {
    expect(litOf({})).toBe("{}");
    expect(litOf({ a: [1, -0, 1e21, 5e-324, -5, true, false, null] })).toBe('{"a":[1,-0,1e+21,5e-324,-5,true,false,null]}');
    // The literal carries every digit a double needs (R7). After Effects itself keeps less: it reads a number below
    // about 2.2e-308 as 0 and returns numbers with 15 significant digits (AE-01 live probe 11; the args text says so).
    expect(litOf({ x: 0.1 + 0.2, y: 1 / 3 })).toBe('{"x":0.30000000000000004,"y":0.3333333333333333}');
    expect(litOf({ default: 1, "": 2, constructor: 3 })).toBe('{"default":1,"":2,"constructor":3}');
    expect(litOf({ s: E_ACUTE })).toBe('{"s":"\\u00e9"}');
    expect(litOf({ s: `q"\\${LS}` })).toBe('{"s":"q\\"\\\\\\u2028"}');
    expect(litOf({ s: "\uD800" })).toBe('{"s":"\\ud800"}'); // a lone surrogate, as an ES3 escape
    const bare = Object.create(null) as Record<string, unknown>;
    bare["k"] = { "a-b": [] };
    expect(litOf({ o: bare })).toBe('{"o":{"k":{"a-b":[]}}}');
    expect(/^[\x20-\x7e]*$/.test(litOf({ s: `x${LS}${E_ACUTE}${U_UML}\n` }))).toBe(true);
  });

  it("refuses what ExtendScript cannot receive as data, naming the path and the next step", () => {
    expect(refusalOf(JSON.parse('{"a":{"b":1e999}}') as Record<string, unknown>)).toBe(
      `args.a.b is not a finite number (Infinity) — ${TAKES}; send a finite number, or a string the script converts.`,
    );
    expect(refusalOf({ n: [NaN] })).toBe(`args.n[0] is not a finite number (NaN) — ${TAKES}; send a finite number, or a string the script converts.`);
    expect(refusalOf(JSON.parse('{"o":{"__proto__":1}}') as Record<string, unknown>)).toBe(
      'args.o has a key named "__proto__" — rename that key; a script engine would not keep it as data.',
    );
    expect(refusalOf({ a: [1, , 3] })).toBe(`args.a[1] is a hole in a sparse array — ${TAKES}.`);
    expect(refusalOf({ f: () => 1 })).toBe(`args.f is a function — ${TAKES}.`);
    expect(refusalOf({ b: 1n })).toBe(`args.b is a bigint — ${TAKES}.`);
    expect(refusalOf({ "two words": { d: new Date(0) } })).toBe(`args["two words"].d is not a plain object — ${TAKES}.`);
    // Every refusal ends with its own " — <next step>".
    expect(RUN_SCRIPT_MANAGED_REFUSAL).toContain(" — ");
  });

  it("cuts a refusal's key path at 200 characters, keeping its next step (K2c)", () => {
    const key = "k".repeat(300);
    const path = `args.${key}`.slice(0, 200);
    expect(refusalOf({ [key]: Infinity })).toBe(
      `${path}... is not a finite number (Infinity) — ${TAKES}; send a finite number, or a string the script converts.`,
    );
    // A path of exactly 200 characters is not cut; one more and it is.
    const fits = "k".repeat(195);
    expect(refusalOf({ [fits]: NaN })).toBe(`args.${fits} is not a finite number (NaN) — ${TAKES}; send a finite number, or a string the script converts.`);
    expect(refusalOf({ [`${fits}k`]: NaN }).startsWith(`args.${fits}... is not a finite number`)).toBe(true);
  });

  it("refuses args nested more than 32 levels at level 32, however deep, without overflowing", () => {
    expect(litOf({ d: nest(31) })).toBe(`{"d":${"[".repeat(31)}${"]".repeat(31)}}`);
    expect(refusalOf({ d: nest(32) })).toBe(`args.d${"[0]".repeat(31)} is nested more than 32 levels deep — flatten args.`);
    const deep = JSON.parse(`{"a":${"[".repeat(10_000)}${"]".repeat(10_000)}}`) as Record<string, unknown>;
    expect(() => aeArgsLiteral(deep)).not.toThrow();
    expect(refusalOf(deep)).toBe(`args.a${"[0]".repeat(31)} is nested more than 32 levels deep — flatten args.`);
  });
});

describe("AE-03: name addressing, ae_find_layers, ae_batch, ae_undo / ae_redo (builders)", () => {
  const SUFFIX = "\n})()";
  const PRELUDE = wrapAe("").slice(0, -SUFFIX.length);
  const bodyOf = (src: string): string => (src.startsWith(PRELUDE) && src.endsWith(SUFFIX) ? src.slice(PRELUDE.length, -SUFFIX.length) : src);
  /** What follows the prelude: the prelude itself defines __undo with app.beginUndoGroup inside it. */
  const afterPrelude = (src: string): string => src.slice(PRELUDE.length);
  const count = (s: string, needle: string): number => s.split(needle).length - 1;

  it("keeps every numeric-ref sample body byte-identical to b2f9060 (AT7)", () => {
    // Captured from b2f9060 before any AE-03 change: each SAMPLES script minus the prelude and suffix.
    const fixture = JSON.parse(readFileSync(new URL("./ae-sample-bodies.b2f9060.json", import.meta.url), "utf8")) as Record<string, string>;
    // The named exceptions: ae_add_marker resolves its layer before the undo group and adds layerName
    // (spec 11.5); ae_queue_render's lookup by name refuses a repeated name (11.4; a name ref, not numeric).
    const changed = new Set(["marker", "layerMarker", "queueRender"]);
    expect(Object.keys(fixture).length).toBeGreaterThan(55);
    for (const [name, body] of Object.entries(fixture)) {
      expect(SAMPLES[name], `${name} is still sampled`).toBeDefined();
      if (changed.has(name)) expect(bodyOf(SAMPLES[name]!), name).not.toBe(body);
      else expect(bodyOf(SAMPLES[name]!), name).toBe(body);
    }
  });

  it("builds every batchable tool's script as wrap(body), each body starting with a newline", () => {
    const pairs: [string, string, string][] = [
      ["createComp", createCompScript({ name: "C", width: 10, height: 10, frameRate: 30, duration: 10, pixelAspect: 1 }), createCompBody({ name: "C", width: 10, height: 10, frameRate: 30, duration: 10, pixelAspect: 1 })],
      ["setCompProps", setCompPropsScript("Main", { duration: 5 }), setCompPropsBody("Main", { duration: 5 })],
      ["addLayer", addLayerScript({ compId: "Main", kind: "footage", itemId: 7 }), addLayerBody({ compId: "Main", kind: "footage", itemId: 7 })],
      ["addShape", addShapeScript({ compId: 12, kind: "ellipse" }), addShapeBody({ compId: 12, kind: "ellipse" })],
      ["addMask", addMaskScript({ compId: 12, layerIndex: "BG", kind: "rectangle" }), addMaskBody({ compId: 12, layerIndex: "BG", kind: "rectangle" })],
      ["setLayerProps", setLayerPropsScript(12, "B", { opacity: 50, parentIndex: "A" }), setLayerPropsBody(12, "B", { opacity: 50, parentIndex: "A" })],
      ["duplicateLayer", duplicateLayerScript(12, "B", "c"), duplicateLayerBody(12, "B", "c")],
      ["deleteLayer", deleteLayerScript(12, 2), deleteLayerBody(12, 2)],
      ["setKeyframes", setKeyframesScript({ compId: 12, layerIndex: "B", property: "opacity", keys: [{ time: 0, value: 0 }] }), setKeyframesBody({ compId: 12, layerIndex: "B", property: "opacity", keys: [{ time: 0, value: 0 }] })],
      ["removeKeyframes", removeKeyframesScript(12, "B", "opacity", undefined), removeKeyframesBody(12, "B", "opacity", undefined)],
      ["setExpression", setExpressionScript(12, "B", "opacity", undefined, "50"), setExpressionBody(12, "B", "opacity", undefined, "50")],
      ["applyEffect", applyEffectScript(12, "B", "ADBE Tint"), applyEffectBody(12, "B", "ADBE Tint")],
      ["setEffectParam", setEffectParamScript(12, "B", 1, "Amount", 5), setEffectParamBody(12, "B", 1, "Amount", 5)],
      ["setLayerStyleParam", setLayerStyleParamScript(12, "B", "dropShadow", "Size", 5), setLayerStyleParamBody(12, "B", "dropShadow", "Size", 5)],
      ["removeLayerStyle", removeLayerStyleScript(12, "B", "satin"), removeLayerStyleBody(12, "B", "satin")],
      ["addToEssentialGraphics", addToEssentialGraphicsScript(12, "B", "position", undefined), addToEssentialGraphicsBody(12, "B", "position", undefined)],
      ["setText", setTextScript({ compId: 12, layerIndex: "Title", text: "x" }), setTextBody({ compId: 12, layerIndex: "Title", text: "x" })],
      ["addMarker", addMarkerScript(12, 1, "m", "B", undefined), addMarkerBody(12, 1, "m", "B", undefined)],
      ["queueRender", queueRenderScript("Main", "C:/r.mov", undefined), queueRenderBody("Main", "C:/r.mov", undefined)],
    ];
    expect(pairs).toHaveLength(AE_BATCH_TOOLS.length);
    for (const [name, script, body] of pairs) {
      expect(script, name).toBe(wrapAe(body));
      expect(body.startsWith("\n"), name).toBe(true);
      expect(es3Violations(body), name).toEqual([]);
      expect(es5Calls(body), name).toEqual([]);
    }
  });

  it("emits a number ref with num() and a name ref as an escaped literal, in every helper call", () => {
    // Numbers are byte-identical (the pins above); names are lit() strings, quotes and U+2028 escaped.
    expect(SAMPLES["propsByName"]).toContain('var c = __comp("Say \\"hi\\""); var l = __layer(c, "Say \\"hi\\"");');
    expect(SAMPLES["propsByName"]).toContain('var parentLayer = __layer(c, "Parent", "Parent");');
    expect(SAMPLES["getCompByName"]).toContain('var c = __comp("Main");');
    expect(SAMPLES["getLayerByName"]).toContain('var c = __comp("Main"); var l = __layer(c, "Title");');
    expect(getLayerScript(`a${LS}b`, `c${LS}d`)).toContain('__comp("a\\u2028b"); var l = __layer(c, "c\\u2028d");');
    expect(SAMPLES["findLayersFiltered"]).toContain('__comp("Say \\"hi\\"")');
    expect(SAMPLES["findLayersFiltered"]).toContain('"a\\"b"');
    // nameOnly (true): ae_render_comp takes no compId, so __compNamed's next steps offer none.
    expect(SAMPLES["compByName"]).toContain('__compNamed("Say \\"hi\\"", true)');
  });

  it("checks a self-parent by name on the host, before the undo group (spec 11.2)", () => {
    const named = SAMPLES["propsByName"]!;
    expect(named).toContain("if (parentLayer.index === l.index) { throw new Error(");
    expect(named.indexOf("parentLayer.index === l.index")).toBeLessThan(named.indexOf('__undo("Set layer properties"'));
    // Numeric refs keep b2f9060's body: the server refuses a numeric self-parent before dispatch instead.
    expect(SAMPLES["props"]).not.toContain("parentLayer.index === l.index");
  });

  it("ae_add_marker resolves its layer before the undo group and returns layerName (spec 11.5)", () => {
    const m = SAMPLES["layerMarker"]!;
    expect(m).toContain("var tl = __layer(c, 3);");
    expect(m.indexOf("var tl = __layer(c, 3);")).toBeLessThan(m.indexOf('__undo("Add marker"'));
    expect(m).toContain('on: tl === null ? "comp" : "layer " + tl.index');
    expect(m).toContain("r.layerName = tl.name;");
    expect(SAMPLES["marker"]).toContain("var tl = null;");
    expect(SAMPLES["markerByName"]).toContain('var tl = __layer(c, "Title");');
  });

  it("ae_queue_render refuses a repeated composition name through __compNamed, after its own miss message (spec 11.4)", () => {
    const q = afterPrelude(SAMPLES["queueRender"]!);
    expect(q).toContain('target = __compNamed("Main", true);');
    expect(q.indexOf('compositions: " + __list(')).toBeLessThan(q.indexOf("__compNamed("));
  });

  it("ae_find_layers filters by kind, name, text and enabled, all through lit()", () => {
    const f = SAMPLES["findLayersFiltered"]!;
    expect(f).toContain('var nq = "a\\"b", kq = "text", tq = "Hello", eq = true;');
    expect(f).toContain("k = __kind(l);");
    expect(f).toContain('l.property("ADBE Text Properties").property("ADBE Text Document").value.text');
    expect(SAMPLES["findLayers"]).toContain("var nq = null, kq = null, tq = null, eq = null;");
    expect(afterPrelude(SAMPLES["findLayers"]!)).not.toContain("__undo(");
  });

  it("ae_undo / ae_redo run Edit > Undo (16) / Redo (2035) by fixed id, never the label lookup (spec 11.1)", () => {
    expect(AE_UNDO_COMMAND).toBe(16);
    expect(AE_REDO_COMMAND).toBe(2035);
    expect(afterPrelude(SAMPLES["undo"]!)).toContain("app.executeCommand(16);");
    expect(afterPrelude(SAMPLES["undo"]!)).toContain('return { command: "Undo", menuId: 16 };');
    expect(afterPrelude(SAMPLES["redo"]!)).toContain("app.executeCommand(2035);");
    expect(afterPrelude(SAMPLES["redo"]!)).toContain('return { command: "Redo", menuId: 2035 };');
    for (const s of [SAMPLES["undo"]!, SAMPLES["redo"]!]) {
      // findMenuCommandId("Undo") is Edit > Purge > Undo (2371): it would clear the history.
      expect(s).not.toContain("findMenuCommandId");
      expect(s).not.toContain("2371");
      expect(afterPrelude(s)).not.toContain("__undo(");
      expect(afterPrelude(s)).not.toContain("UndoGroup");
    }
  });

  it("ae_batch opens exactly one undo group of its own and shims __undo; the sentinel and the rollback only when atomic", () => {
    for (const [name, atomic] of [["batchAtomic", true], ["batchLoose", false]] as const) {
      const frame = afterPrelude(SAMPLES[name]!);
      expect(count(frame, "app.beginUndoGroup("), name).toBe(1);
      expect(count(frame, "app.endUndoGroup()"), name).toBe(1);
      expect(frame, name).toContain("__undo = function (n, f) { __chg = true; return f(); };");
      expect(frame, name).toContain("__res[__res.length] = (function () {");
      expect(frame.includes('addFolder("__acm_batch")'), name).toBe(atomic);
      expect(frame.includes("app.executeCommand(16);"), name).toBe(atomic);
      expect(frame, name).not.toContain("findMenuCommandId");
    }
    const atomic = afterPrelude(SAMPLES["batchAtomic"]!);
    expect(atomic).toContain('app.beginUndoGroup("Batch \\"x\\"");');
    // The sentinel is created and removed inside the group, and never touched after it closes.
    const end = atomic.indexOf("app.endUndoGroup()");
    expect(atomic.indexOf('addFolder("__acm_batch")')).toBeLessThan(end);
    expect(atomic.indexOf(".remove();")).toBeLessThan(end);
    expect(atomic.slice(end)).not.toContain(".remove()");
    expect(atomic.indexOf("app.executeCommand(16);")).toBeGreaterThan(end);
  });

  it("records where each operation's body sits, from the assembled script itself (spec 11.2)", () => {
    const bodies = [
      createCompBody({ name: "Shot", width: 1920, height: 1080, frameRate: 30, duration: 10, pixelAspect: 1 }),
      addLayerBody({ compId: "Shot", kind: "text", text: "multi\nline" }),
      setLayerPropsBody("Shot", 1, { opacity: 50, name: `x${LS}y` }),
      deleteLayerBody("Shot", 1),
    ];
    for (const atomic of [true, false]) {
      const b = buildAeBatch(bodies.map((body, i) => ({ tool: `t${i}`, body })), atomic, "Batch");
      expect(b.script).toBe(aeBatchScript(bodies.map((body, i) => ({ tool: `t${i}`, body })), atomic, "Batch"));
      const lines = b.script.split(/\r\n|[\n\r\u2028\u2029]/);
      expect(b.segments).toHaveLength(bodies.length);
      b.segments.forEach((seg, i) => {
        const bodyLines = bodies[i]!.slice(1).split(/\r\n|[\n\r\u2028\u2029]/);
        expect(seg.tool).toBe(`t${i}`);
        expect(lines[seg.first - 1], `op ${i + 1} first`).toBe(bodyLines[0]);
        expect(lines[seg.last - 1], `op ${i + 1} last`).toBe(bodyLines[bodyLines.length - 1]);
        expect(seg.last - seg.first + 1).toBe(lineCount(bodies[i]!) - 1);
      });
      expect(es3Violations(b.script)).toEqual([]);
      expect(es5Calls(b.script)).toEqual([]);
      expect(/^[\x00-\x7f]*$/.test(b.script)).toBe(true);
    }
  });

  it("lists every After Effects tool as batchable or excluded with a reason, never both", () => {
    expect(AE_BATCH_TOOLS).toHaveLength(19);
    expect(Object.keys(AE_BATCH_OPS).sort()).toEqual([...AE_BATCH_TOOLS].sort());
    for (const t of AE_BATCH_TOOLS) expect(AE_BATCH_EXCLUDED[t], t).toBeUndefined();
    for (const t of ["ae_queue_render", "ae_add_to_essential_graphics"]) expect(AE_BATCH_TOOLS).toContain(t);
    for (const t of ["ae_add_layer_style", "ae_run_script", "ae_undo", "ae_redo", "ae_batch", "ae_find_layers", "ae_import_footage"]) {
      expect(AE_BATCH_EXCLUDED[t], t).toMatch(/\S/);
    }
  });
});

describe("aerender executable", () => {
  it("sits beside aerender.exe in Support Files on Windows", () => {
    expect(aerenderExecutable("C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files", true)).toMatch(/Support Files[\\/]aerender\.exe$/);
  });
  it("is next to the .app bundle on macOS (Folder.appPackage is the bundle itself)", () => {
    expect(aerenderExecutable("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app", false)).toBe("/Applications/Adobe After Effects 2026/aerender");
    expect(aerenderExecutable("/Applications/Adobe After Effects 2026", false)).toBe("/Applications/Adobe After Effects 2026/aerender");
  });
});
