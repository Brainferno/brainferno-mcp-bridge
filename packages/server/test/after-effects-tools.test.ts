import { describe, expect, it } from "vitest";

import * as AE from "../src/tools/after-effects.js";
import {
  AERENDER_INFO,
  aerenderExecutable,
  LIST_COMPOSITIONS,
  LIST_FOOTAGE,
  PROJECT_INFO,
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
} from "../src/tools/after-effects.js";
import { es3Violations } from "./es3.js";

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
  removeStyle: removeLayerStyleScript(12, 2, "satin"),
  egpTransform: addToEssentialGraphicsScript(12, 1, "position", undefined),
  egpText: addToEssentialGraphicsScript(12, 1, "position", ["ADBE Text Properties", "ADBE Text Document"]),
  exportMogrt: exportMogrtScript(12, "C:/mogrts", "Fancy Lower Third", true),
  effectNamed: applyEffectScript(12, 2, "ADBE Slider Control", "Speed"),
  importPsdTimed: importAsCompScript("C:/p/art.psd", false, { duration: 8, frameRate: 29.97 }),
  compProps: setCompPropsScript(12, { name: "LT", duration: 8, frameRate: 29.97, width: 1920, height: 1080 }),
  compDurationOnly: setCompPropsScript(12, { duration: 5 }),
  textOrigin: addLayerScript({ compId: 12, kind: "text", text: "Hi", anchor: "origin" }),
  setTextOrigin: setTextScript({ compId: 12, layerIndex: 1, justification: "left", anchor: "origin" }),
  queueRender: queueRenderScript("Main", "C:/renders/main.mov", "H.264 - Match Render Settings"),
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
  "aerenderExecutable", // pure path helper, not a script
]);
const READ_ONLY_CONSTS = new Set(["LIST_COMPOSITIONS", "LIST_FOOTAGE", "PROJECT_INFO", "AERENDER_INFO"]);

// Mutating builders that MUST wrap their change in __undo (one tool call = one Ctrl-Z).
const MUST_UNDO = new Set([
  "addLayerScript", "setLayerPropsScript", "duplicateLayerScript", "deleteLayerScript",
  "setKeyframesScript", "removeKeyframesScript", "setExpressionScript", "applyEffectScript",
  "setEffectParamScript", "setTextScript", "addMarkerScript", "importFootageScript",
  "importAsCompScript", "createCompScript", "addLayerStyleScript", "setLayerStyleParamScript",
  "removeLayerStyleScript", "addToEssentialGraphicsScript", "addShapeScript", "addMaskScript",
  "setCompPropsScript", "queueRenderScript",
]);
// Builders that change state but legitimately do not use __undo: app-level ops
// (open/save), a self-cleaning preview render, and the Essential Graphics export
// (it saves the project and suppresses dialogs). Each is here on purpose.
const NO_UNDO_OK = new Set(["openProjectScript", "saveProjectScript", "renderFrameScript", "exportMogrtScript"]);

describe("After Effects tool scripts", () => {
  it("are all ES3-clean", () => {
    for (const [name, src] of Object.entries(SAMPLES)) expect(es3Violations(src), name).toEqual([]);
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
    };
    for (const name of MUST_UNDO) {
      const build = calls[name];
      expect(build, `add a sample call for ${name}`).toBeDefined();
      expect(build!(), name).toContain("__undo(");
    }
  });

  it("escape strings as JS literals", () => {
    expect(SAMPLES["text"]).toContain('addText("Say \\"hi\\"")');
    expect(SAMPLES["setText"]).toContain('"Hello\\nWorld"');
    expect(setLayerPropsScript(1, 1, { name: "a\u2028b" })).toContain('"a\\u2028b"');
  });

  it("uses match names for transform properties and honors propertyPath", () => {
    expect(SAMPLES["keys"]).toContain('__prop(l, "position", null)');
    expect(SAMPLES["keysPath"]).toContain('["ADBE Effect Parade", "Gaussian Blur", "Blurriness"]');
    expect(SAMPLES["props"]).toContain('v = [100, 200]; if (v !== null) { t.property("ADBE Position").setValue(v); }');
    expect(SAMPLES["props"]).toContain("l.parent = __layer(c, 1);");
    expect(SAMPLES["unparent"]).toContain("l.parent = null;");
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

describe("aerender executable", () => {
  it("sits beside aerender.exe in Support Files on Windows", () => {
    expect(aerenderExecutable("C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files", true)).toMatch(/Support Files[\\/]aerender\.exe$/);
  });
  it("is next to the .app bundle on macOS (Folder.appPackage is the bundle itself)", () => {
    expect(aerenderExecutable("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app", false)).toBe("/Applications/Adobe After Effects 2026/aerender");
    expect(aerenderExecutable("/Applications/Adobe After Effects 2026", false)).toBe("/Applications/Adobe After Effects 2026/aerender");
  });
});
