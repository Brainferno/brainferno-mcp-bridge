import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsStringLiteral } from "../bridge/script-escape.js";
import type { AppBridge } from "../bridge/types.js";
import { guard, imageResult, jsonResult } from "./result.js";

/**
 * Illustrator has no public UXP — it is driven through ExtendScript (ES3) via
 * the os-script lane (COM on Windows, AppleScript on macOS): `var` only, no
 * arrow functions, no JSON global. Do not modernize these scripts.
 *
 * Coordinates: every x/y here is measured from the **top-left of the active
 * artboard, y going down** (like a web page). The helpers convert to
 * Illustrator's native y-up coordinates, so the same numbers work in RGB and
 * CMYK documents.
 *
 * This lane exists for what Adobe's built-in Illustrator MCP cannot do: draw
 * new shapes and text, and save `.ai` files. For arranging, restyling,
 * analyzing, and exporting existing art, the `ai_beta_*` delegate tools are
 * also available.
 */

/** ES3 helpers prepended to every script that touches a document. */
const HELPERS = `
function __doc() {
  if (app.documents.length === 0) { throw new Error("No document is open. Create or open one first (ai_create_document)."); }
  return app.activeDocument;
}
function __ab(d) {
  var ab = d.artboards[d.artboards.getActiveArtboardIndex()];
  var r = ab.artboardRect;
  return { left: r[0], top: r[1], right: r[2], bottom: r[3], width: r[2] - r[0], height: r[1] - r[3] };
}
function __rgb(hex) {
  var c = new RGBColor();
  c.red = parseInt(hex.substr(1, 2), 16);
  c.green = parseInt(hex.substr(3, 2), 16);
  c.blue = parseInt(hex.substr(5, 2), 16);
  return c;
}
function __style(item, fill, stroke, strokeWidth) {
  if (fill === null) { item.filled = false; } else { item.filled = true; item.fillColor = __rgb(fill); }
  if (stroke === null) { item.stroked = false; } else {
    item.stroked = true; item.strokeColor = __rgb(stroke);
    if (strokeWidth !== null) { item.strokeWidth = strokeWidth; }
  }
}
function __info(item) {
  var b = item.geometricBounds;
  return { name: item.name, type: item.typename, bounds: { left: b[0], top: b[1], right: b[2], bottom: b[3] } };
}
`;

const LIST_DOCUMENTS = `(function () {
  var out = [];
  for (var i = 0; i < app.documents.length; i++) {
    var doc = app.documents[i];
    var path = null;
    // fullName throws on a document that has never been saved.
    try { path = doc.fullName.fsName; } catch (e) { path = null; }
    out.push({
      name: doc.name,
      path: path,
      width: doc.width,
      height: doc.height,
      artboardCount: doc.artboards.length,
      colorSpace: String(doc.documentColorSpace)
    });
  }
  return out;
})()`;

const lit = jsStringLiteral;
const num = (n: number): string => String(n);
const opt = (v: string | undefined): string => (v === undefined ? "null" : lit(v));
const optNum = (v: number | undefined): string => (v === undefined ? "null" : num(v));

export function createDocumentScript(width: number, height: number, colorMode: "rgb" | "cmyk"): string {
  const space = colorMode === "cmyk" ? "DocumentColorSpace.CMYK" : "DocumentColorSpace.RGB";
  return `(function () {
  var d = app.documents.add(${space}, ${num(width)}, ${num(height)});
  return { name: d.name, width: d.width, height: d.height, colorSpace: String(d.documentColorSpace), artboardCount: d.artboards.length };
})()`;
}

export interface ShapeParams {
  kind: "rect" | "ellipse" | "line" | "polygon" | "star";
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number;
  sides?: number;
  points?: number;
  innerRadiusRatio?: number;
  name?: string;
}

export function createShapeScript(p: ShapeParams): string {
  return `(function () {${HELPERS}
  var d = __doc(); var ab = __ab(d);
  var x = ${num(p.x)}, y = ${num(p.y)}, w = ${num(p.width)}, h = ${num(p.height)};
  var left = ab.left + x, top = ab.top - y;
  var cx = left + w / 2, cy = top - h / 2, radius = Math.min(w, h) / 2;
  var kind = ${lit(p.kind)}, item;
  if (kind === "rect") {
    var cr = ${optNum(p.cornerRadius)};
    item = cr !== null && cr > 0 ? d.pathItems.roundedRectangle(top, left, w, h, cr, cr) : d.pathItems.rectangle(top, left, w, h);
  } else if (kind === "ellipse") {
    item = d.pathItems.ellipse(top, left, w, h);
  } else if (kind === "polygon") {
    item = d.pathItems.polygon(cx, cy, radius, ${optNum(p.sides) === "null" ? "6" : num(p.sides as number)});
  } else if (kind === "star") {
    item = d.pathItems.star(cx, cy, radius, radius * ${num(p.innerRadiusRatio ?? 0.5)}, ${optNum(p.points) === "null" ? "5" : num(p.points as number)});
  } else {
    item = d.pathItems.add();
    item.setEntirePath([[left, top], [left + w, top - h]]);
  }
  __style(item, ${opt(p.fill)}, ${opt(p.stroke)}, ${optNum(p.strokeWidth)});
  var name = ${opt(p.name)};
  if (name !== null) { item.name = name; }
  return __info(item);
})()`;
}

export interface TextParams {
  text: string;
  x: number;
  y: number;
  fontSize?: number;
  font?: string;
  fill?: string;
  width?: number;
  height?: number;
  name?: string;
}

export function createTextScript(p: TextParams): string {
  return `(function () {${HELPERS}
  var d = __doc(); var ab = __ab(d);
  var left = ab.left + ${num(p.x)}, top = ab.top - ${num(p.y)};
  var w = ${optNum(p.width)}, h = ${optNum(p.height)};
  var t;
  if (w !== null && h !== null) {
    t = d.textFrames.areaText(d.pathItems.rectangle(top, left, w, h));
  } else {
    t = d.textFrames.add();
    t.position = [left, top];
  }
  t.contents = ${lit(p.text)};
  var ca = t.textRange.characterAttributes;
  var size = ${optNum(p.fontSize)};
  if (size !== null) { ca.size = size; }
  var fontName = ${opt(p.font)};
  if (fontName !== null) {
    try { ca.textFont = app.textFonts.getByName(fontName); }
    catch (e) { throw new Error("Font not found: " + fontName + ". Use the PostScript name, e.g. ArialMT, Arial-BoldMT, Helvetica-Bold."); }
  }
  var fill = ${opt(p.fill)};
  if (fill !== null) { ca.fillColor = __rgb(fill); }
  var name = ${opt(p.name)};
  if (name !== null) { t.name = name; }
  var info = __info(t); info.contents = t.contents; return info;
})()`;
}

export function saveDocumentScript(path: string | undefined): string {
  return `(function () {${HELPERS}
  var d = __doc();
  var path = ${opt(path)};
  if (path === null) {
    var known = null;
    try { known = d.fullName.fsName; } catch (e) { known = null; }
    if (known === null) { throw new Error("This document has never been saved — pass a path ending in .ai."); }
    d.save();
    return { path: known, saved: true };
  }
  var f = new File(path);
  d.saveAs(f, new IllustratorSaveOptions());
  return { path: f.fsName, saved: true };
})()`;
}

export type ExportFormat = "png" | "jpg" | "svg";

export function exportArtboardScript(format: ExportFormat, path: string, scalePercent: number): string {
  return `(function () {${HELPERS}
  var d = __doc();
  var f = new File(${lit(path)});
  var format = ${lit(format)};
  var scale = ${num(scalePercent)};
  if (format === "png") {
    var po = new ExportOptionsPNG24();
    po.artBoardClipping = true; po.antiAliasing = true; po.transparency = true;
    po.horizontalScale = scale; po.verticalScale = scale;
    d.exportFile(f, ExportType.PNG24, po);
  } else if (format === "jpg") {
    var jo = new ExportOptionsJPEG();
    jo.artBoardClipping = true; jo.antiAliasing = true; jo.qualitySetting = 85;
    jo.horizontalScale = scale; jo.verticalScale = scale;
    d.exportFile(f, ExportType.JPEG, jo);
  } else {
    var so = new ExportOptionsSVG();
    so.embedRasterImages = true;
    d.exportFile(f, ExportType.SVG, so);
  }
  return { path: f.fsName, format: format, scalePercent: scale };
})()`;
}

export function previewScript(path: string, maxDimension: number): string {
  return `(function () {${HELPERS}
  var d = __doc(); var ab = __ab(d);
  var longest = Math.max(ab.width, ab.height);
  var scale = longest > ${num(maxDimension)} ? (100 * ${num(maxDimension)}) / longest : 100;
  var f = new File(${lit(path)});
  var po = new ExportOptionsPNG24();
  po.artBoardClipping = true; po.antiAliasing = true; po.transparency = true;
  po.horizontalScale = scale; po.verticalScale = scale;
  d.exportFile(f, ExportType.PNG24, po);
  return { path: f.fsName, artboardWidth: ab.width, artboardHeight: ab.height, scalePercent: scale };
})()`;
}

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "hex color like #ff8800")
  .describe("Hex color like #ff8800.");
const coord = (what: string) => z.number().finite().describe(`${what}, in points from the active artboard's top-left (y goes down).`);
const size = (what: string) => z.number().finite().positive().describe(`${what} in points.`);

export function registerIllustratorTools(server: McpServer, bridge: AppBridge): void {
  server.registerTool(
    "ai_list_documents",
    {
      title: "Illustrator: list open documents",
      description: "List every open Illustrator document with its dimensions, artboard count, and color space.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(LIST_DOCUMENTS))),
  );

  server.registerTool(
    "ai_create_document",
    {
      title: "Illustrator: create a document",
      description:
        "Create a new Illustrator document with one artboard of the given size, and make it active. " +
        "Later ai_* drawing tools act on the active document's active artboard.",
      inputSchema: {
        width: size("Artboard width"),
        height: size("Artboard height"),
        colorMode: z.enum(["rgb", "cmyk"]).optional().describe("Document color mode. Defaults to rgb."),
      },
    },
    async ({ width, height, colorMode }) =>
      guard(async () => jsonResult(await bridge.evaluate(createDocumentScript(width, height, colorMode ?? "rgb")))),
  );

  server.registerTool(
    "ai_create_shape",
    {
      title: "Illustrator: draw a shape",
      description:
        "Draw a rectangle, ellipse, line, polygon, or star on the active artboard. x/y is the top-left of the " +
        "shape's bounding box; polygons and stars are inscribed in that box. Returns the new item's name and bounds.",
      inputSchema: {
        kind: z.enum(["rect", "ellipse", "line", "polygon", "star"]).describe("Shape type."),
        x: coord("Left edge"),
        y: coord("Top edge"),
        width: size("Width"),
        height: size("Height"),
        fill: hexColor.optional().describe("Fill color; omit for no fill."),
        stroke: hexColor.optional().describe("Stroke color; omit for no stroke."),
        strokeWidth: z.number().finite().positive().optional().describe("Stroke width in points."),
        cornerRadius: z.number().finite().nonnegative().optional().describe("rect only: corner radius in points."),
        sides: z.number().int().min(3).max(100).optional().describe("polygon only: number of sides. Defaults to 6."),
        points: z.number().int().min(3).max(100).optional().describe("star only: number of points. Defaults to 5."),
        innerRadiusRatio: z.number().gt(0).lt(1).optional().describe("star only: inner/outer radius. Defaults to 0.5."),
        name: z.string().min(1).optional().describe("Layer-panel name for the new item."),
      },
    },
    async (params) => guard(async () => jsonResult(await bridge.evaluate(createShapeScript(params)))),
  );

  server.registerTool(
    "ai_create_text",
    {
      title: "Illustrator: add text",
      description:
        "Add a text frame on the active artboard at x/y (its top-left). Give width and height for wrapping area " +
        "text; omit both for a single-line point text. Font is a PostScript name (e.g. ArialMT, Arial-BoldMT).",
      inputSchema: {
        text: z.string().min(1).describe("The text content. Use \\n for line breaks."),
        x: coord("Left edge"),
        y: coord("Top edge"),
        fontSize: z.number().finite().positive().optional().describe("Font size in points. Defaults to Illustrator's current default."),
        font: z.string().min(1).optional().describe("PostScript font name, e.g. ArialMT or Helvetica-Bold."),
        fill: hexColor.optional().describe("Text color."),
        width: z.number().finite().positive().optional().describe("Area-text width (with height)."),
        height: z.number().finite().positive().optional().describe("Area-text height (with width)."),
        name: z.string().min(1).optional().describe("Layer-panel name for the text frame."),
      },
    },
    async (params) => guard(async () => jsonResult(await bridge.evaluate(createTextScript(params)))),
  );

  server.registerTool(
    "ai_save_document",
    {
      title: "Illustrator: save the document",
      description:
        "Save the active document as a native .ai file. Pass a path to Save As (required the first time); omit it " +
        "to save in place. Overwrites an existing file at that path.",
      inputSchema: {
        path: z.string().min(1).optional().describe("Absolute path ending in .ai. Omit to save to the current file."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path }) => guard(async () => jsonResult(await bridge.evaluate(saveDocumentScript(path)))),
  );

  server.registerTool(
    "ai_export_artboard",
    {
      title: "Illustrator: export the active artboard",
      description:
        "Export the active artboard to a PNG or JPG (clipped to the artboard, at a scale percentage), or the " +
        "document to SVG. Returns the written file's path. Overwrites an existing file.",
      inputSchema: {
        format: z.enum(["png", "jpg", "svg"]).describe("Output format."),
        path: z.string().min(1).describe("Absolute output path with the matching extension."),
        scalePercent: z
          .number()
          .finite()
          .positive()
          .max(1000)
          .optional()
          .describe("png/jpg only: 100 = artboard size at 72 ppi; 200 = 2x. Defaults to 100."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ format, path, scalePercent }) =>
      guard(async () =>
        jsonResult(
          await bridge.evaluate(exportArtboardScript(format, path, scalePercent ?? 100), { timeoutClass: "slow" }),
        ),
      ),
  );

  server.registerTool(
    "ai_get_preview",
    {
      title: "Illustrator: preview the active artboard",
      description:
        "Render the active artboard to a small PNG and return it as an image so you can see the current state. " +
        "Also returns the file path. Use after drawing to check your work.",
      inputSchema: {
        maxDimension: z
          .number()
          .int()
          .min(64)
          .max(2048)
          .optional()
          .describe("Longest edge of the preview in pixels. Defaults to 1024."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ maxDimension }) =>
      guard(async () => {
        const dir = join(tmpdir(), "brainferno-mcp-bridge", "previews");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${randomUUID()}.png`);
        const info = await bridge.evaluate(previewScript(path.replace(/\\/g, "/"), maxDimension ?? 1024), {
          timeoutClass: "slow",
        });
        const written = typeof info === "object" && info !== null && !Array.isArray(info) ? info["path"] : undefined;
        return imageResult(typeof written === "string" ? written : path, "image/png", "Active artboard preview");
      }),
  );
}
