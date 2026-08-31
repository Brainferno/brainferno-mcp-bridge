import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/version.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("advertised version", () => {
  // It was typed out in four files and silently stayed at 0.1.0 through the 0.2.x releases,
  // so every MCP client and every panel was told the wrong version. This is the guard.
  it("is exactly what package.json says", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is not hardcoded anywhere in the server source", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.name.endsWith(".ts") && e.name !== "version.ts") out.push(p);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of await walk(new URL("../src", import.meta.url).pathname)) {
      const text = await readFile(file, "utf8");
      // A literal x.y.z next to a "version" key is the shape that drifted.
      if (/version:\s*["']\d+\.\d+\.\d+["']/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
