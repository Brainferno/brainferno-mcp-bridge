/** Runtime configuration, read once at startup from the environment. */

import { defaultHandshakePath } from "./bridge/handshake.js";

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
  logLevel: LogLevel;
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
    logLevel: logLevelFromEnv(),
  };
}
