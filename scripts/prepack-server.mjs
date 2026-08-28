// Runs before `npm pack` / `npm publish` of packages/server: the published
// package must be self-contained, so the three panels and the top-level
// license/notice/readme files are copied in. The copies are git-ignored.
import { cpSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
for (const f of ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md"]) {
  if (existsSync(join(root, f))) {
    copyFileSync(join(root, f), join(pkg, f));
    console.log(f);
  }
}
