/**
 * The handshake file solves two problems at once for the in-app panels:
 * discovering which port the bridge bound, and learning the per-install token
 * they must present. The server writes it once it is listening; each panel
 * reads it (CEP via Node `fs`, UXP via `localFileSystem: "fullAccess"`) before
 * dialing out.
 *
 * It is written mode-600 under the user's home directory. It carries a live
 * secret, so it must never be world-readable and is removed on clean shutdown.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Handshake {
  /** Wire protocol the server speaks; panels refuse a mismatch. */
  protocolVersion: number;
  /** Loopback port the bridge is listening on. */
  port: number;
  /** Shared secret the panel must present, or "" when auth is disabled. */
  token: string;
  /** Server process id, so a panel can detect a stale file. */
  pid: number;
}

/** Default location of the handshake file. */
export function defaultHandshakePath(): string {
  return join(homedir(), ".adobe-cc-mcp", "bridge.json");
}

/** Writes the handshake file mode-600, creating its directory if needed. */
export function writeHandshake(path: string, handshake: Handshake): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(handshake, null, 2), { mode: 0o600 });
}

/** Removes the handshake file, ignoring the case where it is already gone. */
export function removeHandshake(path: string): void {
  rmSync(path, { force: true });
}
