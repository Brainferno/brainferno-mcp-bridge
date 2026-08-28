import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import type { UserConfigFile } from "../config.js";

/**
 * Pure pieces of the installer, kept apart from the interactive CLI so they
 * can be unit-tested: config merging, the Media Encoder ini rewrite, the
 * firewall and registration command lines, and the per-platform paths.
 */

export type InstallMode = "local" | "shared";

export const DEFAULT_HTTP_PORT = 7898;

export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Non-internal IPv4 addresses, the ones other machines can reach. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

/** Apply the chosen mode to the user config file (other keys untouched). */
export function mergeUserConfig(existing: UserConfigFile, mode: InstallMode, o: { port?: number; token?: string; host?: string } = {}): UserConfigFile {
  const next: UserConfigFile = { ...existing };
  if (mode === "local") {
    delete next.httpPort;
    delete next.httpHost;
    delete next.httpToken;
    return next;
  }
  next.httpPort = o.port ?? existing.httpPort ?? DEFAULT_HTTP_PORT;
  next.httpHost = o.host ?? "0.0.0.0";
  next.httpToken = o.token ?? existing.httpToken ?? randomToken();
  return next;
}

/**
 * Media Encoder's web-service ini: local pins `ip = 127.0.0.1`; shared leaves
 * the address to the service (it picks a LAN adapter). Other lines are kept.
 */
export function rewriteAmeIni(ini: string, mode: InstallMode): string {
  const lines = ini.split(/\r?\n/);
  let seen = false;
  const out = lines.map((line) => {
    const m = /^\s*(#\s*)?ip\s*=\s*(.*)$/.exec(line);
    if (!m) return line;
    seen = true;
    return mode === "local" ? "ip = 127.0.0.1" : "#ip = 127.0.0.1";
  });
  if (!seen && mode === "local") out.unshift("ip = 127.0.0.1");
  const eol = ini.includes("\r\n") ? "\r\n" : "\n";
  return out.join(eol);
}

export interface PlatformPaths {
  cepExtensionsDir: string;
  csxsDebugCommands: string[][];
  ameIniCandidates: string[];
}

export function platformPaths(platform: NodeJS.Platform, home: string, appData?: string): PlatformPaths {
  if (platform === "win32") {
    const roaming = appData ?? join(home, "AppData", "Roaming");
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    return {
      cepExtensionsDir: join(roaming, "Adobe", "CEP", "extensions"),
      csxsDebugCommands: [11, 12, 13, 14].map((v) => ["reg", "add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]),
      ameIniCandidates: [2027, 2026, 2025, 2024].map((y) => join(pf, "Adobe", `Adobe Media Encoder ${y}`, "ame_webservice_config.ini")),
    };
  }
  if (platform === "darwin") {
    return {
      cepExtensionsDir: join(home, "Library", "Application Support", "Adobe", "CEP", "extensions"),
      csxsDebugCommands: [11, 12, 13, 14].map((v) => ["defaults", "write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]),
      ameIniCandidates: [2027, 2026, 2025, 2024].map((y) => join("/Applications", `Adobe Media Encoder ${y}`, "ame_webservice_config.ini")),
    };
  }
  return { cepExtensionsDir: join(home, ".adobe-cc-mcp", "cep-extensions-unsupported"), csxsDebugCommands: [], ameIniCandidates: [] };
}

/** Windows Defender Firewall rule for the remote port, private networks only. */
export function firewallCommands(platform: NodeJS.Platform, mode: InstallMode, port: number): string[][] {
  if (platform !== "win32") return [];
  const name = "Brainferno MCP Bridge (remote MCP)";
  const del = ["netsh", "advfirewall", "firewall", "delete", "rule", `name=${name}`];
  if (mode === "local") return [del];
  return [del, ["netsh", "advfirewall", "firewall", "add", "rule", `name=${name}`, "dir=in", "action=allow", "protocol=TCP", `localport=${port}`, "profile=private"]];
}

/** The `claude mcp add` lines to print/run. */
export function mcpAddCommands(o: { mode: InstallMode; distIndex: string; port: number; token: string; addresses: string[] }): { local: string; remote: string[] } {
  const local = `claude mcp add --scope user adobe-cc -- node "${o.distIndex}"`;
  const remote = o.mode === "shared" ? o.addresses.map((a) => `claude mcp add --scope user --transport http --header "Authorization: Bearer ${o.token}" adobe-cc http://${a}:${o.port}/mcp`) : [];
  return { local, remote };
}
