import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join, posix, win32 } from "node:path";

import { existsSync, readdirSync } from "node:fs";

import { INSTALLABLE_APPS, parseApps, type InstallableApp, type UserConfigFile } from "../config.js";

export interface AppChoice {
  id: InstallableApp;
  label: string;
  /** Regex on the install folder name (Program Files\Adobe on Windows, /Applications on macOS). */
  folder: RegExp;
  /** What the installer has to set up for it. */
  needs: ("cep" | "uxp" | "illustrator-key" | "ame-ini")[];
}

export const APP_CHOICES: readonly AppChoice[] = [
  { id: "photoshop", label: "Photoshop", folder: /^Adobe Photoshop/i, needs: ["uxp"] },
  { id: "after_effects", label: "After Effects", folder: /^Adobe After Effects/i, needs: ["cep"] },
  { id: "premiere", label: "Premiere Pro", folder: /^Adobe Premiere Pro/i, needs: ["uxp"] },
  { id: "illustrator", label: "Illustrator", folder: /^Adobe Illustrator/i, needs: ["illustrator-key"] },
  { id: "audition", label: "Audition", folder: /^Adobe Audition/i, needs: ["cep"] },
  { id: "media_encoder", label: "Media Encoder", folder: /^Adobe Media Encoder/i, needs: ["ame-ini"] },
];

/** Which of the six are installed, judged by their app folders. */
export function detectInstalledApps(platform: NodeJS.Platform = process.platform): InstallableApp[] {
  const root = platform === "win32" ? join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Adobe") : platform === "darwin" ? "/Applications" : "";
  if (!root || !existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return APP_CHOICES.filter((c) => names.some((n) => c.folder.test(n))).map((c) => c.id);
}

/** "1,3,5", "1 3", "all", or app names → app ids (in canonical order). */
export function pickApps(answer: string, fallback: readonly InstallableApp[]): InstallableApp[] {
  const a = answer.trim().toLowerCase();
  if (a === "" ) return [...fallback];
  if (a === "all" || a === "*") return [...INSTALLABLE_APPS];
  if (/^[\d,\s]+$/.test(a)) {
    const idx = a.split(/[,\s]+/).filter(Boolean).map(Number);
    return APP_CHOICES.filter((_, i) => idx.includes(i + 1)).map((c) => c.id);
  }
  // Names like "ps, ae" — the config parser throws on unknown names.
  return parseApps(answer);
}

export function appsNeed(apps: readonly InstallableApp[], need: AppChoice["needs"][number]): boolean {
  return APP_CHOICES.some((c) => apps.includes(c.id) && c.needs.includes(need));
}

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

/**
 * The Illustrator MCP key as the user pasted it: either the bare `ilst_…` key or
 * the whole `claude mcp add … --header "Authorization: Bearer ilst_…" …` line
 * Illustrator shows. Returns null when nothing key-like is in there.
 */
export function extractIllustratorKey(input: string): string | null {
  const s = input.trim();
  if (s === "") return null;
  const bearer = /Bearer\s+([A-Za-z0-9_.-]+)/i.exec(s);
  if (bearer) return bearer[1] ?? null;
  if (/^[A-Za-z0-9_.-]{12,}$/.test(s)) return s;
  return null;
}

/** The endpoint URL from a pasted `claude mcp add` line, if it carries one. */
export function extractIllustratorUrl(input: string): string | null {
  const m = /(https?:\/\/[^\s"']+\/mcp)\b/i.exec(input);
  return m ? (m[1] ?? null) : null;
}

export type IllustratorKeyCheck = { ok: true; serverName: string | null } | { ok: false; reason: "not-running" | "refused" | "unexpected"; detail: string };

/** Try an MCP initialize against Adobe's Illustrator endpoint with the key. */
export async function checkIllustratorKey(url: string, key: string, timeoutMs = 4000): Promise<IllustratorKeyCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "brainferno-mcp-bridge-installer", version: "0.1.0" } } }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "refused", detail: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: "unexpected", detail: `HTTP ${res.status}` };
    const text = await res.text();
    const m = /"serverInfo"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/.exec(text);
    return { ok: true, serverName: m ? (m[1] ?? null) : null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /ECONNREFUSED|abort|fetch failed/i.test(msg) ? "not-running" : "unexpected", detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Apply the chosen mode to the user config file (other keys untouched). */
export function mergeUserConfig(existing: UserConfigFile, mode: InstallMode, o: { port?: number; token?: string; host?: string; illustratorKey?: string | null; illustratorUrl?: string | null; illustratorApp?: string | null; apps?: readonly InstallableApp[] } = {}): UserConfigFile {
  const next: UserConfigFile = { ...existing };
  if (o.apps !== undefined) {
    const all = INSTALLABLE_APPS.every((a) => o.apps!.includes(a));
    if (all) delete next.enabledApps;
    else next.enabledApps = INSTALLABLE_APPS.filter((a) => o.apps!.includes(a));
  }
  if (o.illustratorKey !== undefined) {
    if (o.illustratorKey === null) delete next.illustratorKey;
    else next.illustratorKey = o.illustratorKey;
  }
  if (o.illustratorUrl !== undefined) {
    if (o.illustratorUrl === null) delete next.illustratorUrl;
    else next.illustratorUrl = o.illustratorUrl;
  }
  if (o.illustratorApp !== undefined) {
    if (o.illustratorApp === null) delete next.illustratorApp;
    else next.illustratorApp = o.illustratorApp;
  }
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

export interface IllustratorInstall {
  /** Bundle path, e.g. /Applications/Adobe Illustrator 2026/Adobe Illustrator.app */
  path: string;
  /** Bundle id: com.adobe.illustrator (release) or com.adobe.illustratorBeta. */
  bundleId: string;
  /** The folder Adobe installed it in, e.g. "Adobe Illustrator 2026" or "Adobe Illustrator (Beta)". */
  label: string;
  beta: boolean;
}

/**
 * Illustrator bundles under /Applications, newest-looking first, release before Beta.
 * Both bundles are named `Adobe Illustrator.app`, so an AppleScript *name* resolves to whichever
 * one LaunchServices picks; the os-script lane is pinned to a bundle id instead (config
 * `illustratorApp`). `readBundleId` is injectable for tests.
 */
export function findIllustratorApps(platform: NodeJS.Platform, appsRoot: string, readBundleId: (bundlePath: string) => string | null): IllustratorInstall[] {
  if (platform !== "darwin") return [];
  let names: string[];
  try {
    names = readdirSync(appsRoot);
  } catch {
    return [];
  }
  const found: IllustratorInstall[] = [];
  for (const label of names.filter((n) => /^Adobe Illustrator/i.test(n)).sort().reverse()) {
    const path = join(appsRoot, label, "Adobe Illustrator.app");
    if (!existsSync(path)) continue;
    const bundleId = readBundleId(path);
    if (!bundleId) continue;
    found.push({ path, bundleId, label, beta: /beta/i.test(label) || /beta$/i.test(bundleId) });
  }
  return found.sort((a, b) => Number(a.beta) - Number(b.beta));
}

/** Seed for a Media Encoder ini that does not exist yet (macOS): the console's default port, no address pin. */
export const AME_INI_SEED = "port = 8080\n";

/**
 * AppleScript that has Finder copy `src` into `destDir` (replacing). macOS "App Management"
 * blocks writes into app bundles from a terminal, even with sudo; Finder is allowed.
 */
export function finderCopyScript(src: string, destDir: string): string {
  const q = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application "Finder" to duplicate file (POSIX file "${q(src)}" as alias) to folder (POSIX file "${q(destDir)}" as alias) with replacing`;
}

export interface PlatformPaths {
  cepExtensionsDir: string;
  csxsDebugCommands: string[][];
  ameIniCandidates: string[];
}

/** Explicit path flavours: a platform's paths must come out the same whichever OS computes them. */
export function platformPaths(platform: NodeJS.Platform, home: string, appData?: string): PlatformPaths {
  if (platform === "win32") {
    const roaming = appData ?? win32.join(home, "AppData", "Roaming");
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    return {
      cepExtensionsDir: win32.join(roaming, "Adobe", "CEP", "extensions"),
      csxsDebugCommands: [11, 12, 13, 14].map((v) => ["reg", "add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]),
      ameIniCandidates: [2027, 2026, 2025, 2024].map((y) => win32.join(pf, "Adobe", `Adobe Media Encoder ${y}`, "ame_webservice_config.ini")),
    };
  }
  if (platform === "darwin") {
    return {
      cepExtensionsDir: posix.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions"),
      csxsDebugCommands: [11, 12, 13, 14].map((v) => ["defaults", "write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]),
      // The console reads the ini from the app bundle's Resources folder (see drivers/ame-webservice.ts); Adobe ships none.
      ameIniCandidates: [2027, 2026, 2025, 2024].map((y) => posix.join("/Applications", `Adobe Media Encoder ${y}`, `Adobe Media Encoder ${y}.app`, "Contents", "Resources", "ame_webservice_config.ini")),
    };
  }
  return { cepExtensionsDir: posix.join(home, ".brainferno-mcp-bridge", "cep-extensions-unsupported"), csxsDebugCommands: [], ameIniCandidates: [] };
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
  const local = `claude mcp add --scope user brainferno -- node "${o.distIndex}"`;
  const remote = o.mode === "shared" ? o.addresses.map((a) => `claude mcp add --scope user --transport http --header "Authorization: Bearer ${o.token}" brainferno http://${a}:${o.port}/mcp`) : [];
  return { local, remote };
}
