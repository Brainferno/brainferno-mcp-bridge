// Copies the shared panel client into each panel folder. UXP plugins and CEP
// extensions must be self-contained (the host loads files from one folder), so
// the shared file is vendored in rather than imported across packages.
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "packages", "bridge-client", "bridge-client.js");
const targets = ["panel-uxp", "panel-uxp-ppro", "panel-cep"].map((p) => join(root, "packages", p, "bridge-client.js"));
for (const t of targets) {
  copyFileSync(src, t);
  console.log("synced", t.replace(root + "\\", "").replace(root + "/", ""));
}
console.log(readFileSync(src, "utf8").split("\n").length, "lines");
