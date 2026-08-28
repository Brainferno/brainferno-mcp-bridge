/** Runtime configuration, read once at startup from the environment. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultHandshakePath } from "./bridge/handshake.js";

export const DEFAULT_ILLUSTRATOR_MCP_URL = "http://localhost:18412/v1/mcp";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

export interface Config {
  /** TCP port the in-app panels dial back to (0 lets the OS pick one). */
  bridgePort: number;
  /**
   * Explicit shared secret panels must present. Empty means "generate a random
   * one at startup" unless {@link bridgeInsecure} is set.
   */
  bridgeToken: string;
  /**
   * Disable panel authentication entirely (no token, no handshake file). For
   * local debugging and tests only — never run this on a shared machine, since
   * the bridge evaluates arbitrary script inside your Adobe applications.
   */
  bridgeInsecure: boolean;
  /** Default deadline for a "slow" script result before rejecting. */
  evalTimeoutMs: number;
  /** How often the bridge pings each panel to detect a dead connection. */
  heartbeatIntervalMs: number;
  /**
   * Whether to register the raw-script escape-hatch tool (`cc_eval_script`).
   * Off by default: it is arbitrary code execution at user privilege.
   */
  allowRawScripts: boolean;
  /** Where to write the port+token handshake file panels read. */
  handshakeFilePath: string;
  /**
   * Extra WebSocket Origins to accept on the upgrade, beyond loopback origins
   * and the no-Origin case (UXP panels send none). Fill in a panel's actual
   * Origin here once a spike establishes what it sends.
   */
  allowedOrigins: string[];
  /** Adobe's official Illustrator (Beta) MCP endpoint the delegate lane dials. */
  illustratorMcpUrl: string;
  /**
   * Bearer key for Adobe's Illustrator (Beta) MCP server. Empty disables the
   * delegate lane. A capability key to the user's local Illustrator — never log
   * it or put it in an error message.
   */
  illustratorMcpKey: string;
  /** ffmpeg / ffprobe executables for the audio process lane (name on PATH or absolute path). */
  ffmpegPath: string;
  ffprobePath: string;
  /** ame_webservice_console(.exe) path; "" = auto-detect the newest Media Encoder. */
  ameWebServicePath: string;
  /** Port of the AME web service; 0 = read it from the ini beside the console. */
  amePort: number;
  /** Stop the AME web service after this idle time; 0 = keep it running. */
  ameIdleMs: number;
  /**
   * Remote mode: also serve MCP over Streamable HTTP on this port (0 = off).
   * Requires {@link httpToken}. Set by the installer's "shared on my network" choice.
   */
  httpPort: number;
  /** Address to bind in remote mode: 127.0.0.1 (this computer) or 0.0.0.0 (network). */
  httpHost: string;
  /** Bearer token every remote request must present. */
  httpToken: string;
  /** Which applications get their tools registered (installer choice; env ADOBE_CC_MCP_APPS overrides). */
  enabledApps: InstallableApp[];
  logLevel: LogLevel;
}

/** Keys the installer may write to `~/.adobe-cc-mcp/config.json` (mode 600). */
/** Everything the installer can switch on or off. */
export const INSTALLABLE_APPS = ["photoshop", "after_effects", "premiere", "illustrator", "audition", "media_encoder"] as const;
export type InstallableApp = (typeof INSTALLABLE_APPS)[number];

export function parseApps(raw: string | undefined, fallback: readonly InstallableApp[] = INSTALLABLE_APPS): InstallableApp[] {
  if (raw === undefined || raw.trim() === "" || raw.trim().toLowerCase() === "all") return [...fallback];
  const aliases: Record<string, InstallableApp> = {
    ps: "photoshop",
    photoshop: "photoshop",
    ae: "after_effects",
    aftereffects: "after_effects",
    after_effects: "after_effects",
    "after-effects": "after_effects",
    ppro: "premiere",
    pr: "premiere",
    premiere: "premiere",
    premierepro: "premiere",
    ai: "illustrator",
    illustrator: "illustrator",
    au: "audition",
    audition: "audition",
    ame: "media_encoder",
    mediaencoder: "media_encoder",
    media_encoder: "media_encoder",
    "media-encoder": "media_encoder",
  };
  const out: InstallableApp[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const id = aliases[part.trim().toLowerCase()];
    if (!id) throw new Error(`Unknown app "${part}". Use: ${INSTALLABLE_APPS.join(", ")}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export interface UserConfigFile {
  /** Apps whose tools are registered; missing = all. */
  enabledApps?: InstallableApp[];
  illustratorKey?: string;
  /** Adobe's Illustrator MCP endpoint; override when the shipping release moves it. */
  illustratorUrl?: string;
  httpPort?: number;
  httpHost?: string;
  httpToken?: string;
}

export function userConfigPath(): string {
  return join(homedir(), ".adobe-cc-mcp", "config.json");
}

/** The user config file, or {} when missing/malformed. */
export function readUserConfig(): UserConfigFile {
  try {
    const parsed = JSON.parse(readFileSync(userConfigPath(), "utf8")) as Record<string, unknown>;
    const out: UserConfigFile = {};
    if (Array.isArray(parsed["enabledApps"])) {
      const apps = (parsed["enabledApps"] as unknown[]).filter((a): a is InstallableApp => typeof a === "string" && (INSTALLABLE_APPS as readonly string[]).includes(a));
      out.enabledApps = apps;
    }
    if (typeof parsed["illustratorKey"] === "string") out.illustratorKey = parsed["illustratorKey"];
    if (typeof parsed["illustratorUrl"] === "string") out.illustratorUrl = parsed["illustratorUrl"];
    if (typeof parsed["httpPort"] === "number") out.httpPort = parsed["httpPort"];
    if (typeof parsed["httpHost"] === "string") out.httpHost = parsed["httpHost"];
    if (typeof parsed["httpToken"] === "string") out.httpToken = parsed["httpToken"];
    return out;
  } catch {
    return {};
  }
}

/**
 * The Illustrator delegate key: env first, then the user config file, so the
 * user can paste it once without editing the client config. "" = disabled.
 */
function illustratorKeyFromEnvOrFile(file: UserConfigFile): string {
  const fromEnv = process.env.ADOBE_CC_MCP_ILLUSTRATOR_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return file.illustratorKey ?? "";
}

function intFromEnv(name: string, fallback: number, { allowZero = false } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  const floor = allowZero ? 0 : 1;
  if (!Number.isFinite(parsed) || parsed < floor) {
    throw new Error(`${name} must be an integer >= ${floor}, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function boolFromEnv(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

function logLevelFromEnv(): LogLevel {
  const raw = process.env.ADOBE_CC_MCP_LOG_LEVEL;
  if (raw === undefined || raw === "") return "info";
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new Error(`ADOBE_CC_MCP_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${raw}`);
  }
  return raw as LogLevel;
}

export function loadConfig(): Config {
  const file = readUserConfig();
  return {
    // Port 0 is allowed so the OS can assign one (used in tests); the handshake
    // file makes the real port discoverable regardless.
    bridgePort: intFromEnv("ADOBE_CC_MCP_BRIDGE_PORT", 7897, { allowZero: true }),
    bridgeToken: process.env.ADOBE_CC_MCP_BRIDGE_TOKEN ?? "",
    bridgeInsecure: boolFromEnv("ADOBE_CC_MCP_BRIDGE_INSECURE"),
    evalTimeoutMs: intFromEnv("ADOBE_CC_MCP_EVAL_TIMEOUT_MS", 30_000),
    // 0 disables the heartbeat.
    heartbeatIntervalMs: intFromEnv("ADOBE_CC_MCP_HEARTBEAT_MS", 15_000, { allowZero: true }),
    allowRawScripts: boolFromEnv("ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS"),
    handshakeFilePath: process.env.ADOBE_CC_MCP_HANDSHAKE_FILE ?? defaultHandshakePath(),
    allowedOrigins: (process.env.ADOBE_CC_MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
    illustratorMcpUrl: process.env.ADOBE_CC_MCP_ILLUSTRATOR_URL ?? file.illustratorUrl ?? DEFAULT_ILLUSTRATOR_MCP_URL,
    illustratorMcpKey: illustratorKeyFromEnvOrFile(file),
    ffmpegPath: process.env.ADOBE_CC_MCP_FFMPEG ?? "ffmpeg",
    ffprobePath: process.env.ADOBE_CC_MCP_FFPROBE ?? "ffprobe",
    ameWebServicePath: process.env.ADOBE_CC_MCP_AME_WEBSERVICE ?? "",
    amePort: intFromEnv("ADOBE_CC_MCP_AME_PORT", 0, { allowZero: true }),
    ameIdleMs: intFromEnv("ADOBE_CC_MCP_AME_IDLE_MS", 10 * 60_000, { allowZero: true }),
    httpPort: intFromEnv("ADOBE_CC_MCP_HTTP_PORT", file.httpPort ?? 0, { allowZero: true }),
    httpHost: process.env.ADOBE_CC_MCP_HTTP_HOST ?? file.httpHost ?? "127.0.0.1",
    httpToken: process.env.ADOBE_CC_MCP_HTTP_TOKEN ?? file.httpToken ?? "",
    enabledApps: parseApps(process.env.ADOBE_CC_MCP_APPS, file.enabledApps ?? INSTALLABLE_APPS),
    logLevel: logLevelFromEnv(),
  };
}
