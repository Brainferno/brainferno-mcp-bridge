import { readFile } from "node:fs/promises";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { APPS } from "@brainferno/mcp-bridge-protocol";
import { jsStringLiteral } from "../bridge/script-escape.js";
import {
  AppDisconnectedError,
  AppNotConnectedError,
  EvalTimeoutError,
  ScriptError,
  type ScriptErrorDetails,
  type ScriptSuggestion,
} from "../bridge/types.js";
import type { PreviewMode } from "../config.js";
import { log } from "../logging.js";
import { MESSAGE_LIMIT, capCodePoints, oneLine, redactKnown } from "./echo.js";

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
    // First: RunnerExitedError extends AppNotConnectedError and keeps its plain message.
    if (error instanceof AppNotConnectedError) return errorResult(error.message);
    if (error instanceof EvalTimeoutError) return errorResult(error.message);
    if (error instanceof AppDisconnectedError) {
      log.warn(error.message);
      return errorResult(disconnectedText(error));
    }
    if (error instanceof ScriptError) return errorResult(scriptErrorText(error));
    log.error("unhandled tool error", error);
    return errorResult(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const appName = (appId: string): string => APPS[appId as keyof typeof APPS]?.displayName ?? appId;

/**
 * The one text for a ScriptError, shared by guard() and failed job steps (src/jobs.ts):
 *  - the panel answered UNKNOWN_COMMAND (any app): the panel is older than this server;
 *  - not enriched (`details.where` unset): exactly the pre-AE-16 text, byte for byte;
 *  - enriched (After Effects tools, AE-16): one paragraph — tool and arguments, where the line
 *    falls, the host message (secrets redacted, capped), the next step when the message has none,
 *    "did you mean", a note, and the failing code.
 */
export function scriptErrorText(error: ScriptError): string {
  const d = error.details;
  if (d.code === "UNKNOWN_COMMAND") return unknownCommandText(appName(error.appId), error.message);
  if (d.where === undefined) {
    const where = error.scriptLine === undefined ? "" : ` (line ${error.scriptLine})`;
    return `Script failed in ${error.appId}${where}: ${error.message}`;
  }
  let head = `Script failed in ${appName(error.appId)}`;
  if (d.tool !== undefined) head += ` (${d.tool}${d.args !== undefined && d.args !== "{}" ? `, args ${d.args}` : ""})`;
  const at = whereText(d, error.scriptLine);
  if (at !== "") head += ` ${at}`;
  // Redact first: oneLine changes whitespace, and a secret holding a tab or a line break must still match.
  let text = `${head}: ${capCodePoints(oneLine(redactKnown(error.message)), MESSAGE_LIMIT)}`;
  if (d.next !== undefined) text = `${text.replace(/\.$/, "")} — ${d.next}.`;
  if (d.suggestions !== undefined && d.suggestions.length > 0) text += ` Did you mean ${orList(d.suggestions.map(suggestionText))}?`;
  if (d.note !== undefined) text += ` ${oneLine(redactKnown(d.note))}`;
  if (d.excerpt !== undefined && d.excerpt.length > 0) text += ` Code: ${d.excerpt.join(" | ")}`;
  return text;
}

/** guard()'s text for a panel that dropped mid-call (D12): it may have partly run. */
export function disconnectedText(error: AppDisconnectedError): string {
  return (
    `${error.message.replace(/\.$/, "")} — it may have partly run; check ${appName(error.appId)}, ` +
    "reconnect the brainferno-mcp-bridge panel (cc_connected_apps shows when it is back), then retry."
  );
}

/**
 * A failed job step's message, the text guard() gives for the same error: disconnectedText for a
 * panel that dropped mid-step, scriptErrorText for a ScriptError that is enriched or carries
 * UNKNOWN_COMMAND; otherwise exactly what jobs.ts recorded before AE-16 (e.message / String(e)).
 */
export function jobErrorMessage(e: unknown): string {
  if (e instanceof AppDisconnectedError) return disconnectedText(e);
  if (e instanceof ScriptError && (e.details.where !== undefined || e.details.code === "UNKNOWN_COMMAND")) return scriptErrorText(e);
  return e instanceof Error ? e.message : String(e);
}

/** The panel's own text is redacted, then kept on one line, the order scriptErrorText uses. */
function unknownCommandText(app: string, message: string): string {
  return (
    `The ${app} panel does not support this command (${oneLine(redactKnown(message))}) — it is older than this server; ` +
    "update the brainferno-mcp-bridge panel (or reload it after updating), then retry."
  );
}

function whereText(d: ScriptErrorDetails, scriptLine: number | undefined): string {
  switch (d.where) {
    case "body":
      return `at body line ${d.bodyLine} (script line ${scriptLine})`;
    case "helper":
      return `in helper ${d.helper} (script line ${scriptLine})`;
    case "outside":
      return `at script line ${scriptLine}, outside this tool's own code (most likely while the panel converted the result to JSON)`;
    default:
      return ""; // "unknown": no line, or not a script that can be mapped
  }
}

/** Code points of a suggestion's label kept (a label is a display name, there for the reader). */
const LABEL_LIMIT = 80;

/**
 * One "did you mean" entry: the name as an escaped string literal (the quoting the host lists in
 * the same paragraph use, so a `"` in a name cannot end it early or fake a second name), then the
 * label in parentheses, itself a string literal when its quotes or parentheses could be misread.
 */
function suggestionText(s: ScriptSuggestion): string {
  const name = jsStringLiteral(oneLine(redactKnown(s.name)));
  if (s.label === undefined) return name;
  const label = capCodePoints(oneLine(redactKnown(s.label)), LABEL_LIMIT);
  return `${name} (${nestsCleanly(label) ? label : jsStringLiteral(label)})`;
}

/** No `"`, and every parenthesis pairs up in order, so the text cannot close the label's parentheses early. */
function nestsCleanly(text: string): boolean {
  if (text.includes('"')) return false;
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

function orList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
