import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { DelegateUnavailableError, type IllustratorDelegate } from "../drivers/illustrator-delegate.js";
import { log } from "../logging.js";
import { errorResult, jsonResult } from "./result.js";

/**
 * Runs a delegate-backed tool body, turning "Illustrator's MCP server isn't
 * reachable" into an actionable tool error rather than a protocol exception.
 */
async function guardDelegate(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DelegateUnavailableError) return errorResult(error.message);
    log.error("unhandled illustrator delegate error", error);
    return errorResult(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Tools that proxy Adobe's official Illustrator (Beta) MCP server. Registered
 * only when a key is configured. We don't mirror Adobe's ~40 tools (unpublished,
 * moving beta target) — instead we expose discovery + a passthrough, so the
 * surface tracks Adobe's automatically.
 */
export function registerIllustratorDelegateTools(
  server: McpServer,
  delegate: IllustratorDelegate,
  enabled: boolean,
): void {
  if (!enabled) {
    log.info(
      "illustrator delegate disabled; set ADOBE_CC_MCP_ILLUSTRATOR_KEY (from Illustrator > MCP & Tools) to enable",
    );
    return;
  }

  server.registerTool(
    "ai_beta_status",
    {
      title: "Illustrator (Adobe MCP): connection status",
      description:
        "Check whether Adobe's built-in Illustrator (Beta) MCP server is reachable, and how many tools it exposes. " +
        "Adobe's server analyzes, batch-recolors, and exports the open document — it cannot create or save (use the " +
        "ai_* tools for that). It only runs while Illustrator (Beta) is open with MCP & Tools enabled.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => jsonResult(await delegate.status()),
  );

  server.registerTool(
    "ai_beta_list_tools",
    {
      title: "Illustrator (Adobe MCP): list available tools",
      description:
        "List the tools Adobe's Illustrator (Beta) MCP server currently exposes (names + descriptions), so you can " +
        "pick one to run with ai_beta_call. Reflects whatever this Illustrator build offers.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guardDelegate(async () => jsonResult(await delegate.listTools())),
  );

  server.registerTool(
    "ai_beta_call",
    {
      title: "Illustrator (Adobe MCP): run a tool",
      description:
        "Run one of Adobe's Illustrator (Beta) MCP tools by name and return its result. Discover valid names and " +
        "their inputs with ai_beta_list_tools first. Adobe's tools analyze/batch-process/export the open document — " +
        "they cannot create a new document or save a .ai (use the ai_* tools for create/save).",
      inputSchema: {
        tool: z.string().min(1).describe("Exact tool name from ai_beta_list_tools."),
        arguments: z
          .record(z.unknown())
          .optional()
          .describe("Arguments object for that tool, matching its input schema."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ tool, arguments: args }) => guardDelegate(async () => delegate.call(tool, args)),
  );
}
