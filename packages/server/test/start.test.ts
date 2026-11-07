import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readHandshake, writeHandshake } from "../src/bridge/handshake.js";
import type { Config } from "../src/config.js";
import { sharedPortInUseMessage, startRuntime, type StartedRuntime } from "../src/start.js";

const TOKEN = "test-token-0123456789abcdef";

const base: Config = {
  bridgePort: 0,
  bridgeToken: "",
  bridgeInsecure: false,
  evalTimeoutMs: 2_000,
  heartbeatIntervalMs: 0,
  allowRawScripts: false,
  rawScriptApps: [],
  rawScriptIgnored: [],
  allowRemoteRawScripts: false,
  handshakeFilePath: "",
  allowedOrigins: [],
  illustratorMcpUrl: "http://localhost:18412/v1/mcp",
  illustratorMcpKey: "",
  illustratorApp: "",
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  ameWebServicePath: "",
  amePort: 0,
  ameIdleMs: 0,
  httpPort: 0,
  httpHost: "127.0.0.1",
  httpToken: TOKEN,
  enabledApps: ["photoshop", "after_effects", "premiere", "illustrator", "audition", "media_encoder"],
  logLevel: "error",
  defaultWait: true,
  preview: "both",
  jobWaitSeconds: 300,
};

/** A listener on a free loopback port, standing in for the server that already runs. */
function holdPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });
}

const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("startRuntime (shared mode and the handshake file)", () => {
  const dirs: string[] = [];
  const holders: Server[] = [];
  let started: StartedRuntime | null = null;

  const handshakePath = () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-start-"));
    dirs.push(dir);
    return join(dir, "bridge.json");
  };

  afterEach(async () => {
    if (started !== null) {
      await started.remote?.close();
      await started.rt.bridge.close();
      started = null;
    }
    for (const server of holders.splice(0)) await closeServer(server);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("stops before it touches the handshake file when the shared-mode port is taken", async () => {
    const held = await holdPort();
    holders.push(held.server);
    const path = handshakePath();
    // The file of the server that is still running: a live pid that is not this process.
    writeHandshake(path, { protocolVersion: 2, port: 7897, token: "the-live-server-token", pid: process.ppid });
    const before = readFileSync(path, "utf8");

    const failure = await startRuntime({ ...base, handshakeFilePath: path, httpPort: held.port }).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(`shared-mode port ${held.port} on 127.0.0.1 is in use`);
    expect(failure?.message).toContain(`(pid ${process.ppid})`);
    expect(failure?.message).toMatch(/ — stop that server .*httpPort.*then reconnect$/);
    expect((failure?.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EADDRINUSE");
    expect(failure?.message).not.toContain("the-live-server-token");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("binds the shared-mode port and then writes the handshake file when the port is free", async () => {
    const held = await holdPort();
    await closeServer(held.server);
    const path = handshakePath();

    started = await startRuntime({ ...base, handshakeFilePath: path, httpPort: held.port });

    expect(started.remote?.port).toBe(held.port);
    const handshake = readHandshake(path);
    expect(handshake?.pid).toBe(process.pid);
    expect(handshake?.port).toBe(started.rt.bridge.port());
  });

  it("starts no remote listener when shared mode is off", async () => {
    const path = handshakePath();
    started = await startRuntime({ ...base, handshakeFilePath: path, httpPort: 0 });
    expect(started.remote).toBeNull();
    expect(readHandshake(path)?.pid).toBe(process.pid);
  });

  it("names no server when no live handshake file points at one", () => {
    const path = handshakePath();
    expect(sharedPortInUseMessage({ httpHost: "0.0.0.0", httpPort: 7898, handshakeFilePath: path })).toContain(
      "shared-mode port 7898 on 0.0.0.0 is in use: another process holds it — ",
    );
    expect(sharedPortInUseMessage({ httpHost: "0.0.0.0", httpPort: 7898, handshakeFilePath: "" })).toContain("another process holds it");
  });
});
