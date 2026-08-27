#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { log } from "./logging.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const { server, bridge, illustratorDelegate, illustratorBridge, mediaEncoder } = buildServer(config);
  await bridge.ready();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server ready on stdio");

  const shutdown = (signal: string) => {
    void (async () => {
      log.info(`received ${signal}, shutting down`);
      await server.close().catch((error: unknown) => log.warn("error closing MCP server", error));
      await bridge.close().catch((error: unknown) => log.warn("error closing bridge", error));
      await illustratorDelegate.close().catch((error: unknown) => log.warn("error closing delegate", error));
      await illustratorBridge.close().catch((error: unknown) => log.warn("error closing illustrator bridge", error));
      await mediaEncoder.stop().catch((error: unknown) => log.warn("error stopping Media Encoder service", error));
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("fatal", error);
  process.exit(1);
});
