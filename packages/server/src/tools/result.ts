import { readFile } from "node:fs/promises";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AppNotConnectedError, EvalTimeoutError, ScriptError } from "../bridge/types.js";
import type { PreviewMode } from "../config.js";
import { log } from "../logging.js";

let previewMode: PreviewMode = "both";

/** Process-wide preview mode (BRAINFERNO_MCP_PREVIEW), set once at startup like the log level. */
export function setPreviewMode(mode: PreviewMode): void {
  previewMode = mode;
}

/** Wraps any JSON-serializable value as a tool result the client reads as text. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Returns an image the model can see, plus a text block naming the file on
 * disk so pipelines can pass the full-resolution path along. Callers keep the
 * file small (export at a reduced scale) — image bytes count against context.
 * In "path" mode (clients that cannot show the model images) only the text
 * block is returned; in "inline" mode only the image block.
 */
export async function imageResult(filePath: string, mimeType: "image/png" | "image/jpeg", note?: string): Promise<CallToolResult> {
  const text = { type: "text" as const, text: note === undefined ? filePath : `${note}
${filePath}` };
  if (previewMode === "path") return { content: [text] };
  const data = (await readFile(filePath)).toString("base64");
  const image = { type: "image" as const, data, mimeType };
  return { content: previewMode === "inline" ? [image] : [image, text] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Runs a tool body, turning the bridge's typed failures into readable tool
 * errors rather than letting them escape as protocol-level exceptions. An
 * agent can act on "the panel isn't running"; it cannot act on a stack trace.
 */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppNotConnectedError) return errorResult(error.message);
    if (error instanceof EvalTimeoutError) return errorResult(error.message);
    if (error instanceof ScriptError) {
      const where = error.scriptLine === undefined ? "" : ` (line ${error.scriptLine})`;
      return errorResult(`Script failed in ${error.appId}${where}: ${error.message}`);
    }
    log.error("unhandled tool error", error);
    return errorResult(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}
