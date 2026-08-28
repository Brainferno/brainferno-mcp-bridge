import { describe, expect, it } from "vitest";

import { firewallCommands, mcpAddCommands, mergeUserConfig, platformPaths, rewriteAmeIni } from "../src/install/lib.js";

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
    expect(c.remote[0]).toBe('claude mcp add --scope user --transport http --header "Authorization: Bearer tok" adobe-cc http://192.168.1.51:7898/mcp');
    expect(mcpAddCommands({ mode: "local", distIndex: "i", port: 1, token: "", addresses: ["a"] }).remote).toEqual([]);
  });

  it("knows the platform paths", () => {
    const w = platformPaths("win32", "C:\\Users\\x", "C:\\Users\\x\\AppData\\Roaming");
    expect(w.cepExtensionsDir).toContain("CEP");
    expect(w.csxsDebugCommands).toHaveLength(4);
    expect(platformPaths("darwin", "/Users/x").cepExtensionsDir.replace(/\\/g, "/")).toContain("Library/Application Support/Adobe/CEP/extensions");
  });
});
