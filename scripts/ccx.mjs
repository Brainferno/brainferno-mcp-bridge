// Builds a UXP plugin package (.ccx) from a panel folder, with no Adobe tool and no dependency.
//
// A .ccx is a plain zip file: the plugin's files with manifest.json at the root. There is no
// signature in it. The one thing Adobe's installer (UPIA) insists on is that `host` in
// manifest.json is a single object, not a list: with a list it refuses the file with status
// -267. The UXP Developer Tool's "Package" command makes exactly that change, and nothing
// else. See docs/quirks/panel-packaging.md for the live test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed timestamp, so the same input gives the same bytes on every machine.
const ZIP_DATE = new Date(Date.UTC(2026, 0, 1));

/**
 * Writes a zip file: deflate, files only (no folder entries), forward-slash UTF-8 names.
 * @param {{ name: string, data: Buffer }[]} entries written in this order
 * @returns {Buffer}
 */
export function zip(entries, date = ZIP_DATE) {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const comp = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory header
    cen.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, zip 4.5
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** The panel's files as forward-slash paths, sorted, without developer leftovers. */
export function listPanelFiles(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const n of readdirSync(d).sort()) {
      if (n === "node_modules" || n === ".debug" || n.endsWith(".log")) continue;
      const p = join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(p).isDirectory()) walk(p, r);
      else files.push(r);
    }
  })(dir, "");
  return files;
}

/** The manifest as it must be inside a .ccx: this version, and `host` as one object. */
export function ccxManifest(manifest, version) {
  const out = { ...manifest, version };
  if (Array.isArray(out.host)) {
    if (out.host.length !== 1) {
      throw new Error(`A .ccx holds one host application, and this manifest lists ${out.host.length} — package each host from its own panel folder.`);
    }
    out.host = out.host[0];
  }
  if (!out.host || typeof out.host !== "object" || !out.host.app) {
    throw new Error("manifest.json has no host application — add `host: { app, minVersion }`.");
  }
  return out;
}

/**
 * Builds the .ccx for one UXP panel folder.
 * @param {string} dir the panel folder (it must hold manifest.json)
 * @param {string} version the version to stamp into the manifest
 * @returns {Buffer} the bytes of the .ccx file
 */
export function buildCcx(dir, version) {
  const manifest = ccxManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), version);
  const entries = [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }];
  for (const f of listPanelFiles(dir)) {
    if (f !== "manifest.json") entries.push({ name: f, data: readFileSync(join(dir, f)) });
  }
  return zip(entries);
}
