#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_ILLUSTRATOR_MCP_URL, migrateLegacyUserDir, readUserConfig, userConfigPath } from "../config.js";
import { APP_CHOICES, DEFAULT_HTTP_PORT, appsNeed, checkIllustratorKey, detectInstalledApps, extractIllustratorKey, extractIllustratorUrl, firewallCommands, lanAddresses, mcpAddCommands, mergeUserConfig, pickApps, platformPaths, rewriteAmeIni, type InstallMode } from "./lib.js";

/**
 * Interactive installer:
 *   node dist/install/cli.js [--apps ps,ae,ppro,ai,au,ame|all] [--mode local|shared] [--token T] [--port N] [--yes] [--no-panels] [--no-ame] [--no-firewall] [--register]
 *                            [--illustrator-key K|"claude mcp add … line"] [--illustrator-url U] [--no-illustrator]
 *
 * Asks one question — "only this computer" or "shared on my network" — and
 * sets every switch that depends on it: the remote MCP listener + token, the
 * Windows firewall rule, and Media Encoder's web-service address. Also wires
 * the CEP panel (junction + PlayerDebugMode) and prints the UXP steps and the
 * `claude mcp add` lines. Safe to re-run to switch modes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");
const distIndex = resolve(here, "..", "index.js");
// Installed from npm: the panels ship inside the package (panels/). From a git
// checkout: they are sibling workspaces (packages/).
const panelsDir = existsSync(join(pkgRoot, "panels")) ? join(pkgRoot, "panels") : resolve(pkgRoot, "..");
const panelCep = join(panelsDir, "panel-cep");
const panelUxp = join(panelsDir, "panel-uxp", "manifest.json");
const panelUxpPpro = join(panelsDir, "panel-uxp-ppro", "manifest.json");

const args = new Map<string, string | boolean>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith("--")) continue;
  const [k, v] = a.slice(2).split("=", 2);
  if (v !== undefined) args.set(k!, v);
  else if (process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") && ["mode", "token", "port", "host", "illustrator-key", "illustrator-url", "apps"].includes(k!)) args.set(k!, process.argv[++i]!);
  else args.set(k!, true);
}
const flag = (k: string) => args.get(k) === true;
const str = (k: string) => (typeof args.get(k) === "string" ? (args.get(k) as string) : undefined);

const say = (s = "") => console.log(s);
const ok = (s: string) => say(`  ✓ ${s}`);
const warn = (s: string) => say(`  ! ${s}`);

function run(cmd: string[], opts: { elevate?: boolean } = {}): { code: number; out: string } {
  if (opts.elevate && process.platform === "win32") {
    // One UAC prompt for the admin-only steps (Program Files, firewall).
    const ps = join(tmpdir(), `brainferno-mcp-bridge-elevated-${process.pid}.ps1`);
    writeFileSync(ps, cmd.map((c) => (/\s/.test(c) ? `"${c.replace(/"/g, '`"')}"` : c)).join(" ") + "\nexit $LASTEXITCODE\n");
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `$p = Start-Process -FilePath powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${ps}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`], { encoding: "utf8" });
    return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }
  // `claude` is a shell shim on Windows; run it through the shell as one string. Everything else is a real exe.
  const viaShell = process.platform === "win32" && cmd[0] === "claude";
  const r = viaShell
    ? spawnSync(cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" "), { encoding: "utf8", shell: true })
    : spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

async function main(): Promise<void> {
  say("");
  say("Brainferno MCP Bridge — installer");
  say("=================================");
  if (!existsSync(distIndex)) {
    warn(`server build not found at ${distIndex}; run "npm run build" first.`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string): Promise<string> => {
    if (flag("yes")) return def;
    const a = (await rl.question(`${q} [${def}] `)).trim();
    return a === "" ? def : a;
  };

  // ---- 0. which apps ------------------------------------------------------
  const migratedFrom = migrateLegacyUserDir();
  if (migratedFrom) ok(`copied your settings from ${migratedFrom} to ${dirname(userConfigPath())}`);
  const existing = readUserConfig();
  const detected = detectInstalledApps();
  const preset = existing.enabledApps ?? (detected.length ? detected : APP_CHOICES.map((c) => c.id));
  let apps = str("apps") !== undefined ? pickApps(str("apps")!, preset) : undefined;
  if (!apps) {
    if (flag("yes")) apps = [...preset];
    else {
      say("");
      say("Which applications should this server control?");
      APP_CHOICES.forEach((c, i) => say(`  ${i + 1}) ${c.label.padEnd(14)} ${detected.includes(c.id) ? "(installed)" : "(not found)"}${preset.includes(c.id) ? "  ←" : ""}`));
      const a = await ask("Numbers like 1,2,5 — or 'all'", preset.map((id) => APP_CHOICES.findIndex((c) => c.id === id) + 1).join(","));
      apps = pickApps(a, preset);
    }
  }
  if (apps.length === 0) {
    warn("no applications chosen; nothing to install");
    process.exit(1);
  }
  say("");
  say(`Apps: ${APP_CHOICES.filter((c) => apps!.includes(c.id)).map((c) => c.label).join(", ")}`);

  // ---- 1. the question ----------------------------------------------------
  let mode = str("mode") as InstallMode | undefined;
  if (!mode) {
    say("");
    say("Who may use this MCP server?");
    say("  1) Only this computer  (Claude Code on this PC; nothing listens on the network)");
    say("  2) Shared on my network (other computers connect with a token over HTTP)");
    const a = await ask("Choose 1 or 2", "1");
    mode = a === "2" ? "shared" : "local";
  }
  say("");
  say(`Mode: ${mode === "local" ? "only this computer" : "shared on my network"}`);

  // ---- 2. Illustrator MCP key (Adobe's own server inside Illustrator) ------
  let illustratorKey: string | null | undefined = undefined;
  let illustratorUrl: string | null | undefined = str("illustrator-url") ?? undefined;
  if (!flag("no-illustrator") && appsNeed(apps, "illustrator-key")) {
    let pasted = str("illustrator-key");
    if (pasted === undefined && !flag("yes")) {
      say("");
      say("Illustrator has its own MCP server (Beta today; the shipping release may change the address).");
      say("In Illustrator: Preferences → MCP (Beta) shows a 'claude mcp add … Bearer ilst_…' line.");
      say(`Paste that whole line or just the key here${existing.illustratorKey ? " (Enter keeps the saved key)" : " (Enter skips)"}.`);
      pasted = (await rl.question("Illustrator key: ")).trim();
    }
    if (pasted !== undefined && pasted !== "") {
      const key = extractIllustratorKey(pasted);
      if (!key) warn("that did not look like a key; nothing saved");
      else {
        illustratorKey = key;
        const fromLine = extractIllustratorUrl(pasted);
        if (fromLine && fromLine !== DEFAULT_ILLUSTRATOR_MCP_URL) illustratorUrl = fromLine;
      }
    }
    const keyToCheck = illustratorKey ?? existing.illustratorKey;
    const urlToCheck = illustratorUrl ?? existing.illustratorUrl ?? DEFAULT_ILLUSTRATOR_MCP_URL;
    if (keyToCheck) {
      const check = await checkIllustratorKey(urlToCheck, keyToCheck);
      if (check.ok) ok(`Illustrator MCP key accepted by ${check.serverName ?? "the server"} at ${urlToCheck}`);
      else if (check.reason === "not-running") warn(`Illustrator MCP not reachable at ${urlToCheck} (is Illustrator open with MCP enabled?) — key saved anyway`);
      else if (check.reason === "refused") warn(`Illustrator refused the key (${check.detail}) — saved anyway; re-run with the current key from Illustrator`);
      else warn(`could not verify the Illustrator key (${check.detail}) — saved anyway`);
    } else ok("Illustrator MCP delegate skipped (no key); the panel-less ai_* tools work without it");
  }

  // ---- 3. user config (remote listener + token) ---------------------------
  const port = Number(str("port") ?? existing.httpPort ?? DEFAULT_HTTP_PORT);
  const token = str("token") ?? (mode === "shared" ? existing.httpToken : undefined);
  const next = mergeUserConfig(existing, mode, {
    port,
    ...(token !== undefined ? { token } : {}),
    ...(str("host") !== undefined ? { host: str("host")! } : {}),
    ...(illustratorKey !== undefined ? { illustratorKey } : {}),
    ...(illustratorUrl !== undefined ? { illustratorUrl } : {}),
    apps,
  });
  mkdirSync(dirname(userConfigPath()), { recursive: true });
  writeFileSync(userConfigPath(), JSON.stringify(next, null, 2) + "\n");
  try {
    chmodSync(userConfigPath(), 0o600);
  } catch {
    /* Windows ACLs: the file is under the user's profile already */
  }
  ok(`wrote ${userConfigPath()}${mode === "shared" ? ` (remote port ${next.httpPort}, token set)` : " (remote mode off)"}`);

  // ---- 4. CEP panel (After Effects, Audition) -----------------------------
  const paths = platformPaths(process.platform, homedir(), process.env["APPDATA"]);
  if (!flag("no-panels") && appsNeed(apps, "cep")) {
    try {
      mkdirSync(paths.cepExtensionsDir, { recursive: true });
      const linkName = "com.brainferno.mcp-bridge.cep";
      const target = join(paths.cepExtensionsDir, linkName);
      // Drop older links to the same panel folder (the spike name), or a stale one under our name.
      for (const entry of [linkName, "com.brainferno.mcp-bridge.cep"]) {
        const p = join(paths.cepExtensionsDir, entry);
        try {
          const st = lstatSync(p);
          if (st.isSymbolicLink() || (process.platform === "win32" && st.isDirectory())) {
            let points = "";
            try {
              points = readlinkSync(p);
            } catch {
              /* junction on Windows: readlink may fail; compare by name only */
            }
            if (entry !== linkName || (points && resolve(points) !== resolve(panelCep))) {
              rmSync(p, { recursive: false, force: true });
            }
          }
        } catch {
          /* not there */
        }
      }
      if (!existsSync(target)) symlinkSync(panelCep, target, process.platform === "win32" ? "junction" : "dir");
      ok(`CEP panel linked: ${target} → ${panelCep}`);
      for (const c of paths.csxsDebugCommands) {
        const r = run(c);
        if (r.code !== 0) warn(`${c.join(" ")} failed: ${r.out.trim()}`);
      }
      ok("CEP PlayerDebugMode=1 (CSXS 11–14) so the unsigned panel loads");
    } catch (e) {
      warn(`CEP panel setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- 4. Media Encoder web-service address --------------------------------
  if (!flag("no-ame") && appsNeed(apps, "ame-ini")) {
    const ini = paths.ameIniCandidates.find((p) => existsSync(p));
    if (!ini) warn("Media Encoder not found; skipped its web-service address.");
    else {
      const current = readFileSync(ini, "utf8");
      const wanted = rewriteAmeIni(current, mode);
      if (wanted === current) ok(`Media Encoder web service already ${mode === "local" ? "pinned to 127.0.0.1" : "on the network address"} (${basename(dirname(ini))})`);
      else {
        try {
          writeFileSync(ini, wanted);
          ok(`Media Encoder web service ${mode === "local" ? "pinned to 127.0.0.1" : "set to the network address"}`);
        } catch {
          if (process.platform === "win32") {
            const tmp = join(tmpdir(), "ame_webservice_config.ini");
            writeFileSync(tmp, wanted);
            const r = run(["Copy-Item", "-Force", tmp, ini], { elevate: true });
            if (r.code === 0) ok(`Media Encoder web service ${mode === "local" ? "pinned to 127.0.0.1" : "set to the network address"} (admin)`);
            else warn(`could not write ${ini} — edit it as admin: ${mode === "local" ? "ip = 127.0.0.1" : "#ip = 127.0.0.1"}`);
          } else warn(`could not write ${ini} — edit it with sudo: ${mode === "local" ? "ip = 127.0.0.1" : "#ip = 127.0.0.1"}`);
        }
      }
    }
  }

  // ---- 5. firewall --------------------------------------------------------
  if (!flag("no-firewall")) {
    const cmds = firewallCommands(process.platform, mode, next.httpPort ?? port);
    if (cmds.length === 0) ok("firewall: nothing to do on this platform");
    else {
      const script = cmds.map((c) => c.join(" ")).join("; ");
      const r = run(["powershell", "-NoProfile", "-Command", script], { elevate: true });
      if (r.code === 0) ok(mode === "shared" ? `firewall: port ${next.httpPort} open on private networks` : "firewall: remote rule removed");
      else warn(`firewall step skipped (${r.out.trim().split("\n")[0] ?? "no admin"}). Manually: ${script}`);
    }
  }

  // ---- 6. UXP panels (Photoshop, Premiere) --------------------------------
  if (appsNeed(apps, "uxp") || appsNeed(apps, "cep")) {
    say("");
    say("Panels:");
    if (apps.includes("photoshop") || apps.includes("premiere")) say("  UXP panels load through Adobe's UXP Developer Tool (Add Plugin → manifest → Load):");
    if (apps.includes("photoshop")) say(`    Photoshop : ${panelUxp}`);
    if (apps.includes("premiere")) say(`    Premiere  : ${panelUxpPpro}   (first enable Settings → Plugins → developer mode, restart Premiere)`);
    if (apps.includes("photoshop") || apps.includes("premiere")) say("    Then Window → Extensions (UXP) → Brainferno MCP Bridge in each app.");
    if (apps.includes("after_effects") || apps.includes("audition")) say(`  ${[apps.includes("after_effects") ? "After Effects" : "", apps.includes("audition") ? "Audition" : ""].filter(Boolean).join(" / ")}: Window → Extensions → Brainferno MCP Bridge.`);
  }

  // ---- 7. register with Claude Code ---------------------------------------
  const cmds = mcpAddCommands({ mode, distIndex, port: next.httpPort ?? port, token: next.httpToken ?? "", addresses: lanAddresses() });
  say("");
  say("Claude Code on this computer:");
  say(`  ${cmds.local}`);
  const wantRegister = flag("register") || (!flag("yes") && (await ask("Run that now? (y/n)", "y")).toLowerCase().startsWith("y"));
  if (wantRegister) {
    // Replace our own entry, and retire the pre-rename alias in both scopes.
    for (const scope of ["user", "local"]) {
      run(["claude", "mcp", "remove", "--scope", scope, "brainferno"]);
      run(["claude", "mcp", "remove", "--scope", scope, "adobe-cc"]);
    }
    const r2 = run(["claude", "mcp", "add", "--scope", "user", "brainferno", "--", "node", distIndex]);
    if (r2.code === 0) ok("registered as 'brainferno' (user scope)");
    else warn(`claude mcp add failed: ${r2.out.trim().split("\n")[0] ?? ""} — run the line above yourself`);
  }
  if (mode === "shared") {
    say("");
    say(`Other computers (this machine is "${hostname()}"; the token is in ${userConfigPath()}):`);
    for (const c of cmds.remote) say(`  ${c}`);
    say("  The wire is plain HTTP: use it on a trusted LAN, a VPN, or Tailscale.");
  }
  say("");
  say("Done. Start or restart the server (in Claude Code: /mcp → brainferno → reconnect) to apply.");
  rl.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
