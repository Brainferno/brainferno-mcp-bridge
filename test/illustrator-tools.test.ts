import { describe, expect, it } from "vitest";

import {
  createDocumentScript,
  createShapeScript,
  createTextScript,
  exportArtboardScript,
  previewScript,
  saveDocumentScript,
} from "../src/tools/illustrator.js";
import { es3Violations } from "./osscript.test.js";

const SAMPLES: Record<string, string> = {
  createDocument: createDocumentScript(1080, 1080, "rgb"),
  createDocumentCmyk: createDocumentScript(595, 842, "cmyk"),
  rect: createShapeScript({ kind: "rect", x: 10, y: 20, width: 100, height: 50, fill: "#ff8800", cornerRadius: 8 }),
  ellipse: createShapeScript({ kind: "ellipse", x: 0, y: 0, width: 10, height: 10, stroke: "#000000", strokeWidth: 2 }),
  line: createShapeScript({ kind: "line", x: 0, y: 0, width: 100, height: 100 }),
  polygon: createShapeScript({ kind: "polygon", x: 0, y: 0, width: 100, height: 100, sides: 8 }),
  star: createShapeScript({ kind: "star", x: 0, y: 0, width: 100, height: 100, points: 6, innerRadiusRatio: 0.4 }),
  text: createTextScript({ text: 'Say "hi"\nnow', x: 5, y: 5, fontSize: 24, font: "ArialMT", fill: "#123456" }),
  areaText: createTextScript({ text: "wrap me", x: 0, y: 0, width: 200, height: 100 }),
  saveInPlace: saveDocumentScript(undefined),
  saveAs: saveDocumentScript("C:/out/logo.ai"),
  exportPng: exportArtboardScript("png", "C:/out/a.png", 200),
  exportSvg: exportArtboardScript("svg", "C:/out/a.svg", 100),
  preview: previewScript("C:/tmp/p.png", 1024),
};

describe("Illustrator tool scripts", () => {
  it("are all ES3-clean (no arrows, const/let, template literals, or JSON global)", () => {
    for (const [name, src] of Object.entries(SAMPLES)) {
      expect(es3Violations(src), name).toEqual([]);
    }
  });

  it("use the right Illustrator API per shape kind", () => {
    expect(SAMPLES["rect"]).toContain("roundedRectangle(top, left, w, h, cr, cr)");
    expect(SAMPLES["ellipse"]).toContain("pathItems.ellipse(top, left, w, h)");
    expect(SAMPLES["line"]).toContain("setEntirePath");
    expect(SAMPLES["polygon"]).toContain("pathItems.polygon(cx, cy, radius, 8)");
    expect(SAMPLES["star"]).toContain("pathItems.star(cx, cy, radius, radius * 0.4, 6)");
  });

  it("converts artboard-relative coordinates to Illustrator's y-up space", () => {
    expect(SAMPLES["rect"]).toContain("var left = ab.left + x, top = ab.top - y;");
    expect(SAMPLES["text"]).toContain("var left = ab.left + 5, top = ab.top - 5;");
  });

  it("escapes user strings as JS literals (quotes, newlines)", () => {
    expect(SAMPLES["text"]).toContain('t.contents = "Say \\"hi\\"\\nnow";');
  });

  it("escapes U+2028 in names so ES3 does not see a line terminator", () => {
    const src = createShapeScript({ kind: "rect", x: 0, y: 0, width: 1, height: 1, name: "a\u2028b" });
    expect(src).toContain('"a\\u2028b"');
    expect(src).not.toContain("\u2028");
  });

  it("picks the export options by format", () => {
    expect(SAMPLES["exportPng"]).toContain("ExportType.PNG24");
    expect(SAMPLES["exportPng"]).toContain("var scale = 200;");
    expect(SAMPLES["exportSvg"]).toContain("ExportType.SVG");
  });

  it("area text is used only when both width and height are given", () => {
    expect(SAMPLES["areaText"]).toContain("textFrames.areaText");
    expect(SAMPLES["text"]).toContain("t.position = [left, top];");
  });

  it("save without a path refuses on a never-saved document", () => {
    expect(SAMPLES["saveInPlace"]).toContain("has never been saved");
    expect(SAMPLES["saveAs"]).toContain('var path = "C:/out/logo.ai";');
  });
});
