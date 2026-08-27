import { createHash } from "node:crypto";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { APPS, APP_IDS, type AppId } from "@adobe-cc-mcp/protocol";
import type { BridgeServer } from "../bridge/socket.js";
import { log } from "../logging.js";
import { guard, jsonResult } from "./result.js";

export interface DiagnosticOptions {
  /**
   * Register the raw-script escape hatch. Off by default: it is arbitrary code
   * execution at user privilege on any connected host.
   */
  allowRawScripts: boolean;
}

/** Host ids whose engine can evaluate a raw ExtendScript string. */
const RAW_SCRIPT_APP_IDS = APP_IDS.filter((id) => APPS[id].engine === "extendscript") as [AppId, ...AppId[]];

/**
 * Cross-application tools: which hosts are reachable, and (opt-in) a raw script
 * escape hatch for work the typed tools do not cover yet.
 */
export function registerDiagnosticTools(
  server: McpServer,
  bridge: BridgeServer,
  options: DiagnosticOptions,
): void {
  server.registerTool(
    "cc_connected_apps",
    {
      title: "Creative Cloud: connected applications",
      description:
        "List all five Creative Cloud applications, how each is reached (a UXP or CEP panel over the bridge, or " +
        "direct OS scripting), and whether it is currently connected. Call this first when a tool reports that an " +
        "application is not connected.",
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
            lane: APPS[id].lane,
            panel: APPS[id].panel ?? null,
            engine: APPS[id].engine,
            connected: APPS[id].lane === "os-script" ? null : connected.has(id),
          })),
        );
      }),
  );

  if (!options.allowRawScripts) {
    log.info("raw-script tool (cc_eval_script) is disabled; set ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS=1 to enable");
    return;
  }

  server.registerTool(
    "cc_eval_script",
    {
      title: "Creative Cloud: evaluate a raw ExtendScript",
      description:
        "Evaluate a raw ExtendScript (ES3 — var only, no arrow functions) in After Effects, Illustrator, or " +
        "Audition and return its result. This is an escape hatch for work the typed tools do not cover — prefer a " +
        "typed tool where one exists. Photoshop and Premiere Pro are not available here (their engines do not " +
        "evaluate arbitrary script strings).",
      inputSchema: {
        appId: z.enum(RAW_SCRIPT_APP_IDS).describe("Which ExtendScript host to run the script in."),
        script: z
          .string()
          .min(1)
          .describe("ExtendScript source. Its final expression is returned, so wrap statements in an IIFE."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Override the default result timeout for this call."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ appId, script, timeoutMs }) =>
      guard(async () => {
        const hash = createHash("sha256").update(script).digest("hex").slice(0, 12);
        log.warn(`cc_eval_script on ${appId} [${hash}]: ${script.slice(0, 200)}`);
        return jsonResult(await bridge.bridgeFor(appId).evaluate(script, { timeoutMs }));
      }),
  );
}
