/** Runtime configuration, read once at startup from the environment. */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultHandshakePath } from "./bridge/handshake.js";

export const DEFAULT_ILLUSTRATOR_MCP_URL = "http://localhost:18412/v1/mcp";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/**
 * How preview tools return images: "both" (image block + file path, the
 * default), "inline" (image block only), or "path" (file path only — for MCP
 * clients that cannot show the model image content, e.g. Codex CLI).
 */
export type PreviewMode = "inline" | "path" | "both";

const PREVIEW_MODES: readonly PreviewMode[] = ["inline", "path", "both"];

const LEGACY_ENV_PREFIX = "ADOBE_CC_MCP_";
const warnedLegacy = new Set<string>();
/** Read BRAINFERNO_MCP_X, falling back to the pre-rename ADOBE_CC_MCP_X with a one-time warning. */
export function envValue(name: string): string | undefined {
  const v = process.env[name];
  if (v !== undefined) return v;
  const legacy = name.replace(/^BRAINFERNO_MCP_/, LEGACY_ENV_PREFIX);
  const l = process.env[legacy];
  if (l !== undefined && !warnedLegacy.has(legacy)) {
    warnedLegacy.add(legacy);
    console.error(`[brainferno-mcp-bridge] WARN ${legacy} is deprecated; rename it to ${name}`);
  }
  return l;
}

/** Settings live in ~/.brainferno-mcp-bridge; copy config.json from the pre-rename ~/.adobe-cc-mcp once. */
export function migrateLegacyUserDir(home: string = homedir()): string | null {
  const next = join(home, ".brainferno-mcp-bridge");
  const old = join(home, ".adobe-cc-mcp");
  try {
    if (!existsSync(join(next, "config.json")) && existsSync(join(old, "config.json"))) {
      mkdirSync(next, { recursive: true });
      copyFileSync(join(old, "config.json"), join(next, "config.json"));
      try { chmodSync(join(next, "config.json"), 0o600); } catch { /* Windows */ }
      return old;
    }
  } catch {
    /* best effort */
  }
  return null;
}

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
  /**
   * Which Illustrator the os-script lane drives: an AppleScript name, a bundle id
   * (`com.adobe.illustrator`, `com.adobe.illustratorBeta`) or an absolute `.app` path on macOS;
   * a COM ProgID on Windows. "" = the app default. Pin it when the release and the Beta are both
   * installed: their bundles share the name `Adobe Illustrator.app`, so a bare name resolves to
   * whichever one LaunchServices picks.
   */
  illustratorApp: string;
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
  /** Which applications get their tools registered (installer choice; env BRAINFERNO_MCP_APPS overrides). */
  enabledApps: InstallableApp[];
  logLevel: LogLevel;
  /**
   * Whether long tools (renders, exports, pipelines) block until done when the
   * caller does not pass `wait`. False suits clients with short tool timeouts
   * (Codex CLI kills calls at 60s by default): tools return a jobId at once and
   * the client polls cc_job_wait. Set per client in its MCP registration env.
   */
  defaultWait: boolean;
  /** How preview tools return images; see {@link PreviewMode}. */
  preview: PreviewMode;
  /** Default cc_job_wait timeout, seconds. Keep below the client's tool timeout. */
  jobWaitSeconds: number;
}

/** Keys the installer may write to `~/.brainferno-mcp-bridge/config.json` (mode 600). */
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
  /** Which Illustrator the os-script lane drives (name, bundle id, or .app path); see Config.illustratorApp. */
  illustratorApp?: string;
  /** Adobe's Illustrator MCP endpoint; override when the shipping release moves it. */
  illustratorUrl?: string;
  httpPort?: number;
  httpHost?: string;
  httpToken?: string;
}

export function userConfigPath(): string {
  return join(homedir(), ".brainferno-mcp-bridge", "config.json");
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
    if (typeof parsed["illustratorApp"] === "string") out.illustratorApp = parsed["illustratorApp"];
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
  const fromEnv = envValue("BRAINFERNO_MCP_ILLUSTRATOR_KEY");
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return file.illustratorKey ?? "";
}

function intFromEnv(name: string, fallback: number, { allowZero = false } = {}): number {
  const raw = envValue(name);
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  const floor = allowZero ? 0 : 1;
  if (!Number.isFinite(parsed) || parsed < floor) {
    throw new Error(`${name} must be an integer >= ${floor}, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function boolFromEnv(name: string, fallback = false): boolean {
  const raw = envValue(name);
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true";
}

function previewFromEnv(): PreviewMode {
  const raw = envValue("BRAINFERNO_MCP_PREVIEW");
  if (raw === undefined || raw === "") return "both";
  if (!PREVIEW_MODES.includes(raw as PreviewMode)) {
    throw new Error(`BRAINFERNO_MCP_PREVIEW must be one of ${PREVIEW_MODES.join(", ")}, got ${raw}`);
  }
  return raw as PreviewMode;
}

function logLevelFromEnv(): LogLevel {
  const raw = envValue("BRAINFERNO_MCP_LOG_LEVEL");
  if (raw === undefined || raw === "") return "info";
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new Error(`BRAINFERNO_MCP_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${raw}`);
  }
  return raw as LogLevel;
}

export function loadConfig(): Config {
  const file = readUserConfig();
  return {
    // Port 0 is allowed so the OS can assign one (used in tests); the handshake
    // file makes the real port discoverable regardless.
    bridgePort: intFromEnv("BRAINFERNO_MCP_BRIDGE_PORT", 7897, { allowZero: true }),
    bridgeToken: envValue("BRAINFERNO_MCP_BRIDGE_TOKEN") ?? "",
    bridgeInsecure: boolFromEnv("BRAINFERNO_MCP_BRIDGE_INSECURE"),
    evalTimeoutMs: intFromEnv("BRAINFERNO_MCP_EVAL_TIMEOUT_MS", 30_000),
    // 0 disables the heartbeat.
    heartbeatIntervalMs: intFromEnv("BRAINFERNO_MCP_HEARTBEAT_MS", 15_000, { allowZero: true }),
    allowRawScripts: boolFromEnv("BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS"),
    handshakeFilePath: envValue("BRAINFERNO_MCP_HANDSHAKE_FILE") ?? defaultHandshakePath(),
    allowedOrigins: (envValue("BRAINFERNO_MCP_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
    illustratorMcpUrl: envValue("BRAINFERNO_MCP_ILLUSTRATOR_URL") ?? file.illustratorUrl ?? DEFAULT_ILLUSTRATOR_MCP_URL,
    illustratorMcpKey: illustratorKeyFromEnvOrFile(file),
    illustratorApp: envValue("BRAINFERNO_MCP_ILLUSTRATOR_APP") ?? file.illustratorApp ?? "",
    ffmpegPath: envValue("BRAINFERNO_MCP_FFMPEG") ?? "ffmpeg",
    ffprobePath: envValue("BRAINFERNO_MCP_FFPROBE") ?? "ffprobe",
    ameWebServicePath: envValue("BRAINFERNO_MCP_AME_WEBSERVICE") ?? "",
    amePort: intFromEnv("BRAINFERNO_MCP_AME_PORT", 0, { allowZero: true }),
    ameIdleMs: intFromEnv("BRAINFERNO_MCP_AME_IDLE_MS", 10 * 60_000, { allowZero: true }),
    httpPort: intFromEnv("BRAINFERNO_MCP_HTTP_PORT", file.httpPort ?? 0, { allowZero: true }),
    httpHost: envValue("BRAINFERNO_MCP_HTTP_HOST") ?? file.httpHost ?? "127.0.0.1",
    httpToken: envValue("BRAINFERNO_MCP_HTTP_TOKEN") ?? file.httpToken ?? "",
    enabledApps: parseApps(envValue("BRAINFERNO_MCP_APPS"), file.enabledApps ?? INSTALLABLE_APPS),
    logLevel: logLevelFromEnv(),
    defaultWait: boolFromEnv("BRAINFERNO_MCP_DEFAULT_WAIT", true),
    preview: previewFromEnv(),
    jobWaitSeconds: intFromEnv("BRAINFERNO_MCP_JOB_WAIT_SECONDS", 300),
  };
}
