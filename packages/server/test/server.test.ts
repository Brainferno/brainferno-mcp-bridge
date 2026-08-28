import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { buildServer } from "../src/server.js";
import type { BridgeServer } from "../src/bridge/socket.js";
import { PROTOCOL_VERSION } from "@adobe-cc-mcp/protocol";
import type { Config } from "../src/config.js";
import type { AppId } from "@adobe-cc-mcp/protocol";

// Port 0 lets the OS pick a free one; insecure mode skips auth and the handshake
// file so tests never touch the real ~/.adobe-cc-mcp/bridge.json.
const config: Config = {
  bridgePort: 0,
  bridgeToken: "",
  bridgeInsecure: true,
  evalTimeoutMs: 2_000,
  heartbeatIntervalMs: 0,
  allowRawScripts: false,
  handshakeFilePath: "",
  allowedOrigins: [],
  illustratorMcpUrl: "http://localhost:18412/v1/mcp",
  illustratorMcpKey: "",
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  ameWebServicePath: "",
  amePort: 0,
  ameIdleMs: 0,
  httpPort: 0,
  httpHost: "127.0.0.1",
  httpToken: "",
  logLevel: "error",
};

/** Opens a fake panel, authenticates it, and resolves once the server welcomes it. */
async function connectPanel(port: number, appId: AppId): Promise<WebSocket> {
  const panel = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => panel.once("open", () => resolve()));
  const welcomed = new Promise<void>((resolve) => {
    panel.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "welcome") resolve();
    });
  });
  panel.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, appId, capabilities: [] }));
  await welcomed;
  return panel;
}

describe("adobe-cc-mcp server", () => {
  let client: Client;
  let bridge: BridgeServer;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const built = buildServer(config);
    bridge = built.bridge;
    await bridge.ready();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);

    close = async () => {
      await client.close();
      await built.server.close();
      await bridge.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it("advertises tools for all five applications", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("ae_list_compositions");
    expect(names).toContain("pp_list_sequences");
    expect(names).toContain("ps_list_documents");
    expect(names).toContain("ai_list_documents");
    expect(names).toContain("au_document_info");
    expect(names).toContain("cc_connected_apps");
  });

  it("does not advertise the raw-script tool unless it is enabled", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("cc_eval_script");
  });

  it("does not advertise the Illustrator delegate tools without a key", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("ai_beta_status");
  });

  it("reports every panel-driven application as disconnected when no panel has dialed in", async () => {
    const result = await client.callTool({ name: "cc_connected_apps", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const apps = JSON.parse(text) as { lane: string; connected: boolean | null }[];

    expect(apps.filter((a) => a.lane === "socket").every((a) => a.connected === false)).toBe(true);
  });

  it("returns an actionable error, not a crash, when the panel is absent", async () => {
    const result = await client.callTool({ name: "ae_list_compositions", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No running host connected/);
  });

  it("round-trips a command through a connected panel", async () => {
    const panel = await connectPanel(bridge.port(), "after_effects");

    // Stand in for After Effects: answer every command with a fixed comp list.
    panel.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "cmd") return;
      panel.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: [{ name: "Main", width: 1920 }] }));
    });

    const result = await client.callTool({ name: "ae_list_compositions", arguments: {} });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text);

    expect(result.isError).toBeFalsy();
    expect(parsed).toEqual([{ name: "Main", width: 1920 }]);
    panel.close();
  });

  it("surfaces a script error from the panel as a tool error", async () => {
    const panel = await connectPanel(bridge.port(), "photoshop");
    panel.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "cmd") return;
      panel.send(
        JSON.stringify({
          type: "result",
          id: frame.id,
          ok: false,
          error: { code: "HOST_ERROR", message: "No open document", line: 3 },
        }),
      );
    });

    const result = await client.callTool({ name: "ps_list_documents", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No open document/);
    panel.close();
  });
});

describe("adobe-cc-mcp server with an Illustrator delegate key", () => {
  it("advertises the delegate tools when a key is configured", async () => {
    const built = buildServer({ ...config, illustratorMcpKey: "ilst_test" });
    await built.bridge.ready();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([c.connect(clientTransport), built.server.connect(serverTransport)]);

    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("ai_beta_status");
    expect(names).toContain("ai_beta_list_tools");
    expect(names).toContain("ai_beta_call");

    await c.close();
    await built.server.close();
    await built.bridge.close();
    await built.illustratorDelegate.close();
  });
});
