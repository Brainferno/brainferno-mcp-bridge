import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { APPS, APP_IDS, type AppId } from "../apps.js";
import type { BridgeServer } from "../bridge/socket.js";
import { guard, jsonResult } from "./result.js";

/**
 * Cross-application tools: which hosts are reachable, and a raw script escape
 * hatch for work the typed tools do not cover yet.
 */
export function registerDiagnosticTools(server: McpServer, bridge: BridgeServer): void {
  server.registerTool(
    "cc_connected_apps",
    {
      title: "Creative Cloud: connected applications",
      description:
        "List which of the five Creative Cloud applications currently have a panel connected, and which scripting " +
        "engine each one uses. Call this first when a tool reports that an application is not connected.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const connected = new Set(bridge.connectedApps());
        return jsonResult(
          APP_IDS.map((id) => ({
            appId: id,
            displayName: APPS[id].displayName,
            engine: APPS[id].engine,
            connected: connected.has(id),
          })),
        );
      }),
  );

  server.registerTool(
    "cc_eval_script",
    {
      title: "Creative Cloud: evaluate a raw script",
      description:
        "Evaluate a raw script in one of the applications and return its result. The script must match the host's " +
        "engine: ExtendScript (ES3 — var only, no arrow functions) for After Effects, Illustrator, and Audition; " +
        "modern UXP JavaScript for Photoshop and Premiere Pro (Premiere scripts use require('premierepro') and may " +
        "return a Promise). This is an escape hatch for work the typed tools do not cover — prefer a typed tool " +
        "where one exists.",
      inputSchema: {
        appId: z.enum(APP_IDS).describe("Which application to run the script in."),
        script: z
          .string()
          .min(1)
          .describe("Script source. Its final expression is what gets returned, so wrap statements in an IIFE."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Override the default result timeout for this call."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ appId, script, timeoutMs }) =>
      guard(async () => jsonResult(await bridge.bridgeFor(appId as AppId).evaluate(script, { timeoutMs }))),
  );
}
