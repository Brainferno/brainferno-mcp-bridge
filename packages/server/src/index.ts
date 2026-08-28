#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, migrateLegacyUserDir } from "./config.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";
import { log } from "./logging.js";
import { buildRuntime, createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const migrated = migrateLegacyUserDir();
  if (migrated) log.info(`copied settings from ${migrated} to ~/.brainferno-mcp-bridge (the old folder can be deleted)`);
  const config = loadConfig();

  const rt = buildRuntime(config);
  await rt.bridge.ready();

  const server = createMcpServer(rt);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server ready on stdio");

  let remote: RunningHttpServer | null = null;
  if (config.httpPort > 0) {
    remote = await startHttpServer(() => createMcpServer(rt), { host: config.httpHost, port: config.httpPort, token: config.httpToken });
  }

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
  process.exit(1);
});
