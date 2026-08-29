import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INSTALLABLE_APPS, parseApps } from "../src/config.js";
import { appsNeed, checkIllustratorKey, extractIllustratorKey, extractIllustratorUrl, finderCopyScript, findIllustratorApps, firewallCommands, mcpAddCommands, mergeUserConfig, pickApps, platformPaths, rewriteAmeIni, AME_INI_SEED } from "../src/install/lib.js";

describe("installer: Illustrator key", () => {
  it("accepts a bare key or the whole claude mcp add line", () => {
    const line = 'claude mcp add --transport http --header "Authorization: Bearer ilst_AbC123-xyz" --scope user illustrator http://localhost:18412/v1/mcp';
    expect(extractIllustratorKey(line)).toBe("ilst_AbC123-xyz");
    expect(extractIllustratorKey("  ilst_AbC123-xyz ")).toBe("ilst_AbC123-xyz");
    expect(extractIllustratorKey("nope")).toBeNull();
    expect(extractIllustratorKey("")).toBeNull();
    expect(extractIllustratorUrl(line)).toBe("http://localhost:18412/v1/mcp");
    expect(extractIllustratorUrl("ilst_x")).toBeNull();
  });

  it("stores and clears the key/url through the merge", () => {
    const c = mergeUserConfig({}, "local", { illustratorKey: "ilst_1", illustratorUrl: "http://localhost:1/mcp" });
    expect(c).toEqual({ illustratorKey: "ilst_1", illustratorUrl: "http://localhost:1/mcp" });
    expect(mergeUserConfig(c, "local", { illustratorKey: null, illustratorUrl: null })).toEqual({});
    expect(mergeUserConfig(c, "local")).toEqual(c);
  });

  it("checks a key against an MCP endpoint", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer ilst_good") {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "illustrator-mcp", version: "1" } } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1/mcp`;
    expect(await checkIllustratorKey(url, "ilst_good")).toEqual({ ok: true, serverName: "illustrator-mcp" });
    expect((await checkIllustratorKey(url, "ilst_bad")) as { reason: string }).toMatchObject({ ok: false, reason: "refused" });
    await new Promise<void>((r) => server.close(() => r()));
    expect((await checkIllustratorKey(url, "ilst_good")) as { reason: string }).toMatchObject({ ok: false, reason: "not-running" });
  });
});

describe("installer: choosing apps", () => {
  it("parses numbers, names, aliases and 'all'", () => {
    expect(pickApps("1,3", [])).toEqual(["photoshop", "premiere"]);
    expect(pickApps("2 5", [])).toEqual(["after_effects", "audition"]);
    expect(pickApps("all", [])).toEqual([...INSTALLABLE_APPS]);
    expect(pickApps("", ["audition"])).toEqual(["audition"]);
    expect(pickApps("ps, AE", [])).toEqual(["photoshop", "after_effects"]);
    expect(parseApps("ppro,ame")).toEqual(["premiere", "media_encoder"]);
    expect(() => parseApps("indesign")).toThrow(/Unknown app/);
  });

  it("stores a subset, drops the key when everything is chosen", () => {
    expect(mergeUserConfig({}, "local", { apps: ["photoshop", "after_effects"] })).toEqual({ enabledApps: ["photoshop", "after_effects"] });
    expect(mergeUserConfig({ enabledApps: ["audition"] }, "local", { apps: [...INSTALLABLE_APPS] })).toEqual({});
    expect(appsNeed(["photoshop"], "uxp")).toBe(true);
    expect(appsNeed(["photoshop"], "cep")).toBe(false);
    expect(appsNeed(["after_effects", "audition"], "cep")).toBe(true);
    expect(appsNeed(["illustrator"], "illustrator-key")).toBe(true);
  });
});

describe("installer pieces", () => {
  it("merges the mode into the user config without touching other keys", () => {
    const shared = mergeUserConfig({ illustratorKey: "k" }, "shared", { port: 7898, token: "t".repeat(20) });
    expect(shared).toEqual({ illustratorKey: "k", httpPort: 7898, httpHost: "0.0.0.0", httpToken: "t".repeat(20) });
    const keep = mergeUserConfig(shared, "shared");
    expect(keep.httpToken).toBe("t".repeat(20));
    const local = mergeUserConfig(shared, "local");
    expect(local).toEqual({ illustratorKey: "k" });
    expect(mergeUserConfig({}, "shared").httpToken?.length).toBeGreaterThan(20);
  });

  it("rewrites the Media Encoder ini for each mode and keeps the rest", () => {
    const ini = "# comment\r\n#ip = 127.0.0.1\r\nport = 8080\r\njob_history = 100\r\n";
    const local = rewriteAmeIni(ini, "local");
    expect(local).toBe("# comment\r\nip = 127.0.0.1\r\nport = 8080\r\njob_history = 100\r\n");
    expect(rewriteAmeIni(local, "shared")).toBe("# comment\r\n#ip = 127.0.0.1\r\nport = 8080\r\njob_history = 100\r\n");
    expect(rewriteAmeIni("port = 8080\n", "local")).toBe("ip = 127.0.0.1\nport = 8080\n");
  });

  it("builds firewall and registration commands per mode", () => {
    expect(firewallCommands("win32", "shared", 7898).at(-1)).toContain("localport=7898");
    expect(firewallCommands("win32", "local", 7898)).toHaveLength(1);
    expect(firewallCommands("darwin", "shared", 7898)).toEqual([]);
    const c = mcpAddCommands({ mode: "shared", distIndex: "C:/x/index.js", port: 7898, token: "tok", addresses: ["192.168.1.51"] });
    expect(c.local).toContain('node "C:/x/index.js"');
    expect(c.remote[0]).toBe('claude mcp add --scope user --transport http --header "Authorization: Bearer tok" brainferno http://192.168.1.51:7898/mcp');
    expect(mcpAddCommands({ mode: "local", distIndex: "i", port: 1, token: "", addresses: ["a"] }).remote).toEqual([]);
  });

  it("knows the platform paths", () => {
    const w = platformPaths("win32", "C:\\Users\\x", "C:\\Users\\x\\AppData\\Roaming");
    expect(w.cepExtensionsDir).toContain("CEP");
    expect(w.csxsDebugCommands).toHaveLength(4);
    expect(platformPaths("darwin", "/Users/x").cepExtensionsDir.replace(/\\/g, "/")).toContain("Library/Application Support/Adobe/CEP/extensions");
    // Windows: the ini sits beside the exe in Program Files. macOS: inside the app bundle's Resources (the console reads it there).
    expect(w.ameIniCandidates[1]!.replace(/\\/g, "/")).toMatch(/Adobe\/Adobe Media Encoder 2026\/ame_webservice_config\.ini$/);
    expect(platformPaths("darwin", "/Users/x").ameIniCandidates[1]).toBe("/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/Resources/ame_webservice_config.ini");
    expect(platformPaths("darwin", "/Users/x").csxsDebugCommands[0]).toEqual(["defaults", "write", "com.adobe.CSXS.11", "PlayerDebugMode", "1"]);
  });

  it("seeds a missing macOS ini and has Finder copy it into the bundle", () => {
    expect(rewriteAmeIni(AME_INI_SEED, "local")).toBe("ip = 127.0.0.1\nport = 8080\n");
    expect(rewriteAmeIni(AME_INI_SEED, "shared")).toBe("port = 8080\n");
    const script = finderCopyScript("/tmp/x y/ame_webservice_config.ini", '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/Resources');
    expect(script).toBe('tell application "Finder" to duplicate file (POSIX file "/tmp/x y/ame_webservice_config.ini" as alias) to folder (POSIX file "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/Resources" as alias) with replacing');
    expect(finderCopyScript('/a/"q"', "/b\\c")).toContain('\\"q\\"');
  });
});

describe("installer: which Illustrator the os-script lane drives", () => {
  // A stand-in /Applications with both bundles Adobe ships as "Adobe Illustrator.app".
  let apps: string;
  const ids: Record<string, string> = { "Adobe Illustrator 2026": "com.adobe.illustrator", "Adobe Illustrator (Beta)": "com.adobe.illustratorBeta" };
  const readId = (bundlePath: string) => ids[basename(dirname(bundlePath))] ?? null;

  beforeAll(() => {
    apps = mkdtempSync(join(tmpdir(), "ai-apps-"));
    for (const label of Object.keys(ids)) mkdirSync(join(apps, label, "Adobe Illustrator.app"), { recursive: true });
    mkdirSync(join(apps, "Adobe Photoshop 2026"), { recursive: true });
  });
  afterAll(() => rmSync(apps, { recursive: true, force: true }));

  it("is empty on Windows (COM ProgID picks the version there)", () => {
    expect(findIllustratorApps("win32", apps, readId)).toEqual([]);
  });

  it("lists both macOS bundles by id, release before Beta", () => {
    const found = findIllustratorApps("darwin", apps, readId);
    expect(found.map((i) => i.bundleId)).toEqual(["com.adobe.illustrator", "com.adobe.illustratorBeta"]);
    expect(found.map((i) => i.beta)).toEqual([false, true]);
    expect(found[0]!.label).toBe("Adobe Illustrator 2026");
    expect(found[0]!.path).toBe(join(apps, "Adobe Illustrator 2026", "Adobe Illustrator.app"));
  });

  it("skips folders with no readable bundle id, and a missing /Applications", () => {
    expect(findIllustratorApps("darwin", apps, () => null)).toEqual([]);
    expect(findIllustratorApps("darwin", join(apps, "nope"), readId)).toEqual([]);
  });

  it("stores and clears the pinned app through the merge", () => {
    const pinned = mergeUserConfig({}, "local", { illustratorApp: "com.adobe.illustratorBeta" });
    expect(pinned.illustratorApp).toBe("com.adobe.illustratorBeta");
    expect(mergeUserConfig(pinned, "local", { illustratorApp: null }).illustratorApp).toBeUndefined();
    expect(mergeUserConfig(pinned, "local", {}).illustratorApp).toBe("com.adobe.illustratorBeta");
  });
});
