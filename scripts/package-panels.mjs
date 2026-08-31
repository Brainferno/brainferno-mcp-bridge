// Builds the installable panels: photoshop.ccx and premiere.ccx (a .ccx is a
// zip of the plugin folder with manifest.json at the zip root, installed by
// Creative Cloud on double-click or by the Unified Plugin Installer Agent) and
// cep.zxp (the CEP panel signed with ZXPSignCmd — CEP checks package
// integrity, not chain trust, so a self-signed certificate installs the same
// as a paid one). Usage:
//   node scripts/package-panels.mjs [--out DIR] [--require-zxp]
// Env: ZXPSIGNCMD (path to Adobe's ZXPSignCmd; also searched on PATH),
// BRAINFERNO_ZXP_P12 + BRAINFERNO_ZXP_PASSWORD (the release certificate;
// without them a throwaway self-signed certificate is generated per run).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

import { panelVersionSpots, readSpotVersions } from "./stamp-panel-versions.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Same junk filter as prepack-server.mjs, plus the per-panel README.
const excluded = (relPath) => /(^|[\\/])(node_modules([\\/]|$)|\.debug$|README\.md$)/.test(relPath) || /\.log$/.test(relPath);

/** Refuse to package a version that drifted from packages/server/package.json. */
export function assertVersionsStamped(repoRoot, version) {
  for (const spot of panelVersionSpots(repoRoot)) {
    for (const v of readSpotVersions(spot)) {
      if (v !== version) throw new Error(`${spot.file} carries ${v}, package is ${version} — run: npm run panels:stamp`);
    }
  }
}

/** Zip a UXP panel folder into a .ccx, manifest.json at the zip root. */
export function buildCcx(panelDir, outFile) {
  const zip = new AdmZip();
  zip.addLocalFolder(panelDir, "", (p) => !excluded(p));
  rmSync(outFile, { force: true });
  zip.writeZip(outFile);
}

export function findZxpSignCmd() {
  const fromEnv = process.env.ZXPSIGNCMD;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const exe = process.platform === "win32" ? "ZXPSignCmd.exe" : "ZXPSignCmd";
  return spawnSync(exe, ["-help"], { encoding: "utf8" }).error ? null : exe;
}

/** Sign the CEP panel into a .zxp; without a release cert, self-sign per run. */
export function signCep(zxpSignCmd, panelDir, outFile) {
  let p12 = process.env.BRAINFERNO_ZXP_P12;
  let password = process.env.BRAINFERNO_ZXP_PASSWORD;
  if (!p12 || !password) {
    p12 = join(mkdtempSync(join(tmpdir(), "brainferno-zxp-")), "self-signed.p12");
    password = randomBytes(12).toString("hex");
    const made = spawnSync(zxpSignCmd, ["-selfSignedCert", "US", "NY", "Brainferno", "Brainferno MCP Bridge", password, p12], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`ZXPSignCmd -selfSignedCert failed: ${(made.stdout ?? "") + (made.stderr ?? "")}`);
  }
  rmSync(outFile, { force: true });
  const sign = (extra) => spawnSync(zxpSignCmd, ["-sign", panelDir, outFile, p12, password, ...extra], { encoding: "utf8" });
  // The timestamp keeps the signature valid past the cert; sign without one when the TSA is unreachable.
  let r = sign(["-tsa", "http://timestamp.digicert.com"]);
  if (r.status !== 0) r = sign([]);
  if (r.status !== 0) throw new Error(`ZXPSignCmd -sign failed: ${(r.stdout ?? "") + (r.stderr ?? "")}`);
}

/** Build every installable into outDir. Returns the files written. */
export function packagePanels({ outDir, requireZxp = false } = {}) {
  const version = JSON.parse(readFileSync(join(root, "packages", "server", "package.json"), "utf8")).version;
  assertVersionsStamped(root, version);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [panel, out] of [["panel-uxp", "photoshop.ccx"], ["panel-uxp-ppro", "premiere.ccx"]]) {
    const file = join(outDir, out);
    buildCcx(join(root, "packages", panel), file);
    written.push(file);
  }
  const zxpSignCmd = findZxpSignCmd();
  if (!zxpSignCmd) {
    const msg = "ZXPSignCmd not found (set ZXPSIGNCMD or put it on PATH): cep.zxp not built";
    if (requireZxp) throw new Error(msg);
    console.warn(`warning: ${msg}`);
  } else {
    const file = join(outDir, "cep.zxp");
    signCep(zxpSignCmd, join(root, "packages", "panel-cep"), file);
    written.push(file);
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : join(root, "dist-panels");
  const files = packagePanels({ outDir, requireZxp: args.includes("--require-zxp") });
  for (const f of files) console.log(basename(f) + "  ->  " + f);
}
