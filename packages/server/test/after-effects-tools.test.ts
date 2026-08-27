import { describe, expect, it } from "vitest";

import {
  AERENDER_INFO,
  LIST_COMPOSITIONS,
  LIST_FOOTAGE,
  PROJECT_INFO,
  addLayerScript,
  addMarkerScript,
  applyEffectScript,
  createCompScript,
  deleteLayerScript,
  duplicateLayerScript,
  getCompScript,
  getKeyframesScript,
  getLayerScript,
  importFootageScript,
  openProjectScript,
  removeKeyframesScript,
  renderFrameScript,
  saveProjectScript,
  setEffectParamScript,
  setExpressionScript,
  setKeyframesScript,
  setLayerPropsScript,
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
};

describe("After Effects tool scripts", () => {
  it("are all ES3-clean", () => {
    for (const [name, src] of Object.entries(SAMPLES)) expect(es3Violations(src), name).toEqual([]);
  });

  it("wrap mutations in an undo group", () => {
    for (const name of ["createComp", "solid", "props", "dup", "del", "keys", "expr", "effect", "effectParam", "setText", "marker", "import"]) {
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
    expect(SAMPLES["props"]).toContain('property("ADBE Position").setValue([100, 200])');
    expect(SAMPLES["props"]).toContain("l.parent = __layer(c, 1);");
    expect(SAMPLES["unparent"]).toContain("l.parent = null;");
  });

  it("converts hex colors to 0–1 RGB arrays", () => {
    expect(SAMPLES["solid"]).toContain("addSolid([1, 0.5333333333333333, 0]");
    expect(SAMPLES["setText"]).toContain("td.fillColor = [0.9607843137254902, 0.6509803921568628, 0.13725490196078433]");
  });

  it("applies easy ease only on keys that ask for it", () => {
    expect(SAMPLES["keys"]).toContain("{ t: 0, v: [0, 0], e: false }");
    expect(SAMPLES["keys"]).toContain("{ t: 1, v: [100, 100], e: true }");
    expect(SAMPLES["keys"]).toContain("setTemporalEaseAtKey");
  });

  it("renders a frame through a temporary downscaled comp that is removed", () => {
    expect(SAMPLES["frame"]).toContain('addComp("__acm_preview"');
    expect(SAMPLES["frame"]).toContain("saveFrameToPng(1.5");
    expect(SAMPLES["frame"]).toContain("tmp.remove();");
  });
});
