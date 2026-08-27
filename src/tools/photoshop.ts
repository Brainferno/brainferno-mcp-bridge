import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/**
 * Photoshop is driven through its UXP panel. UXP does not reliably evaluate
 * script strings, so — per protocol v2 — these tools send *named* commands
 * and the panel implements them against the `photoshop` module (DOM and
 * batchPlay). The panel advertises the names it implements in its hello
 * `capabilities`; an unimplemented name comes back as UNKNOWN_COMMAND.
 */

export function registerPhotoshopTools(server: McpServer, bridge: AppBridge): void {
  server.registerTool(
    "ps_list_documents",
    {
      title: "Photoshop: list open documents",
      description: "List every open Photoshop document with its dimensions, resolution, color mode, and layer count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.execute("ps.list_documents", {}, { timeoutClass: "fast" }))),
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
    async ({ documentId }) =>
      guard(async () =>
        jsonResult(await bridge.execute("ps.list_layers", { documentId: documentId ?? null }, { timeoutClass: "fast" })),
      ),
  );
}
