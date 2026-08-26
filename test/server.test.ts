import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { buildServer } from "../src/server.js";
import type { BridgeServer } from "../src/bridge/socket.js";
import { PROTOCOL_VERSION } from "../src/bridge/protocol.js";

// Port 0 lets the OS pick a free one, so tests never collide with a real server.
const config = { bridgePort: 0, bridgeToken: "", evalTimeoutMs: 2_000, logLevel: "error" as const };

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
    expect(names).toContain("ppro_list_sequences");
    expect(names).toContain("ps_list_documents");
    expect(names).toContain("ai_list_documents");
    expect(names).toContain("au_document_info");
    expect(names).toContain("cc_connected_apps");
  });

  it("reports every application as disconnected when no panel has dialed in", async () => {
    const result = await client.callTool({ name: "cc_connected_apps", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]!.text;

    expect(JSON.parse(text).every((app: { connected: boolean }) => !app.connected)).toBe(true);
  });

  it("returns an actionable error, not a crash, when the panel is absent", async () => {
    const result = await client.callTool({ name: "ae_list_compositions", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No running host connected/);
  });

  it("round-trips a script through a connected panel", async () => {
    const port = (bridge as unknown as { wss: { address(): { port: number } } }).wss.address().port;
    const panel = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve) => panel.once("open", () => resolve()));
    panel.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, appId: "after_effects" }));

    // Stand in for After Effects: answer every eval with a fixed comp list.
    panel.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "eval") return;
      panel.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: [{ name: "Main", width: 1920 }] }));
    });

    // Wait for the server to record the hello before calling a tool.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await client.callTool({ name: "ae_list_compositions", arguments: {} });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text);

    expect(result.isError).toBeFalsy();
    expect(parsed).toEqual([{ name: "Main", width: 1920 }]);
    panel.close();
  });

  it("surfaces a script error from the panel as a tool error", async () => {
    const port = (bridge as unknown as { wss: { address(): { port: number } } }).wss.address().port;
    const panel = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve) => panel.once("open", () => resolve()));
    panel.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, appId: "photoshop" }));
    panel.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "eval") return;
      panel.send(
        JSON.stringify({ type: "result", id: frame.id, ok: false, error: { message: "No open document", line: 3 } }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await client.callTool({ name: "ps_list_documents", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No open document/);
    panel.close();
  });
});
