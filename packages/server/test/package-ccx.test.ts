import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/version.js";

interface CcxModule {
  buildCcx(dir: string, version: string): Buffer;
  ccxManifest(manifest: Record<string, unknown>, version: string): Record<string, unknown>;
  listPanelFiles(dir: string): string[];
  zip(entries: { name: string; data: Buffer }[]): Buffer;
  crc32(buf: Buffer): number;
}

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
// scripts/ccx.mjs is plain JavaScript outside the TypeScript project, so it is loaded by path.
const load = async (): Promise<CcxModule> => (await import(pathToFileURL(join(root, "scripts", "ccx.mjs")).href)) as CcxModule;

/** A reader for the zip files that scripts/ccx.mjs writes: central directory first, then each entry. */
function unzip(buf: Buffer): { name: string; data: Buffer; method: number; crc: number }[] {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(buf.readUInt32LE(localAt)).toBe(0x04034b50);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compSize);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw), method, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * `npm run package` builds the Photoshop and Premiere Pro panels as .ccx files with no Adobe
 * tool. Adobe's installer accepts such a file only when `host` in manifest.json is one object
 * (a list is refused with status -267; see docs/quirks/panel-packaging.md), so that shape is
 * what these tests pin down.
 */
describe("scripted .ccx packages", () => {
  for (const panel of ["panel-uxp", "panel-uxp-ppro"]) {
    it(`${panel}: manifest first, host as one object, every panel file byte for byte`, async () => {
      const { buildCcx, listPanelFiles, crc32 } = await load();
      const dir = join(root, "packages", panel);
      const entries = unzip(buildCcx(dir, SERVER_VERSION));

      expect(entries[0]?.name).toBe("manifest.json");
      const manifest = JSON.parse(entries[0]!.data.toString("utf8")) as { version: string; host: unknown; id: string };
      const source = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { host: unknown[]; id: string };
      expect(Array.isArray(manifest.host)).toBe(false);
      expect(manifest.host).toEqual(source.host[0]);
      expect(manifest.version).toBe(SERVER_VERSION);
      expect(manifest.id).toBe(source.id);

      const files = listPanelFiles(dir);
      expect(entries.map((e) => e.name).sort()).toEqual([...files].sort());
      for (const e of entries) {
        expect(e.name.includes("\\")).toBe(false);
        expect(e.name.endsWith("/")).toBe(false);
        expect(e.method).toBe(8);
        expect(e.crc).toBe(crc32(e.data));
        if (e.name !== "manifest.json") expect(e.data.equals(readFileSync(join(dir, e.name)))).toBe(true);
      }
    });
  }

  it("gives the same bytes for the same input", async () => {
    const { buildCcx } = await load();
    const dir = join(root, "packages", "panel-uxp");
    expect(buildCcx(dir, "1.2.3").equals(buildCcx(dir, "1.2.3"))).toBe(true);
  });

  it("refuses a manifest with more than one host, or with none", async () => {
    const { ccxManifest } = await load();
    expect(() => ccxManifest({ host: [{ app: "PS" }, { app: "premierepro" }] }, "1.0.0")).toThrow(/one host application/);
    expect(() => ccxManifest({}, "1.0.0")).toThrow(/no host application/);
    expect(ccxManifest({ host: { app: "PS", minVersion: "26.0.0" } }, "1.0.0")).toEqual({ host: { app: "PS", minVersion: "26.0.0" }, version: "1.0.0" });
  });
});
