import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge, EvalOptions, JsonValue } from "../bridge/types.js";
import { log } from "../logging.js";
import { guard, imageResult, jsonResult } from "./result.js";

/**
 * Photoshop is driven through its UXP panel. UXP cannot evaluate script
 * strings, so — per protocol v2 — these tools send *named* commands and the
 * panel implements them against the `photoshop` module (DOM + batchPlay,
 * inside `executeAsModal` for anything that changes the document). The panel
 * advertises the names it implements in its hello `capabilities`; an
 * unimplemented name comes back as UNKNOWN_COMMAND.
 *
 * Coordinates are document pixels from the top-left. Colors are hex.
 */

export interface PhotoshopToolOptions {
  /** Register `ps_batch_play` (raw ActionDescriptors). Off by default. */
  allowRawScripts: boolean;
}

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "hex color like #ff8800")
  .describe("Hex color like #ff8800.");
const px = (what: string) => z.number().finite().describe(`${what}, in document pixels.`);
const layerId = z.number().int().describe("Layer id from ps_list_layers.");

const fast = { timeoutClass: "fast" as const };
const slow = { timeoutClass: "slow" as const };

export function registerPhotoshopTools(server: McpServer, bridge: AppBridge, options: PhotoshopToolOptions): void {
  // Params are validated by zod; JSON.stringify drops undefined optionals on the wire.
  const run = (name: string, params: unknown, opts: EvalOptions = slow) =>
    guard(async () => jsonResult(await bridge.execute(name, params as JsonValue, opts)));

  // ---- read ---------------------------------------------------------------
  server.registerTool(
    "ps_list_documents",
    {
      title: "Photoshop: list open documents",
      description: "List every open Photoshop document with its id, dimensions, resolution, color mode, and layer count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("ps.list_documents", {}, fast),
  );

  server.registerTool(
    "ps_list_layers",
    {
      title: "Photoshop: list layers",
      description:
        "List the layers of a document, flattened depth-first, with group nesting recorded as a depth value. " +
        "Includes each layer's id (needed by the layer tools), kind, visibility, opacity, and bounds.",
      inputSchema: {
        documentId: z.number().int().optional().describe("Document id from ps_list_documents. Defaults to the active document."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ documentId }) => run("ps.list_layers", { documentId: documentId ?? null }, fast),
  );

  // ---- documents ----------------------------------------------------------
  server.registerTool(
    "ps_create_document",
    {
      title: "Photoshop: create a document",
      description: "Create a new document and make it active. Later tools act on the active document.",
      inputSchema: {
        width: z.number().int().positive().describe("Width in pixels."),
        height: z.number().int().positive().describe("Height in pixels."),
        resolution: z.number().positive().optional().describe("Pixels per inch. Defaults to 72."),
        mode: z.enum(["rgb", "grayscale"]).optional().describe("Color mode. Defaults to rgb."),
        fill: z.enum(["white", "transparent", "black"]).optional().describe("Background fill. Defaults to white."),
        name: z.string().min(1).optional().describe("Document name."),
      },
    },
    async (p) => run("ps.create_document", { ...p, resolution: p.resolution ?? 72, mode: p.mode ?? "rgb", fill: p.fill ?? "white", name: p.name ?? null }),
  );

  server.registerTool(
    "ps_open_document",
    {
      title: "Photoshop: open a file",
      description: "Open an image or PSD file as a new document and make it active.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to the file.") },
    },
    async ({ path }) => run("ps.open_document", { path }),
  );

  server.registerTool(
    "ps_save_document",
    {
      title: "Photoshop: save the document",
      description:
        "Save the active document. Pass a path to Save As (.psd; required the first time); omit it to save in place. " +
        "Overwrites an existing file at that path.",
      inputSchema: { path: z.string().min(1).optional().describe("Absolute path ending in .psd. Omit to save to the current file.") },
      annotations: { destructiveHint: true },
    },
    async ({ path }) => run("ps.save_document", { path: path ?? null }),
  );

  server.registerTool(
    "ps_export",
    {
      title: "Photoshop: export a copy",
      description: "Export a flattened copy of the active document as PNG or JPEG. The document itself is not changed. Overwrites an existing file.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute output path with .png or .jpg extension."),
        format: z.enum(["png", "jpg"]).describe("Output format."),
        quality: z.number().int().min(0).max(12).optional().describe("jpg only: 0–12. Defaults to 10."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path, format, quality }) => run("ps.export", { path, format, quality: quality ?? 10 }),
  );

  server.registerTool(
    "ps_get_preview",
    {
      title: "Photoshop: preview the document",
      description:
        "Render the active document (all visible layers) to a small PNG and return it as an image so you can see " +
        "the current state. Also returns the file path. Use after edits to check your work.",
      inputSchema: {
        maxDimension: z.number().int().min(64).max(2048).optional().describe("Longest edge in pixels. Defaults to 1024."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ maxDimension }) =>
      guard(async () => {
        const dir = join(tmpdir(), "brainferno-mcp-bridge", "previews");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${randomUUID()}.png`);
        const info = await bridge.execute("ps.preview", { path, maxDimension: maxDimension ?? 1024 }, slow);
        const written = typeof info === "object" && info !== null && !Array.isArray(info) ? info["path"] : undefined;
        return imageResult(typeof written === "string" ? written : path, "image/png", "Document preview");
      }),
  );

  // ---- layers -------------------------------------------------------------
  server.registerTool(
    "ps_create_layer",
    {
      title: "Photoshop: create a layer",
      description: "Add an empty pixel layer or a layer group above the active layer. Returns the new layer's id.",
      inputSchema: {
        name: z.string().min(1).optional().describe("Layer name."),
        kind: z.enum(["pixel", "group"]).optional().describe("Defaults to pixel."),
      },
    },
    async ({ name, kind }) => run("ps.create_layer", { name: name ?? null, kind: kind ?? "pixel" }, fast),
  );

  server.registerTool(
    "ps_create_text_layer",
    {
      title: "Photoshop: add a text layer",
      description:
        "Add a point-text layer with the given text at x/y (the text's anchor). Font is a PostScript name " +
        "(e.g. ArialMT, Arial-BoldMT). Returns the new layer's id.",
      inputSchema: {
        text: z.string().min(1).describe("The text. Use \\n for line breaks."),
        x: px("Anchor x"),
        y: px("Anchor y (baseline of the first line)"),
        fontSize: z.number().positive().optional().describe("Size in points. Defaults to 48."),
        font: z.string().min(1).optional().describe("PostScript font name. Defaults to ArialMT."),
        color: hexColor.optional().describe("Text color. Defaults to black."),
        name: z.string().min(1).optional().describe("Layer name. Defaults to the text."),
      },
    },
    async (p) => run("ps.create_text_layer", { ...p, fontSize: p.fontSize ?? 48, font: p.font ?? "ArialMT", color: p.color ?? "#000000", name: p.name ?? null }),
  );

  server.registerTool(
    "ps_set_layer_props",
    {
      title: "Photoshop: set layer properties",
      description: "Rename, show/hide, set opacity or blend mode, or lock a layer. Only the given fields change.",
      inputSchema: {
        layerId,
        name: z.string().min(1).optional(),
        visible: z.boolean().optional(),
        opacity: z.number().min(0).max(100).optional().describe("0–100."),
        blendMode: z
          .enum(["normal", "multiply", "screen", "overlay", "softLight", "hardLight", "darken", "lighten", "difference", "colorDodge", "colorBurn"])
          .optional(),
        locked: z.boolean().optional().describe("Lock all (true) or unlock (false)."),
      },
    },
    async (p) => run("ps.set_layer_props", { ...p }, fast),
  );

  server.registerTool(
    "ps_move_layer",
    {
      title: "Photoshop: move a layer's content",
      description: "Translate a layer's pixels/text by dx/dy pixels.",
      inputSchema: { layerId, dx: px("Horizontal offset"), dy: px("Vertical offset") },
    },
    async (p) => run("ps.move_layer", { ...p }, fast),
  );

  server.registerTool(
    "ps_duplicate_layer",
    {
      title: "Photoshop: duplicate a layer",
      description: "Duplicate a layer above itself. Returns the new layer's id.",
      inputSchema: { layerId, name: z.string().min(1).optional().describe("Name for the copy.") },
    },
    async ({ layerId: id, name }) => run("ps.duplicate_layer", { layerId: id, name: name ?? null }, fast),
  );

  server.registerTool(
    "ps_delete_layer",
    {
      title: "Photoshop: delete a layer",
      description: "Delete a layer (or a group and its contents).",
      inputSchema: { layerId },
      annotations: { destructiveHint: true },
    },
    async ({ layerId: id }) => run("ps.delete_layer", { layerId: id }, fast),
  );

  // ---- layer styles -------------------------------------------------------
  const styleName = z
    .enum(["dropShadow", "innerShadow", "outerGlow", "innerGlow", "bevelEmboss", "satin", "colorOverlay", "gradientOverlay", "stroke"])
    .describe("Layer style name.");
  const blendModeName = z
    .enum(["normal", "multiply", "screen", "overlay", "softLight", "hardLight", "darken", "lighten", "difference", "colorDodge", "colorBurn"])
    .optional();

  server.registerTool(
    "ps_set_layer_style",
    {
      title: "Photoshop: add or edit a layer style",
      description:
        "Add a layer style (drop shadow, inner shadow, glows, bevel & emboss, satin, color overlay, gradient overlay, " +
        "stroke) to a layer, or change one that is already there — the same style is updated in place, other styles " +
        "are kept. Only the given settings change; the rest use Photoshop's defaults.",
      inputSchema: {
        layerId,
        style: styleName,
        enabled: z.boolean().optional().describe("Defaults to true."),
        blendMode: blendModeName.describe("Blend mode of the style. Defaults per style (shadows multiply, glows screen…)."),
        color: hexColor.optional().describe("Main color of the style (shadow, glow, satin, overlay, or stroke color)."),
        opacity: z.number().min(0).max(100).optional().describe("Style opacity 0–100."),
        angle: z.number().min(-180).max(180).optional().describe("Light angle in degrees (shadows, satin, bevel)."),
        useGlobalAngle: z.boolean().optional().describe("Follow the document's global light (shadows, bevel)."),
        distance: z.number().min(0).optional().describe("Offset distance in pixels (shadows, satin)."),
        size: z.number().min(0).optional().describe("Blur/size in pixels (shadows, glows, satin, bevel, stroke width)."),
        spread: z.number().min(0).max(100).optional().describe("Spread/choke in percent (shadows, glows)."),
        noise: z.number().min(0).max(100).optional().describe("Noise in percent (shadows, glows)."),
        strokePosition: z.enum(["outside", "inside", "center"]).optional().describe("stroke only. Defaults to outside."),
        bevelStyle: z.enum(["outerBevel", "innerBevel", "emboss", "pillowEmboss", "strokeEmboss"]).optional().describe("bevelEmboss only. Defaults to innerBevel."),
        bevelDirection: z.enum(["up", "down"]).optional().describe("bevelEmboss only. Defaults to up."),
        depth: z.number().min(1).max(1000).optional().describe("bevelEmboss depth in percent. Defaults to 100."),
        soften: z.number().min(0).optional().describe("bevelEmboss soften in pixels. Defaults to 0."),
        highlightColor: hexColor.optional().describe("bevelEmboss highlight. Defaults to white."),
        shadowColor: hexColor.optional().describe("bevelEmboss shadow. Defaults to black."),
        altitude: z.number().min(0).max(90).optional().describe("bevelEmboss light altitude in degrees. Defaults to 30."),
        colors: z.array(hexColor).min(2).optional().describe("gradientOverlay: two or more hex colors, spread evenly from start to end. Defaults to black→white."),
        gradientStyle: z.enum(["linear", "radial", "angle", "reflected", "diamond"]).optional().describe("gradientOverlay shape. Defaults to linear."),
        scale: z.number().min(10).max(150).optional().describe("gradientOverlay scale in percent. Defaults to 100."),
        reverse: z.boolean().optional().describe("gradientOverlay: flip the gradient direction."),
        alignWithLayer: z.boolean().optional().describe("gradientOverlay: anchor the gradient to the layer. Defaults to true."),
        dither: z.boolean().optional().describe("gradientOverlay: dither to reduce banding."),
      },
    },
    async (p) =>
      run("ps.set_layer_style", {
        layerId: p.layerId,
        style: p.style,
        enabled: p.enabled ?? true,
        blendMode: p.blendMode ?? null,
        color: p.color ?? null,
        opacity: p.opacity ?? null,
        angle: p.angle ?? null,
        useGlobalAngle: p.useGlobalAngle ?? null,
        distance: p.distance ?? null,
        size: p.size ?? null,
        spread: p.spread ?? null,
        noise: p.noise ?? null,
        strokePosition: p.strokePosition ?? null,
        bevelStyle: p.bevelStyle ?? null,
        bevelDirection: p.bevelDirection ?? null,
        depth: p.depth ?? null,
        soften: p.soften ?? null,
        highlightColor: p.highlightColor ?? null,
        shadowColor: p.shadowColor ?? null,
        altitude: p.altitude ?? null,
        colors: p.colors ?? null,
        gradientStyle: p.gradientStyle ?? null,
        scale: p.scale ?? null,
        reverse: p.reverse ?? null,
        alignWithLayer: p.alignWithLayer ?? null,
        dither: p.dither ?? null,
      }),
  );

  server.registerTool(
    "ps_get_layer_styles",
    {
      title: "Photoshop: read a layer's styles",
      description: "Read the layer styles on a layer as Photoshop's layerEffects descriptor (null when the layer has none).",
      inputSchema: { layerId },
      annotations: { readOnlyHint: true },
    },
    async ({ layerId: id }) => run("ps.get_layer_styles", { layerId: id }, fast),
  );

  server.registerTool(
    "ps_remove_layer_style",
    {
      title: "Photoshop: remove layer styles",
      description: "Remove one layer style from a layer, or every style when no style is given.",
      inputSchema: { layerId, style: styleName.optional().describe("Omit to clear all styles.") },
      annotations: { destructiveHint: true },
    },
    async ({ layerId: id, style }) => run("ps.remove_layer_style", { layerId: id, style: style ?? null }),
  );

  // ---- pixels -------------------------------------------------------------
  server.registerTool(
    "ps_place_image",
    {
      title: "Photoshop: place an image",
      description: "Place an image file into the active document as a new smart-object layer, centered. Returns the new layer's id.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to an image file."), name: z.string().min(1).optional() },
    },
    async ({ path, name }) => run("ps.place_image", { path, name: name ?? null }),
  );

  server.registerTool(
    "ps_fill",
    {
      title: "Photoshop: fill an area with a color",
      description:
        "Fill a rectangle (or the whole canvas if no rectangle is given) on the active layer with a solid color. " +
        "The active layer must be a pixel layer (make one with ps_create_layer).",
      inputSchema: {
        color: hexColor,
        left: px("Left").optional(),
        top: px("Top").optional(),
        right: px("Right").optional(),
        bottom: px("Bottom").optional(),
        layerId: layerId.optional().describe("Layer to fill. Defaults to the active layer."),
      },
    },
    async (p) => run("ps.fill", { ...p, layerId: p.layerId ?? null }),
  );

  server.registerTool(
    "ps_apply_filter",
    {
      title: "Photoshop: apply a filter",
      description: "Apply a filter to a layer: gaussianBlur (radius px), motionBlur (angle°, distance px), or unsharpMask (amount %, radius px, threshold).",
      inputSchema: {
        layerId,
        filter: z.enum(["gaussianBlur", "motionBlur", "unsharpMask"]),
        radius: z.number().positive().optional().describe("gaussianBlur/unsharpMask radius in px. Defaults to 10 / 2."),
        angle: z.number().optional().describe("motionBlur angle in degrees. Defaults to 0."),
        distance: z.number().positive().optional().describe("motionBlur distance in px. Defaults to 30."),
        amount: z.number().positive().optional().describe("unsharpMask amount in %. Defaults to 100."),
        threshold: z.number().int().min(0).max(255).optional().describe("unsharpMask threshold. Defaults to 0."),
      },
    },
    async (p) => run("ps.apply_filter", { ...p }),
  );

  server.registerTool(
    "ps_resize_image",
    {
      title: "Photoshop: resize the image",
      description: "Resample the whole document to a new pixel size (keeps the aspect ratio if only one dimension is given).",
      inputSchema: {
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        resolution: z.number().positive().optional().describe("Pixels per inch; unchanged if omitted."),
      },
      annotations: { destructiveHint: true },
    },
    async (p) => run("ps.resize_image", { width: p.width ?? null, height: p.height ?? null, resolution: p.resolution ?? null }),
  );

  server.registerTool(
    "ps_crop",
    {
      title: "Photoshop: crop",
      description: "Crop the document to a rectangle.",
      inputSchema: { left: px("Left"), top: px("Top"), right: px("Right"), bottom: px("Bottom") },
      annotations: { destructiveHint: true },
    },
    async (p) => run("ps.crop", { ...p }),
  );

  // ---- escape hatch -------------------------------------------------------
  if (!options.allowRawScripts) {
    log.info("ps_batch_play is disabled; set BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1 to enable");
    return;
  }
  server.registerTool(
    "ps_batch_play",
    {
      title: "Photoshop: run raw batchPlay descriptors",
      description:
        "Run an array of Photoshop ActionDescriptors via batchPlay inside executeAsModal and return the results. " +
        "This reaches anything Photoshop can record; prefer a typed ps_* tool where one exists.",
      inputSchema: {
        descriptors: z.array(z.record(z.unknown())).min(1).describe("ActionDescriptor objects (batchPlay 'actionJSON' form)."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ descriptors }) => run("ps.batch_play", { descriptors }),
  );
}
