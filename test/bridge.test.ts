import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { BridgeServer, type BridgeServerOptions } from "../src/bridge/socket.js";
import { PROTOCOL_VERSION } from "../src/bridge/protocol.js";
import { writeHandshake } from "../src/bridge/handshake.js";
import { jsStringLiteral } from "../src/bridge/script-escape.js";
import { AppDisconnectedError } from "../src/bridge/types.js";
import type { AppId } from "../src/apps.js";

let bridge: BridgeServer | undefined;

function makeBridge(overrides: Partial<BridgeServerOptions> = {}): BridgeServer {
  bridge = new BridgeServer({
    port: 0,
    token: "s3cret",
    insecure: false,
    defaultTimeoutMs: 1_000,
    heartbeatIntervalMs: 0,
    authDeadlineMs: 1_000,
    // handshakeFilePath omitted → never writes a file.
    ...overrides,
  });
  return bridge;
}

function open(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function hello(ws: WebSocket, appId: AppId, token?: string): void {
  ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, appId, token, capabilities: [] }));
}

function awaitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

/** Resolves true if the upgrade was refused, false if the socket opened. */
function tryUpgrade(port: number, options: { origin?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
    ws.once("open", () => {
      ws.close();
      resolve(false);
    });
    ws.once("error", () => resolve(true));
  });
}

/** Resolves with the id of the first `cmd` frame the socket receives, and
 * arms a reply function that answers with the given value. */
function captureCmd(ws: WebSocket): Promise<{ id: string; name: string }> {
  return new Promise((resolve) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "cmd") resolve({ id: frame.id, name: frame.name });
    });
  });
}

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

describe("jsStringLiteral", () => {
  it("escapes U+2028 and U+2029 line terminators", () => {
    expect(jsStringLiteral("a b c")).toBe('"a\\u2028b\\u2029c"');
  });

  it("escapes quotes, backslashes and control characters", () => {
    expect(jsStringLiteral('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
  });

  it("passes ordinary and non-BMP text through unchanged", () => {
    expect(jsStringLiteral("café 😀")).toBe('"café 😀"');
  });
});

describe("BridgeServer authentication", () => {
  it("rejects a hello with a bad token", async () => {
    const b = makeBridge();
    await b.ready();
    const ws = await open(b.port());
    const closed = awaitClose(ws);
    hello(ws, "after_effects", "wrong");
    expect(await closed).toBe(4001);
  });

  it("rejects a hello with no token when one is required", async () => {
    const b = makeBridge();
    await b.ready();
    const ws = await open(b.port());
    const closed = awaitClose(ws);
    hello(ws, "after_effects");
    expect(await closed).toBe(4001);
  });

  it("accepts a hello with the correct token", async () => {
    const b = makeBridge();
    await b.ready();
    const ws = await open(b.port());
    const welcomed = new Promise<boolean>((resolve) =>
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString()).type === "welcome")),
    );
    hello(ws, "after_effects", "s3cret");
    expect(await welcomed).toBe(true);
    expect(b.connectedApps()).toContain("after_effects");
  });

  it("closes a socket that sends a frame before authenticating", async () => {
    const b = makeBridge();
    await b.ready();
    const ws = await open(b.port());
    const closed = awaitClose(ws);
    ws.send(JSON.stringify({ type: "result", id: "x", ok: true, value: 1 }));
    expect(await closed).toBe(4001);
  });

  it("closes a socket that never authenticates within the deadline", async () => {
    const b = makeBridge({ authDeadlineMs: 50 });
    await b.ready();
    const ws = await open(b.port());
    expect(await awaitClose(ws)).toBe(4001);
  });
});

describe("BridgeServer upgrade origin policy", () => {
  it("rejects a sandboxed web page's null origin", async () => {
    const b = makeBridge();
    await b.ready();
    expect(await tryUpgrade(b.port(), { origin: "null" })).toBe(true);
  });

  it("rejects a real web origin", async () => {
    const b = makeBridge();
    await b.ready();
    expect(await tryUpgrade(b.port(), { origin: "http://evil.example" })).toBe(true);
  });

  it("allows a connection with no origin (a UXP panel)", async () => {
    const b = makeBridge();
    await b.ready();
    expect(await tryUpgrade(b.port())).toBe(false);
  });

  it("allows an explicitly allowlisted origin", async () => {
    const b = makeBridge({ allowedOrigins: ["null"] });
    await b.ready();
    expect(await tryUpgrade(b.port(), { origin: "null" })).toBe(false);
  });
});

describe("writeHandshake", () => {
  it("replaces a pre-existing looser-mode file and lands mode-600", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-hs-"));
    const path = join(dir, "bridge.json");
    writeFileSync(path, "stale", { mode: 0o644 });

    writeHandshake(path, { protocolVersion: PROTOCOL_VERSION, port: 1, token: "sekret", pid: 1 });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("sekret");
  });

  it("does not write the token through a pre-existing symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-hs-"));
    const target = join(dir, "target.json");
    const link = join(dir, "bridge.json");
    writeFileSync(target, "", { mode: 0o644 });
    symlinkSync(target, link);

    writeHandshake(link, { protocolVersion: PROTOCOL_VERSION, port: 1, token: "sekret", pid: 1 });

    // The symlink was removed and a real 600 file written; the target is untouched.
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("");
    expect(lstatSync(link).mode & 0o777).toBe(0o600);
  });
});

describe("BridgeServer command routing", () => {
  it("does not let one panel settle another panel's in-flight command", async () => {
    const b = makeBridge();
    await b.ready();

    const panelA = await open(b.port());
    const capturedA = captureCmd(panelA);
    hello(panelA, "after_effects", "s3cret");
    await new Promise((r) => setTimeout(r, 20)); // let the welcome land

    const call = b.bridgeFor("after_effects").evaluate("1");
    const { id } = await capturedA;

    // A rogue authed panel echoes A's command id — it must be ignored.
    const rogue = await open(b.port());
    hello(rogue, "photoshop", "s3cret");
    await new Promise((r) => setTimeout(r, 20));
    rogue.send(JSON.stringify({ type: "result", id, ok: true, value: "rogue" }));
    await new Promise((r) => setTimeout(r, 30));

    // Only A's own reply settles the call.
    panelA.send(JSON.stringify({ type: "result", id, ok: true, value: "real" }));
    expect(await call).toBe("real");

    panelA.close();
    rogue.close();
  });

  it("rejects an in-flight command when the panel disconnects", async () => {
    const b = makeBridge();
    await b.ready();

    const panel = await open(b.port());
    const captured = captureCmd(panel);
    hello(panel, "after_effects", "s3cret");
    await new Promise((r) => setTimeout(r, 20));

    const call = b.bridgeFor("after_effects").evaluate("1");
    await captured; // command is now in flight
    panel.terminate();

    await expect(call).rejects.toBeInstanceOf(AppDisconnectedError);
  });

  it("reports app-not-connected immediately, without waiting for a timeout", async () => {
    const b = makeBridge({ defaultTimeoutMs: 60_000 });
    await b.ready();
    const start = Date.now();
    await expect(b.bridgeFor("after_effects").evaluate("1")).rejects.toThrow(/No running host connected/);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe("BridgeServer heartbeat", () => {
  it("terminates a panel that stops answering pings", async () => {
    const b = makeBridge({ heartbeatIntervalMs: 40 });
    await b.ready();
    const panel = await open(b.port());
    const closed = awaitClose(panel);
    hello(panel, "after_effects", "s3cret");
    // Panel never pongs; after MAX_MISSED_PINGS it is terminated.
    await closed;
    // The server-side close handler runs on its own socket, a tick after the
    // client observes the close; let it deregister before asserting.
    await new Promise((r) => setTimeout(r, 50));
    expect(b.connectedApps()).not.toContain("after_effects");
  });
});
