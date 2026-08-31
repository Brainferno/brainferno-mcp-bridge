// Stamps the server package's version into the six panel version spots: the
// two UXP manifests, the CEP manifest's bundle + extension versions, and the
// PANEL_VERSION literal each panel logs and reports in its hello frame. Panels
// carry no independent version — one product version everywhere, checked by
// test/panel-versions.test.ts and by CI's drift step. Run after a bump:
//   npm run panels:stamp
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "packages", "server", "package.json"), "utf8")).version;

/** The six files and how each carries the version. Shared with the test. */
export function panelVersionSpots(repoRoot) {
  return [
    { file: join(repoRoot, "packages", "panel-uxp", "manifest.json"), kind: "uxp-manifest" },
    { file: join(repoRoot, "packages", "panel-uxp-ppro", "manifest.json"), kind: "uxp-manifest" },
    { file: join(repoRoot, "packages", "panel-cep", "CSXS", "manifest.xml"), kind: "cep-manifest" },
    { file: join(repoRoot, "packages", "panel-uxp", "main.js"), kind: "panel-version-const" },
    { file: join(repoRoot, "packages", "panel-uxp-ppro", "main.js"), kind: "panel-version-const" },
    { file: join(repoRoot, "packages", "panel-cep", "main.js"), kind: "panel-version-const" },
  ];
}

/** The version(s) a spot currently carries. */
export function readSpotVersions(spot) {
  const text = readFileSync(spot.file, "utf8");
  if (spot.kind === "uxp-manifest") return [JSON.parse(text).version];
  if (spot.kind === "cep-manifest") {
    return [...text.matchAll(/(?:ExtensionBundleVersion="|<Extension [^>]*Version=")([^"]+)"/g)].map((m) => m[1]);
  }
  return [...text.matchAll(/const PANEL_VERSION = "([^"]+)"/g)].map((m) => m[1]);
}

function stamp(spot, v) {
  const text = readFileSync(spot.file, "utf8");
  let next;
  if (spot.kind === "uxp-manifest") {
    next = text.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`);
  } else if (spot.kind === "cep-manifest") {
    next = text.replace(/(ExtensionBundleVersion=")[^"]+(")/g, `$1${v}$2`).replace(/(<Extension [^>]*Version=")[^"]+(")/g, `$1${v}$2`);
  } else {
    next = text.replace(/(const PANEL_VERSION = ")[^"]+(")/, `$1${v}$2`);
  }
  if (next === text) return false;
  writeFileSync(spot.file, next);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const spot of panelVersionSpots(root)) {
    const changed = stamp(spot, version);
    console.log(`${changed ? "stamped" : "already"} ${version}  ${spot.file.slice(root.length + 1)}`);
  }
}
