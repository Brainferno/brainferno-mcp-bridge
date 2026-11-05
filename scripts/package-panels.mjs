// Packages the three panels into installable plugins under dist-packages/:
//   packages/panel-uxp      -> brainferno-mcp-bridge-photoshop-<ver>.ccx
//   packages/panel-uxp-ppro -> brainferno-mcp-bridge-premiere-<ver>.ccx
//   packages/panel-cep      -> brainferno-mcp-bridge-cep-<ver>.zxp   (AE + Audition)
//
// A CEP .zxp is code-signed here with a self-signed certificate and Adobe's
// ZXPSignCmd (downloaded on first run into the git-ignored .tools/ folder).
//
// A UXP .ccx is a plain zip of the plugin folder, built here by scripts/ccx.mjs
// with no Adobe tool. It carries no signature. What Adobe's installer (UPIA)
// needs is `host` in manifest.json as ONE object: with the list that the source
// manifests use, it refuses the file with status -267. That was the whole reason
// an earlier hand-made zip failed (see docs/quirks/panel-packaging.md). The
// version-stamped folder is kept beside each .ccx for developer loading.
//
// The version is stamped from the root package.json at package time so the
// manifests can never drift (the lesson from the 0.1.0-for-two-releases bug).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCcx } from "./ccx.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const outDir = join(root, "dist-packages");
const toolsDir = join(root, ".tools");
const stageDir = join(toolsDir, "stage");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
if (!isWin && !isMac) {
  console.error(`${process.platform} is not supported: Adobe Creative Cloud runs on Windows and macOS only.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(toolsDir, { recursive: true });

// ---- ZXPSignCmd (downloaded once) -------------------------------------------
// The 4.1.103 build ships a Windows binary only; macOS builds live in older
// version folders of the same repo, so only Windows auto-downloads. On macOS,
// point the user at the CEP-Resources repo to drop the binary in by hand.
const zxpExe = join(toolsDir, isWin ? "ZXPSignCmd.exe" : "ZXPSignCmd");
const zxpUrl = "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/ab5e4e3e53a42fad08e1225a22a991bb1ffe73f6/ZXPSignCMD/4.1.103/win64/ZXPSignCmd.exe";

async function ensureZxpSignCmd() {
  if (existsSync(zxpExe)) return;
  if (!isWin) {
    throw new Error(`ZXPSignCmd not found at ${zxpExe}. Download the macOS ZXPSignCmd from https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD, put it there, and \`chmod +x\` it.`);
  }
  console.log(`Downloading ZXPSignCmd from ${zxpUrl} …`);
  const res = await fetch(zxpUrl);
  if (!res.ok) throw new Error(`Could not download ZXPSignCmd (HTTP ${res.status}). Place it at ${zxpExe} by hand.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100_000) throw new Error(`ZXPSignCmd download looks wrong (${buf.length} bytes).`);
  writeFileSync(zxpExe, buf);
  console.log(`  saved ${zxpExe} (${buf.length} bytes)`);
}

// ---- self-signed certificate (generated once) -------------------------------
const certPath = join(toolsDir, "brainferno-selfsigned.p12");
const certPass = "brainferno"; // a self-signed side-loading cert; the password is not a secret
function ensureCert() {
  if (existsSync(certPath)) return;
  console.log("Generating a self-signed certificate …");
  execFileSync(zxpExe, ["-selfSignedCert", "US", "CA", "Brainferno", "Brainferno MCP Bridge", certPass, certPath], { stdio: "inherit" });
  console.log(`  saved ${certPath}`);
}

// ---- staging + version stamping ---------------------------------------------
function stage(name) {
  const dest = join(stageDir, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(root, "packages", name), dest, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.debug)$/.test(src) && !/\.log$/.test(src),
  });
  return dest;
}

function stampUxp(dir) {
  const mf = join(dir, "manifest.json");
  const json = JSON.parse(readFileSync(mf, "utf8"));
  json.version = version;
  writeFileSync(mf, JSON.stringify(json, null, 2) + "\n");
}

function stampCep(dir) {
  const mf = join(dir, "CSXS", "manifest.xml");
  let xml = readFileSync(mf, "utf8");
  xml = xml.replace(/ExtensionBundleVersion="[^"]*"/, `ExtensionBundleVersion="${version}"`);
  xml = xml.replace(/(<Extension Id="[^"]*" Version=)"[^"]*"/g, `$1"${version}"`);
  writeFileSync(mf, xml);
}

async function main() {
  // UXP -> .ccx, plus the version-stamped folder for developer loading. This part
  // needs no Adobe tool, so it runs first and still succeeds where ZXPSignCmd is missing.
  const ccxFiles = [];
  for (const [pkg, label] of [["panel-uxp", "photoshop"], ["panel-uxp-ppro", "premiere"]]) {
    const dir = stage(pkg);
    stampUxp(dir);
    const kept = join(outDir, `uxp-${label}-${version}`);
    rmSync(kept, { recursive: true, force: true });
    cpSync(dir, kept, { recursive: true });
    const ccx = join(outDir, `brainferno-mcp-bridge-${label}-${version}.ccx`);
    writeFileSync(ccx, buildCcx(dir, version));
    ccxFiles.push(ccx);
    console.log(`  ${ccx}`);
  }

  // CEP -> signed .zxp.
  await ensureZxpSignCmd();
  ensureCert();
  const dir = stage("panel-cep");
  stampCep(dir);
  const zxp = join(outDir, `brainferno-mcp-bridge-cep-${version}.zxp`);
  rmSync(zxp, { force: true });
  execFileSync(zxpExe, ["-sign", dir, zxp, certPath, certPass], { stdio: "inherit" });
  execFileSync(zxpExe, ["-verify", zxp, "-certInfo"], { stdio: "inherit" });
  console.log(`  ${zxp}`);

  rmSync(stageDir, { recursive: true, force: true });

  const upia = isWin
    ? "\"C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe\""
    : "\"/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/…/UnifiedPluginInstallerAgent\"";

  console.log(`\nCEP extension built (After Effects + Audition), version ${version}:`);
  console.log(`  ${zxp}`);
  console.log(`\nUXP plugins built (Photoshop, Premiere Pro), version ${version}:`);
  for (const c of ccxFiles) console.log(`  ${c}`);
  console.log("\nAdobe's UPIA installs BOTH the .ccx and the .zxp (double-clicking a .ccx also works);");
  console.log("no separate ZXP installer is needed. Close the host app and Remove any dev-loaded copy first:");
  console.log(`  ${upia} /install <file>.ccx|.zxp`);
  console.log("Or keep `npm run install-cc`, which side-loads the folders with developer mode.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
