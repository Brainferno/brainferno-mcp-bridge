import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { INSTALLABLE_APPS, parseApps } from "../src/config.js";
import { appsNeed, checkIllustratorKey, extractIllustratorKey, extractIllustratorUrl, firewallCommands, mcpAddCommands, mergeUserConfig, pickApps, platformPaths, rewriteAmeIni } from "../src/install/lib.js";

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
  });
});
