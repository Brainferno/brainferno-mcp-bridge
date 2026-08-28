import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { envValue, migrateLegacyUserDir } from "../src/config.js";

describe("rename compatibility", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("reads the new env name first and falls back to the old ADOBE_CC_MCP_ name", () => {
    delete process.env["BRAINFERNO_MCP_TEST_X"];
    process.env["ADOBE_CC_MCP_TEST_X"] = "old";
    expect(envValue("BRAINFERNO_MCP_TEST_X")).toBe("old");
    process.env["BRAINFERNO_MCP_TEST_X"] = "new";
    expect(envValue("BRAINFERNO_MCP_TEST_X")).toBe("new");
    expect(envValue("BRAINFERNO_MCP_TEST_MISSING")).toBeUndefined();
  });

  it("copies config.json from ~/.adobe-cc-mcp into ~/.brainferno-mcp-bridge once", () => {
    const home = mkdtempSync(join(tmpdir(), "acm-home-"));
    mkdirSync(join(home, ".adobe-cc-mcp"));
    writeFileSync(join(home, ".adobe-cc-mcp", "config.json"), JSON.stringify({ illustratorKey: "ilst_keep" }));
    expect(migrateLegacyUserDir(home)).toBe(join(home, ".adobe-cc-mcp"));
    expect(JSON.parse(readFileSync(join(home, ".brainferno-mcp-bridge", "config.json"), "utf8"))).toEqual({ illustratorKey: "ilst_keep" });
    expect(migrateLegacyUserDir(home)).toBeNull();
    expect(migrateLegacyUserDir(mkdtempSync(join(tmpdir(), "acm-empty-")))).toBeNull();
  });
});
