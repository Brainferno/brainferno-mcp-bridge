import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/**
 * Audition's ExtendScript surface is the thinnest of the five — it exposes the
 * active document and transport, but no project model comparable to Premiere's.
 */

const DOCUMENT_INFO = `(function () {
  var doc = app.activeDocument;
  if (!doc) { return null; }
  return {
    name: doc.displayName,
    path: doc.url ? String(doc.url) : null,
    sampleRate: doc.sampleRate,
    duration: doc.duration,
    isMultitrack: doc.constructor.name === "MultitrackDocument"
  };
})()`;

export function registerAuditionTools(server: McpServer, bridge: AppBridge): void {
  server.registerTool(
    "au_document_info",
    {
      title: "Audition: active document info",
      description:
        "Read the active Audition document's name, path, sample rate, and duration, and whether it is a multitrack session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(DOCUMENT_INFO))),
  );
}
