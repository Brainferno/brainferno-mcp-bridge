import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BridgeServer } from "./bridge/socket.js";
import type { Config } from "./config.js";
import { AmeWebService } from "./drivers/ame-webservice.js";
import { IllustratorDelegate } from "./drivers/illustrator-delegate.js";
import { OsScriptBridge } from "./drivers/osscript.js";
import { JobRegistry } from "./jobs.js";
import { setLogLevel } from "./logging.js";
import { registerAfterEffectsTools } from "./tools/after-effects.js";
import { registerAudioTools, type AudioToolOptions } from "./tools/audio.js";
import { registerAuditionTools } from "./tools/audition.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerIllustratorTools } from "./tools/illustrator.js";
import { registerIllustratorDelegateTools } from "./tools/illustrator-delegate.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerMediaEncoderTools } from "./tools/media-encoder.js";
import { registerPhotoshopTools } from "./tools/photoshop.js";
import { registerPipelineTools } from "./tools/pipelines.js";
import { registerPremiereTools } from "./tools/premiere.js";

/**
 * Everything that lives once per process and is shared by every MCP session:
 * the panel hub, the panel-less drivers, the job registry, the Media Encoder
 * service. An McpServer (one per transport session) is cheap and is created
 * on top of this with {@link createMcpServer}.
 */
export interface Runtime {
  config: Config;
  bridge: BridgeServer;
  /** Illustrator is driven panel-less over COM/AppleScript, not through the hub. */
  illustratorBridge: OsScriptBridge;
  illustratorDelegate: IllustratorDelegate;
  jobs: JobRegistry;
  /** Media Encoder's headless web service, started on demand. */
  mediaEncoder: AmeWebService;
  audio: AudioToolOptions;
}

export interface BuiltServer extends Runtime {
  server: McpServer;
}

export function buildRuntime(config: Config): Runtime {
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
  const illustratorBridge = new OsScriptBridge({ appId: "illustrator", defaultTimeoutMs: config.evalTimeoutMs });
  const illustratorDelegate = new IllustratorDelegate({ url: config.illustratorMcpUrl, token: config.illustratorMcpKey });
  // Job work folders sit beside the handshake file (~/.brainferno-mcp-bridge/work/<jobId>/).
  const jobs = new JobRegistry({ workRoot: join(dirname(config.handshakeFilePath) || join(homedir(), ".brainferno-mcp-bridge"), "work") });
  const mediaEncoder = new AmeWebService({ exePath: config.ameWebServicePath, port: config.amePort, extraArgs: [], idleMs: config.ameIdleMs });
  const audio = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath };
  return { config, bridge, illustratorBridge, illustratorDelegate, jobs, mediaEncoder, audio };
}

/**
 * A new McpServer with every tool registered against the shared runtime.
 * Tools are registered unconditionally: an application that has no panel
 * connected still advertises its tools, and those tools return an actionable
 * "not connected" error rather than vanishing from the tool list mid-session.
 */
export function createMcpServer(rt: Runtime): McpServer {
  const { config, bridge, jobs } = rt;
  const server = new McpServer(
    { name: "brainferno-mcp-bridge", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Drives Adobe Creative Cloud production applications. Each tool acts on the application that is already " +
        "open on the operator's machine, on the project they currently have loaded — there is no separate workspace. " +
        "Call cc_connected_apps first to see which applications are reachable.",
    },
  );

  // The installer's app choice: only chosen apps get tools (and pipelines that need them).
  const on = new Set(config.enabledApps);
  const appIds = (["after_effects", "premiere", "photoshop", "illustrator", "audition"] as const).filter((id) => on.has(id));

  registerDiagnosticTools(server, bridge, { allowRawScripts: config.allowRawScripts, enabledApps: appIds });
  if (on.has("after_effects")) registerAfterEffectsTools(server, bridge.bridgeFor("after_effects"), { jobs });
  if (on.has("premiere")) registerPremiereTools(server, bridge.bridgeFor("premiere"), { jobs });
  if (on.has("photoshop")) registerPhotoshopTools(server, bridge.bridgeFor("photoshop"), { allowRawScripts: config.allowRawScripts });
  if (on.has("illustrator")) {
    registerIllustratorTools(server, rt.illustratorBridge);
    registerIllustratorDelegateTools(server, rt.illustratorDelegate, config.illustratorMcpKey !== "");
  }
  if (on.has("audition")) registerAuditionTools(server, bridge.bridgeFor("audition"));
  registerAudioTools(server, rt.audio);
  registerJobTools(server, jobs);
  if (on.has("media_encoder")) registerMediaEncoderTools(server, rt.mediaEncoder, { jobs });
  registerPipelineTools(server, {
    photoshop: bridge.bridgeFor("photoshop"),
    afterEffects: bridge.bridgeFor("after_effects"),
    premiere: bridge.bridgeFor("premiere"),
    illustrator: rt.illustratorBridge,
    jobs,
    audio: rt.audio,
    enabled: on,
  });
  return server;
}

/** Runtime plus one McpServer (the stdio session). */
export function buildServer(config: Config): BuiltServer {
  const rt = buildRuntime(config);
  return { ...rt, server: createMcpServer(rt) };
}
