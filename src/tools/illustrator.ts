import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/** Illustrator runs UXP — modern JavaScript is fine here. */

const LIST_DOCUMENTS = `(() => {
  const { app } = require("illustrator");
  return app.documents.map((doc) => ({
    name: doc.name,
    path: doc.fullName ? String(doc.fullName) : null,
    width: doc.width,
    height: doc.height,
    artboardCount: doc.artboards.length,
    colorSpace: String(doc.documentColorSpace),
  }));
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
