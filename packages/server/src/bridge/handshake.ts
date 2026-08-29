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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The handshake currently on disk, or null when it is missing or unreadable. */
export function readHandshake(path: string): Handshake | null {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<Handshake>;
    if (typeof p.port !== "number" || typeof p.pid !== "number" || typeof p.token !== "string" || typeof p.protocolVersion !== "number") return null;
    return { protocolVersion: p.protocolVersion, port: p.port, token: p.token, pid: p.pid };
  } catch {
    return null;
  }
}

/** Whether a process id is running. `signal 0` only checks; EPERM means it exists but is not ours. */
export function pidAlive(pid: number, kill: (pid: number, signal: number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the handshake file — but only when it is still ours. A second server
 * instance (another editor session, a stray `npm start`) overwrites the file with
 * its own port and token; when that one exits it must not delete the entry the
 * still-running first server put there, or every panel reload would find nothing.
 */
export function removeHandshake(path: string, ownPid: number = process.pid): void {
  const current = readHandshake(path);
  if (current !== null && current.pid !== ownPid) return;
  rmSync(path, { force: true });
}
