import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BridgeServer } from "./bridge/socket.js";
import type { Config } from "./config.js";
import { setLogLevel } from "./logging.js";
import { registerAfterEffectsTools } from "./tools/after-effects.js";
import { registerAuditionTools } from "./tools/audition.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerIllustratorTools } from "./tools/illustrator.js";
import { registerPhotoshopTools } from "./tools/photoshop.js";
import { registerPremiereTools } from "./tools/premiere.js";

export interface BuiltServer {
  server: McpServer;
  bridge: BridgeServer;
}

/**
 * Builds the MCP server and the bridge it talks to the applications through.
 * Tools are registered unconditionally: an application that has no panel
 * connected still advertises its tools, and those tools return an actionable
 * "not connected" error rather than vanishing from the tool list mid-session.
 */
export function buildServer(config: Config): BuiltServer {
  setLogLevel(config.logLevel);

  const bridge = new BridgeServer({
    port: config.bridgePort,
    token: config.bridgeToken,
    insecure: config.bridgeInsecure,
    defaultTimeoutMs: config.evalTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    handshakeFilePath: config.handshakeFilePath,
    allowedOrigins: config.allowedOrigins,
  });

  const server = new McpServer(
    { name: "adobe-cc-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Drives Adobe Creative Cloud production applications. Each tool acts on the application that is already " +
        "open on the operator's machine, on the project they currently have loaded — there is no separate workspace. " +
        "Call cc_connected_apps first to see which applications are reachable.",
    },
  );

  registerDiagnosticTools(server, bridge, { allowRawScripts: config.allowRawScripts });
  registerAfterEffectsTools(server, bridge.bridgeFor("after_effects"));
  registerPremiereTools(server, bridge.bridgeFor("premiere"));
  registerPhotoshopTools(server, bridge.bridgeFor("photoshop"));
  registerIllustratorTools(server, bridge.bridgeFor("illustrator"));
  registerAuditionTools(server, bridge.bridgeFor("audition"));

  return { server, bridge };
}
