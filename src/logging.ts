import type { LogLevel } from "./config.js";

/**
 * stdout is the MCP wire when running over stdio, so every diagnostic goes to
 * stderr. Writing a stray console.log anywhere in this server corrupts the
 * protocol stream — always use this logger.
 */

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (RANK[level] > RANK[threshold]) return;
  const line = `[adobe-cc-mcp] ${level.toUpperCase()} ${message}`;
  process.stderr.write(detail === undefined ? `${line}\n` : `${line} ${format(detail)}\n`);
}

function format(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export const log = {
  error: (message: string, detail?: unknown) => emit("error", message, detail),
  warn: (message: string, detail?: unknown) => emit("warn", message, detail),
  info: (message: string, detail?: unknown) => emit("info", message, detail),
  debug: (message: string, detail?: unknown) => emit("debug", message, detail),
};
