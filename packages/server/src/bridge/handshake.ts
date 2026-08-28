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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  return join(homedir(), ".brainferno-mcp-bridge", "bridge.json");
}

/**
 * Writes the handshake file mode-600, creating its directory if needed.
 *
 * The default write flag ("w") follows symlinks and applies its mode only when
 * creating a new file — so a pre-existing (or symlinked) file could see the
 * token written through it with looser permissions. Remove any existing entry
 * first and create exclusively ("wx", i.e. O_CREAT|O_EXCL, which refuses to
 * follow an existing symlink) so the secret always lands in a fresh 600 file.
 */
export function writeHandshake(path: string, handshake: Handshake): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(handshake, null, 2), { mode: 0o600, flag: "wx" });
}

/** Removes the handshake file, ignoring the case where it is already gone. */
export function removeHandshake(path: string): void {
  rmSync(path, { force: true });
}
