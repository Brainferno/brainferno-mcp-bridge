/**
 * Which MCP tool call the current async work belongs to (AE-16): the tool name and the arguments
 * the callback received, so an error raised deep inside a bridge call can name both. App-neutral.
 *
 * It is an AsyncLocalStorage store, not a module-level "current tool": concurrent calls (several
 * sessions, several apps, the per-app queue) each keep their own. Awaiting `bridge.evaluate`
 * resumes in the caller's context, so a ScriptError built in the WebSocket handler is still read
 * against the right call. Job steps started from a callback inherit the store, including after a
 * `wait:false` return; only the error enrichment reads it, so that is harmless.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolCall {
  /** The MCP tool name, as registered. */
  readonly tool: string;
  /**
   * The arguments the SDK validated and passed to the callback (zod-parsed: unknown or misspelled
   * keys are already stripped, so they never appear in an echo); undefined for tools that never
   * echo them and for tools without an input schema.
   */
  readonly args: Readonly<Record<string, unknown>> | undefined;
}

const calls = new AsyncLocalStorage<ToolCall>();

/** The tool call the current async context belongs to, if any. */
export function currentToolCall(): ToolCall | undefined {
  return calls.getStore();
}

/** Runs fn inside a tool-call context (tests, and AE-03's ae_batch for per-operation context). */
export function runAsToolCall<T>(call: ToolCall, fn: () => T): T {
  return calls.run(call, fn);
}

type RegisterTool = McpServer["registerTool"];
type AnyCallback = (...a: unknown[]) => unknown;

/**
 * A registerTool that runs every callback inside a tool-call context. Use it per app, inside the
 * app's register function, so unit tests that build an McpServer directly get it too. The store
 * holds the args object itself (not a copy); handlers do not mutate it, and it is echoed only on
 * failure.
 */
export function withToolContext(server: McpServer, options: { noArgs?: ReadonlySet<string> } = {}): { registerTool: RegisterTool } {
  const noArgs = options.noArgs ?? new Set<string>();
  const register = (name: string, config: unknown, cb: AnyCallback): unknown =>
    (server.registerTool as unknown as (n: string, c: unknown, f: AnyCallback) => unknown).call(server, name, config, (...a: unknown[]) => {
      // The SDK calls (args, extra) for a tool with an input schema and (extra) without one.
      const args = a.length >= 2 && a[0] !== null && typeof a[0] === "object" ? (a[0] as Record<string, unknown>) : undefined;
      return runAsToolCall({ tool: name, args: noArgs.has(name) ? undefined : args }, () => cb(...a));
    });
  return { registerTool: register as unknown as RegisterTool };
}
