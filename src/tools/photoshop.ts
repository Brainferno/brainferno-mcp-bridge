import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/**
 * Photoshop runs UXP, so these scripts may use modern JavaScript and the
 * `photoshop` module the panel exposes to the eval scope.
 */

const LIST_DOCUMENTS = `(() => {
  const { app } = require("photoshop");
  return app.documents.map((doc) => ({
    id: doc.id,
    name: doc.name,
    path: doc.path ?? null,
    width: doc.width,
    height: doc.height,
    resolution: doc.resolution,
    mode: String(doc.mode),
    layerCount: doc.layers.length,
  }));
})()`;

function listLayersScript(documentId: number | undefined): string {
  const selector =
    documentId === undefined ? "app.activeDocument" : `app.documents.find((d) => d.id === ${documentId})`;
  return `(() => {
  const { app } = require("photoshop");
  const doc = ${selector};
  if (!doc) { throw new Error("Document not found"); }
  const walk = (layers, depth) => layers.flatMap((layer) => [
    {
      id: layer.id,
      name: layer.name,
      kind: String(layer.kind),
      visible: layer.visible,
      opacity: layer.opacity,
      depth,
    },
    ...(layer.layers ? walk(layer.layers, depth + 1) : []),
  ]);
  return walk(doc.layers, 0);
})()`;
}

export function registerPhotoshopTools(server: McpServer, bridge: AppBridge): void {
  server.registerTool(
    "ps_list_documents",
    {
      title: "Photoshop: list open documents",
      description: "List every open Photoshop document with its dimensions, resolution, color mode, and layer count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(LIST_DOCUMENTS))),
  );

  server.registerTool(
    "ps_list_layers",
    {
      title: "Photoshop: list layers",
      description: "List the layers of a document, flattened depth-first, with group nesting recorded as a depth value.",
      inputSchema: {
        documentId: z
          .number()
          .int()
          .optional()
          .describe("Document id from ps_list_documents. Defaults to the active document."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ documentId }) => guard(async () => jsonResult(await bridge.evaluate(listLayersScript(documentId)))),
  );
}
