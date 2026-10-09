import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RAW_SCRIPT_APPS,
  envValue,
  isRawScriptApp,
  loadConfig,
  migrateLegacyUserDir,
  parseApps,
  parseFlag,
  parseRawScriptApps,
  resolveAppToken,
} from "../src/config.js";

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

describe("per-client env defaults", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("defaults to blocking waits, both-mode previews, and a 300s job wait", () => {
    delete process.env["BRAINFERNO_MCP_DEFAULT_WAIT"];
    delete process.env["BRAINFERNO_MCP_PREVIEW"];
    delete process.env["BRAINFERNO_MCP_JOB_WAIT_SECONDS"];
    const c = loadConfig();
    expect(c.defaultWait).toBe(true);
    expect(c.preview).toBe("both");
    expect(c.jobWaitSeconds).toBe(300);
  });

  it("reads the Codex-style overrides", () => {
    process.env["BRAINFERNO_MCP_DEFAULT_WAIT"] = "false";
    process.env["BRAINFERNO_MCP_PREVIEW"] = "path";
    process.env["BRAINFERNO_MCP_JOB_WAIT_SECONDS"] = "50";
    const c = loadConfig();
    expect(c.defaultWait).toBe(false);
    expect(c.preview).toBe("path");
    expect(c.jobWaitSeconds).toBe(50);
    process.env["BRAINFERNO_MCP_DEFAULT_WAIT"] = "0";
    expect(loadConfig().defaultWait).toBe(false);
    process.env["BRAINFERNO_MCP_DEFAULT_WAIT"] = "1";
    expect(loadConfig().defaultWait).toBe(true);
  });

  it("rejects an unknown preview mode", () => {
    process.env["BRAINFERNO_MCP_PREVIEW"] = "thumbnail";
    expect(() => loadConfig()).toThrow(/BRAINFERNO_MCP_PREVIEW/);
  });
});

describe("raw-script gate (BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS)", () => {
  const ALL = ["after_effects", "photoshop", "illustrator", "audition"];

  it("turns everything on for 1 / true / all / *, in canonical order", () => {
    expect([...RAW_SCRIPT_APPS]).toEqual(ALL);
    for (const v of ["1", "true", "TRUE", " 1 ", "all", "ALL", "*"]) {
      expect(parseRawScriptApps(v), JSON.stringify(v)).toEqual({ apps: ALL, ignored: [] });
    }
  });

  it("turns everything off for unset, blank and the off words", () => {
    for (const v of [undefined, "", "  ", "0", "false", "off", "no", "OFF"]) {
      expect(parseRawScriptApps(v), JSON.stringify(v)).toEqual({ apps: [], ignored: [] });
    }
  });

  it("reads a comma/space list with aliases, dedupes, and keeps canonical order", () => {
    expect(parseRawScriptApps("after_effects,ps")).toEqual({ apps: ["after_effects", "photoshop"], ignored: [] });
    expect(parseRawScriptApps("ae,au,ai")).toEqual({ apps: ["after_effects", "illustrator", "audition"], ignored: [] });
    expect(parseRawScriptApps("ae,")).toEqual({ apps: ["after_effects"], ignored: [] });
    expect(parseRawScriptApps(" Photoshop  ps, PHOTOSHOP ")).toEqual({ apps: ["photoshop"], ignored: [] });
    expect(parseRawScriptApps("audition after-effects")).toEqual({ apps: ["after_effects", "audition"], ignored: [] });
  });

  it("never enables Premiere Pro, Media Encoder or a typo — it reports them instead", () => {
    expect(parseRawScriptApps("premiere,media_encoder,bogus")).toEqual({ apps: [], ignored: ["premiere", "media_encoder", "bogus"] });
    expect(parseRawScriptApps("ae,ppro,ame,constructor,toString")).toEqual({
      apps: ["after_effects"],
      ignored: ["ppro", "ame", "constructor", "toString"],
    });
    // "1" only means "all" on its own; inside a list it is just an unknown token.
    expect(parseRawScriptApps("1,ps")).toEqual({ apps: ["photoshop"], ignored: ["1"] });
    expect(parseRawScriptApps("yes")).toEqual({ apps: [], ignored: ["yes"] });
  });

  it("never throws", () => {
    for (const v of [",,,", "  ,  ", "\u0000", "__proto__", "ae;ps", "ae,,ps", "x".repeat(10_000)]) {
      expect(() => parseRawScriptApps(v)).not.toThrow();
      expect(parseRawScriptApps(v).apps.every((a) => isRawScriptApp(a))).toBe(true);
    }
  });

  it("shares parseApps' alias table, which still behaves as before", () => {
    expect(resolveAppToken(" PPro ")).toBe("premiere");
    expect(resolveAppToken("constructor")).toBeUndefined();
    expect(parseApps("ae,ps")).toEqual(["after_effects", "photoshop"]);
    expect(parseApps(undefined, ["audition"])).toEqual(["audition"]);
    expect(() => parseApps("ae,bogus")).toThrow(/Unknown app "bogus"/);
    expect(isRawScriptApp("premiere")).toBe(false);
    expect(isRawScriptApp("illustrator")).toBe(true);
  });

  it("parses the remote opt-in strictly", () => {
    for (const v of ["1", "true", "TRUE", " true "]) expect(parseFlag(v), v).toBe(true);
    for (const v of [undefined, "", "0", "false", "yes", "on", "all", "*", "2"]) expect(parseFlag(v), String(v)).toBe(false);
  });
});

describe("raw-script gate in loadConfig", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    vi.restoreAllMocks();
  });

  it("is off by default, for local and remote sessions", () => {
    delete process.env["BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS"];
    delete process.env["ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS"];
    delete process.env["BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS"];
    delete process.env["ADOBE_CC_MCP_ALLOW_REMOTE_RAW_SCRIPTS"];
    const c = loadConfig();
    expect(c.rawScriptApps).toEqual([]);
    expect(c.rawScriptIgnored).toEqual([]);
    expect(c.allowRawScripts).toBe(false);
    expect(c.allowRemoteRawScripts).toBe(false);
  });

  it("reads the list, keeps allowRawScripts in step, and warns once about ignored tokens", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env["BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS"] = "premiere,ae,zz-unique-token";
    process.env["BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS"] = "true";
    const c = loadConfig();
    expect(c.rawScriptApps).toEqual(["after_effects"]);
    expect(c.rawScriptIgnored).toEqual(["premiere", "zz-unique-token"]);
    expect(c.allowRawScripts).toBe(true);
    expect(c.allowRemoteRawScripts).toBe(true);
    loadConfig();
    const lines = warn.mock.calls.map((a) => String(a[0])).filter((l) => l.includes("zz-unique-token"));
    expect(lines).toEqual([
      "[brainferno-mcp-bridge] WARN BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS: ignored premiere, zz-unique-token " +
        "(raw scripts exist only for after_effects, photoshop, illustrator, audition)",
    ]);
  });

  it("still honours the legacy ADOBE_CC_MCP_ names", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env["BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS"];
    delete process.env["BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS"];
    process.env["ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS"] = "1";
    process.env["ADOBE_CC_MCP_ALLOW_REMOTE_RAW_SCRIPTS"] = "1";
    const c = loadConfig();
    expect(c.rawScriptApps).toEqual(["after_effects", "photoshop", "illustrator", "audition"]);
    expect(c.allowRawScripts).toBe(true);
    expect(c.allowRemoteRawScripts).toBe(true);
  });
});
