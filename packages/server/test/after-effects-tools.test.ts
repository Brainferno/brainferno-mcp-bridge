import { describe, expect, it } from "vitest";

import {
  AERENDER_INFO,
  aerenderExecutable,
  LIST_COMPOSITIONS,
  LIST_FOOTAGE,
  PROJECT_INFO,
  addLayerScript,
  addLayerStyleScript,
  addMarkerScript,
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
import { es3Violations } from "./osscript.test.js";

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
};

describe("After Effects tool scripts", () => {
  it("are all ES3-clean", () => {
    for (const [name, src] of Object.entries(SAMPLES)) expect(es3Violations(src), name).toEqual([]);
  });

  it("wrap mutations in an undo group", () => {
    for (const name of ["createComp", "solid", "props", "dup", "del", "keys", "expr", "effect", "effectParam", "setText", "marker", "import", "addStyle", "styleParam", "removeStyle"]) {
      expect(SAMPLES[name], name).toContain("__undo(");
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
