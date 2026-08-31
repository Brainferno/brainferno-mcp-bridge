import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/version.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/**
 * The real packaging script against the real panel folders: a .ccx must be a
 * zip with manifest.json at its root, carry the stamped version, include the
 * vendored bridge client, and leave the repo junk out. cep.zxp needs Adobe's
 * ZXPSignCmd, absent on CI — the script must skip it without failing.
 */
describe("package-panels", () => {
  it("builds installable .ccx files for both UXP panels", () => {
    const out = mkdtempSync(join(tmpdir(), "bf-ccx-"));
    const r = spawnSync(process.execPath, [join(root, "scripts", "package-panels.mjs"), "--out", out], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    for (const name of ["photoshop.ccx", "premiere.ccx"]) {
      const file = join(out, name);
      expect(existsSync(file), name).toBe(true);
      const zip = new AdmZip(file);
      const entries = zip.getEntries().map((e) => e.entryName);
      expect(entries).toContain("manifest.json");
      expect(entries).toContain("main.js");
      expect(entries).toContain("bridge-client.js");
      expect(entries).not.toContain("README.md");
      const manifest = JSON.parse(zip.readAsText("manifest.json")) as { version: string; id: string };
      expect(manifest.version).toBe(SERVER_VERSION);
      expect(manifest.id).toBe(name === "photoshop.ccx" ? "com.brainferno.mcp-bridge.photoshop" : "com.brainferno.mcp-bridge.premiere");
    }
    // No ZXPSignCmd here: the zxp is skipped with a warning, never a failure.
    if (!existsSync(join(out, "cep.zxp"))) expect(r.stderr).toContain("ZXPSignCmd not found");
  });
});
