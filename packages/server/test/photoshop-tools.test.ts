import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppBridge, JsonValue } from "../src/bridge/types.js";
import { registerPhotoshopTools } from "../src/tools/photoshop.js";

/** A bridge that records the named command each tool sends. */
function recordingBridge() {
  const calls: { name: string; params: JsonValue | undefined }[] = [];
  const bridge: AppBridge = {
    appId: "photoshop",
    isConnected: () => true,
    execute: async (name, params) => {
      calls.push({ name, params });
      return { ok: true };
    },
    evaluate: async () => null,
    close: async () => {},
  };
  return { bridge, calls };
}

describe("Photoshop tools send named commands", () => {
  let client: Client;
  let calls: { name: string; params: JsonValue | undefined }[];
  let close: () => Promise<void>;

  beforeEach(async () => {
    const rec = recordingBridge();
    calls = rec.calls;
    const server = new McpServer({ name: "t", version: "0" });
    registerPhotoshopTools(server, rec.bridge, { allowRawScripts: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it("registers the v1 tool set (batchPlay hidden by default)", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of [
      "ps_list_documents",
      "ps_list_layers",
      "ps_create_document",
      "ps_open_document",
      "ps_save_document",
      "ps_export",
      "ps_get_preview",
      "ps_create_layer",
      "ps_create_text_layer",
      "ps_set_layer_props",
      "ps_move_layer",
      "ps_duplicate_layer",
      "ps_delete_layer",
      "ps_place_image",
      "ps_fill",
      "ps_apply_filter",
      "ps_resize_image",
      "ps_crop",
    ]) {
      expect(names, n).toContain(n);
    }
    expect(names).not.toContain("ps_batch_play");
  });

  it("maps tool arguments onto the command params with defaults", async () => {
    await client.callTool({ name: "ps_create_document", arguments: { width: 1080, height: 1080 } });
    expect(calls.at(-1)).toEqual({
      name: "ps.create_document",
      params: { width: 1080, height: 1080, resolution: 72, mode: "rgb", fill: "white", name: null },
    });

    await client.callTool({ name: "ps_create_text_layer", arguments: { text: "Hi", x: 10, y: 20 } });
    expect(calls.at(-1)?.name).toBe("ps.create_text_layer");
    expect(calls.at(-1)?.params).toMatchObject({ text: "Hi", x: 10, y: 20, fontSize: 48, font: "ArialMT", color: "#000000" });

    await client.callTool({ name: "ps_apply_filter", arguments: { layerId: 5, filter: "gaussianBlur", radius: 12 } });
    expect(calls.at(-1)).toEqual({ name: "ps.apply_filter", params: { layerId: 5, filter: "gaussianBlur", radius: 12 } });
  });

  it("rejects a bad color before sending anything", async () => {
    const before = calls.length;
    const result = await client.callTool({ name: "ps_fill", arguments: { color: "orange" } });
    expect(result.isError).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("exposes ps_batch_play only when raw scripts are allowed", async () => {
    const rec = recordingBridge();
    const server = new McpServer({ name: "t2", version: "0" });
    registerPhotoshopTools(server, rec.bridge, { allowRawScripts: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test2", version: "0" });
    await Promise.all([c.connect(ct), server.connect(st)]);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("ps_batch_play");
    await c.close();
    await server.close();
  });
});
