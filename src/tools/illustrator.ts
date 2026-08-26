import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/**
 * Illustrator has no public UXP — it is driven through ExtendScript (ES3) via
 * the CEP panel: `var` only, no arrow functions, no JSON global. Do not
 * modernize these scripts.
 */

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
}
