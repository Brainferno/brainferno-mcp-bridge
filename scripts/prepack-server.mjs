// Runs before `npm pack` / `npm publish` of packages/server: the published
// package must be self-contained, so the three panels, their installables
// (panels/dist: .ccx and, when ZXPSignCmd is available, .zxp) and the
// top-level license/notice/readme files are copied in. The copies are
// git-ignored.
import { cpSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packagePanels } from "./package-panels.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(root, "packages", "server");
const panels = join(pkg, "panels");

rmSync(panels, { recursive: true, force: true });
mkdirSync(panels, { recursive: true });
for (const p of ["panel-uxp", "panel-uxp-ppro", "panel-cep"]) {
  cpSync(join(root, "packages", p), join(panels, p), {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.debug)$/.test(src) && !/\.log$/.test(src),
  });
  console.log("panels/" + p);
}
// A CI build (publish.yml) leaves signed installables in dist-panels/; a local
// pack builds them here (cep.zxp skipped without ZXPSignCmd).
const distPanels = join(root, "dist-panels");
if (!existsSync(distPanels)) packagePanels({ outDir: distPanels });
cpSync(distPanels, join(panels, "dist"), { recursive: true });
console.log("panels/dist");
for (const f of ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md"]) {
  if (existsSync(join(root, f))) {
    copyFileSync(join(root, f), join(pkg, f));
    console.log(f);
  }
}
