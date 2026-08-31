import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/version.js";

/**
 * Panels carry no independent version: the two UXP manifests, the CEP
 * manifest, and each panel's PANEL_VERSION literal must all equal the server
 * package's version. `npm run panels:stamp` writes them; this test is what
 * fails when a bump forgets it — the version-drift lesson, applied to panels.
 */
describe("panel versions", () => {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  const all = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1] ?? "");

  it("all six panel version spots equal the server version", () => {
    const spots: [string, string[]][] = [
      ["packages/panel-uxp/manifest.json", [JSON.parse(readFileSync(join(root, "packages/panel-uxp/manifest.json"), "utf8")).version as string]],
      ["packages/panel-uxp-ppro/manifest.json", [JSON.parse(readFileSync(join(root, "packages/panel-uxp-ppro/manifest.json"), "utf8")).version as string]],
      ["packages/panel-cep/CSXS/manifest.xml", all(readFileSync(join(root, "packages/panel-cep/CSXS/manifest.xml"), "utf8"), /(?:ExtensionBundleVersion="|<Extension [^>]*Version=")([^"]+)"/g)],
      ["packages/panel-uxp/main.js", all(readFileSync(join(root, "packages/panel-uxp/main.js"), "utf8"), /const PANEL_VERSION = "([^"]+)"/g)],
      ["packages/panel-uxp-ppro/main.js", all(readFileSync(join(root, "packages/panel-uxp-ppro/main.js"), "utf8"), /const PANEL_VERSION = "([^"]+)"/g)],
      ["packages/panel-cep/main.js", all(readFileSync(join(root, "packages/panel-cep/main.js"), "utf8"), /const PANEL_VERSION = "([^"]+)"/g)],
    ];
    for (const [file, versions] of spots) {
      expect(versions.length, file).toBeGreaterThan(0);
      for (const v of versions) expect(v, `${file} — run: npm run panels:stamp`).toBe(SERVER_VERSION);
    }
  });
});
