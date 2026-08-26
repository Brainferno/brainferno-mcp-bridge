/** Runtime configuration, read once at startup from the environment. */

export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

export interface Config {
  /** TCP port the in-app panels dial back to. */
  bridgePort: number;
  /** Shared secret a panel must present on connect. Empty disables auth. */
  bridgeToken: string;
  /** How long to wait for a script result before rejecting. */
  evalTimeoutMs: number;
  logLevel: LogLevel;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
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
    bridgePort: intFromEnv("ADOBE_CC_MCP_BRIDGE_PORT", 7777),
    bridgeToken: process.env.ADOBE_CC_MCP_BRIDGE_TOKEN ?? "",
    evalTimeoutMs: intFromEnv("ADOBE_CC_MCP_EVAL_TIMEOUT_MS", 30_000),
    logLevel: logLevelFromEnv(),
  };
}
