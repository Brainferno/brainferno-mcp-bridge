#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, migrateLegacyUserDir } from "./config.js";
import { log } from "./logging.js";
import { createMcpServer } from "./server.js";
import { startRuntime, type StartedRuntime } from "./start.js";

let started: StartedRuntime | null = null;

async function main(): Promise<void> {
  const migrated = migrateLegacyUserDir();
  if (migrated) log.info(`copied settings from ${migrated} to ~/.brainferno-mcp-bridge (the old folder can be deleted)`);
  const config = loadConfig();

  // Shared mode binds its port before the hub takes the handshake file (see startRuntime).
  started = await startRuntime(config);
  const { rt, remote } = started;

  const server = createMcpServer(rt);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server ready on stdio");

  const shutdown = (signal: string) => {
    void (async () => {
      log.info(`received ${signal}, shutting down`);
      await server.close().catch((error: unknown) => log.warn("error closing MCP server", error));
      if (remote) await remote.close().catch((error: unknown) => log.warn("error closing remote listener", error));
      await rt.bridge.close().catch((error: unknown) => log.warn("error closing bridge", error));
      await rt.illustratorDelegate.close().catch((error: unknown) => log.warn("error closing delegate", error));
      await rt.illustratorBridge.close().catch((error: unknown) => log.warn("error closing illustrator bridge", error));
      await rt.mediaEncoder.stop().catch((error: unknown) => log.warn("error stopping Media Encoder service", error));
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("fatal", error);
  // A server that dies after the hub started must not leave the handshake file pointing at it:
  // close() removes the file when it is still ours.
  const closing = started === null ? Promise.resolve() : started.rt.bridge.close().catch(() => undefined);
  void closing.then(() => process.exit(1));
});
