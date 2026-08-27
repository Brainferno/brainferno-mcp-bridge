import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BridgeServer } from "./bridge/socket.js";
import type { Config } from "./config.js";
import { IllustratorDelegate } from "./drivers/illustrator-delegate.js";
import { OsScriptBridge } from "./drivers/osscript.js";
import { JobRegistry } from "./jobs.js";
import { setLogLevel } from "./logging.js";
import { registerAfterEffectsTools } from "./tools/after-effects.js";
import { registerAudioTools } from "./tools/audio.js";
import { registerAuditionTools } from "./tools/audition.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerIllustratorTools } from "./tools/illustrator.js";
import { registerIllustratorDelegateTools } from "./tools/illustrator-delegate.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerPhotoshopTools } from "./tools/photoshop.js";
import { registerPipelineTools } from "./tools/pipelines.js";
import { registerPremiereTools } from "./tools/premiere.js";

export interface BuiltServer {
  server: McpServer;
  bridge: BridgeServer;
  illustratorDelegate: IllustratorDelegate;
  /** Illustrator is driven panel-less over COM/AppleScript, not through the hub. */
  illustratorBridge: OsScriptBridge;
  jobs: JobRegistry;
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

  const illustratorBridge = new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: config.evalTimeoutMs });
  const illustratorDelegate = new IllustratorDelegate({
    url: config.illustratorMcpUrl,
    token: config.illustratorMcpKey,
  });

  // Job work folders sit beside the handshake file (~/.adobe-cc-mcp/work/<jobId>/).
  const jobs = new JobRegistry({ workRoot: join(dirname(config.handshakeFilePath) || join(homedir(), ".adobe-cc-mcp"), "work") });
  const audio = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath };

  registerDiagnosticTools(server, bridge, { allowRawScripts: config.allowRawScripts });
  registerAfterEffectsTools(server, bridge.bridgeFor("after_effects"), { jobs });
  registerPremiereTools(server, bridge.bridgeFor("premiere"), { jobs });
  registerPhotoshopTools(server, bridge.bridgeFor("photoshop"), { allowRawScripts: config.allowRawScripts });
  registerIllustratorTools(server, illustratorBridge);
  registerIllustratorDelegateTools(server, illustratorDelegate, config.illustratorMcpKey !== "");
  registerAuditionTools(server, bridge.bridgeFor("audition"));
  registerAudioTools(server, audio);
  registerJobTools(server, jobs);
  registerPipelineTools(server, {
    photoshop: bridge.bridgeFor("photoshop"),
    afterEffects: bridge.bridgeFor("after_effects"),
    premiere: bridge.bridgeFor("premiere"),
    illustrator: illustratorBridge,
    jobs,
    audio,
  });

  return { server, bridge, illustratorDelegate, illustratorBridge, jobs };
}
