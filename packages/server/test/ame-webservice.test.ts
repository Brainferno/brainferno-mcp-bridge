import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectConsoleExe, iniPathFor, macRendererPids, newPids, portFromIni } from "../src/drivers/ame-webservice.js";

const MAC_CONSOLE = "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/ame_webservice_console.app/Contents/MacOS/ame_webservice_console";
const WIN_CONSOLE = "C:\\Program Files\\Adobe\\Adobe Media Encoder 2026\\ame_webservice_console.exe";

describe("Media Encoder console: ini location", () => {
  it("is beside the exe on Windows", () => {
    expect(iniPathFor(WIN_CONSOLE, "win32")).toBe("C:\\Program Files\\Adobe\\Adobe Media Encoder 2026\\ame_webservice_config.ini");
  });

  it("is in the outer app bundle's Resources on macOS (nested console bundle)", () => {
    expect(iniPathFor(MAC_CONSOLE, "darwin")).toBe("/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/Resources/ame_webservice_config.ini");
    // A console placed directly in the app bundle resolves to the same Resources folder.
    expect(iniPathFor("/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MacOS/ame_webservice_console", "darwin")).toBe("/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/Resources/ame_webservice_config.ini");
  });

  it("falls back to beside-the-exe on macOS when there is no bundle (BRAINFERNO_MCP_AME_WEBSERVICE override)", () => {
    expect(iniPathFor("/opt/ame/ame_webservice_console", "darwin")).toBe("/opt/ame/ame_webservice_config.ini");
  });
});

describe("Media Encoder console: detection and port", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ame-detect-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the newest console on Windows beside the other Adobe apps", async () => {
    await mkdir(join(root, "Adobe Media Encoder 2025"), { recursive: true });
    await writeFile(join(root, "Adobe Media Encoder 2025", "ame_webservice_console.exe"), "");
    await mkdir(join(root, "Adobe Media Encoder 2026"), { recursive: true });
    await writeFile(join(root, "Adobe Media Encoder 2026", "ame_webservice_console.exe"), "");
    expect(await detectConsoleExe("win32", [root])).toBe(join(root, "Adobe Media Encoder 2026", "ame_webservice_console.exe"));
  });

  it("finds the nested console bundle on macOS and reads the port from the bundle's Resources ini", async () => {
    const app = join(root, "Adobe Media Encoder 2026", "Adobe Media Encoder 2026.app", "Contents");
    await mkdir(join(app, "ame_webservice_console.app", "Contents", "MacOS"), { recursive: true });
    await writeFile(join(app, "ame_webservice_console.app", "Contents", "MacOS", "ame_webservice_console"), "");
    const exe = await detectConsoleExe("darwin", [root]);
    expect(exe).toBe(join(app, "ame_webservice_console.app", "Contents", "MacOS", "ame_webservice_console"));
    // No ini shipped → default port.
    expect(await portFromIni(exe!, "darwin")).toBe(8080);
    await mkdir(join(app, "Resources"), { recursive: true });
    await writeFile(join(app, "Resources", "ame_webservice_config.ini"), "ip = 127.0.0.1\nport = 8090\n");
    expect(await portFromIni(exe!, "darwin")).toBe(8090);
  });

  it("returns null when nothing is installed, and off Windows/macOS entirely", async () => {
    expect(await detectConsoleExe("darwin", [root])).toBeNull();
    expect(await detectConsoleExe("win32", [root])).toBeNull();
    // Media Encoder only exists on the two platforms Adobe ships it for.
    expect(await detectConsoleExe("unsupported" as NodeJS.Platform, [])).toBeNull();
  });
});

describe("Media Encoder renderer tracking (macOS)", () => {
  it("attributes only the renderers that appeared after the console was started", () => {
    expect(newPids(new Set([100, 200]), new Set([200, 300, 400]))).toEqual([300, 400]);
    expect(newPids(new Set(), new Set())).toEqual([]);
  });

  it("lists renderer pids without throwing on any platform", async () => {
    const pids = await macRendererPids();
    expect(pids).toBeInstanceOf(Set);
    for (const pid of pids) expect(Number.isInteger(pid) && pid > 0).toBe(true);
  });
});
