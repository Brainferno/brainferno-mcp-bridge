import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppNotConnectedError, ScriptError, type AppBridge, type JsonValue } from "../src/bridge/types.js";
import { log } from "../src/logging.js";
import { registerPhotoshopTools, type PhotoshopToolOptions } from "../src/tools/photoshop.js";
import { RAW_SCRIPTS_DISABLED_MESSAGE, REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE } from "../src/tools/raw-script.js";

/**
 * A bridge that records the named command each tool sends. `reply` (optional) chooses the
 * answer — return a value, or throw to stand in for a failing panel.
 */
function recordingBridge(reply?: (name: string, params: JsonValue | undefined) => JsonValue) {
  const calls: { name: string; params: JsonValue | undefined }[] = [];
  const bridge: AppBridge = {
    appId: "photoshop",
    isConnected: () => true,
    execute: async (name, params) => {
      calls.push({ name, params });
      return reply ? reply(name, params) : { ok: true };
    },
    evaluate: async () => null,
    close: async () => {},
  };
  return { bridge, calls };
}

const GATE_OFF: PhotoshopToolOptions = { rawScriptApps: [], remote: false, allowRemoteRawScripts: false };
const GATE_ON: PhotoshopToolOptions = { rawScriptApps: ["photoshop"], remote: false, allowRemoteRawScripts: false };

/** An MCP client wired to a fresh server with only the Photoshop tools. */
async function photoshopClient(bridge: AppBridge, options: PhotoshopToolOptions) {
  const server = new McpServer({ name: "ps", version: "0" });
  registerPhotoshopTools(server, bridge, options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "ps-test", version: "0" });
  await Promise.all([c.connect(ct), server.connect(st)]);
  return {
    c,
    close: async () => {
      await c.close();
      await server.close();
    },
  };
}

const textOf = (r: unknown) => (r as { content: { type: string; text: string }[] }).content[0]!.text;

describe("Photoshop tools send named commands", () => {
  let client: Client;
  let calls: { name: string; params: JsonValue | undefined }[];
  let close: () => Promise<void>;

  beforeEach(async () => {
    const rec = recordingBridge();
    calls = rec.calls;
    const server = new McpServer({ name: "t", version: "0" });
    registerPhotoshopTools(server, rec.bridge, GATE_OFF);
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

  it("registers the v1 tool set (batchPlay listed even with the gate off)", async () => {
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
      "ps_set_layer_style",
      "ps_get_layer_styles",
      "ps_remove_layer_style",
    ]) {
      expect(names, n).toContain(n);
    }
    // Flipped by X-01: raw tools are always registered and refuse while their gate is off.
    expect(names).toContain("ps_batch_play");
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

    await client.callTool({ name: "ps_set_layer_style", arguments: { layerId: 5, style: "dropShadow", color: "#102030", distance: 8 } });
    expect(calls.at(-1)?.name).toBe("ps.set_layer_style");
    expect(calls.at(-1)?.params).toMatchObject({ layerId: 5, style: "dropShadow", enabled: true, color: "#102030", distance: 8, opacity: null, blendMode: null });

    await client.callTool({ name: "ps_set_layer_style", arguments: { layerId: 5, style: "gradientOverlay", colors: ["#ff0000", "#00ff00", "#0000ff"], gradientStyle: "radial", angle: 45 } });
    expect(calls.at(-1)?.name).toBe("ps.set_layer_style");
    expect(calls.at(-1)?.params).toMatchObject({ layerId: 5, style: "gradientOverlay", colors: ["#ff0000", "#00ff00", "#0000ff"], gradientStyle: "radial", angle: 45, reverse: null });

    await client.callTool({ name: "ps_remove_layer_style", arguments: { layerId: 5 } });
    expect(calls.at(-1)).toEqual({ name: "ps.remove_layer_style", params: { layerId: 5, style: null } });
  });

  it("rejects a bad color before sending anything", async () => {
    const before = calls.length;
    const result = await client.callTool({ name: "ps_fill", arguments: { color: "orange" } });
    expect(result.isError).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("lists ps_batch_play whether or not raw scripts are allowed", async () => {
    // Flipped by X-01: this used to assert the tool exists only with the gate on.
    for (const options of [GATE_ON, GATE_OFF]) {
      const rec = recordingBridge();
      const { c, close: done } = await photoshopClient(rec.bridge, options);
      const tool = (await c.listTools()).tools.find((t) => t.name === "ps_batch_play");
      expect(tool).toBeDefined();
      expect(tool!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
      await done();
    }
  });
});

describe("ps_batch_play (gated raw batchPlay)", () => {
  let audit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    audit = vi.spyOn(log, "audit").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses with the gate off, in plain text, without touching the bridge", async () => {
    const rec = recordingBridge();
    const { c, close } = await photoshopClient(rec.bridge, GATE_OFF);
    const r = await c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(RAW_SCRIPTS_DISABLED_MESSAGE);
    expect(textOf(r)).toContain("This call targets Photoshop; currently enabled for: none.");
    expect(() => JSON.parse(textOf(r))).toThrow(); // plain text = nothing dispatched
    expect(rec.calls).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatch(/^raw-script tool=ps_batch_play app=photoshop sha256=[0-9a-f]{12} len=\d+ count=1 via=stdio outcome=refused$/);
    await close();
  });

  it("refuses a remote session unless remote raw scripts are allowed", async () => {
    const rec = recordingBridge(() => []);
    const remote = await photoshopClient(rec.bridge, { ...GATE_ON, remote: true });
    const r = await remote.c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(REMOTE_RAW_SCRIPTS_REFUSED_MESSAGE);
    expect(rec.calls).toEqual([]);
    await remote.close();

    const allowed = await photoshopClient(rec.bridge, { ...GATE_ON, remote: true, allowRemoteRawScripts: true });
    const ok = await allowed.c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(ok.isError).toBeFalsy();
    expect(rec.calls).toHaveLength(1);
    await allowed.close();
  });

  it("runs the batch and returns the envelope with the results as value", async () => {
    const results: JsonValue = [{ _obj: "fill" }, { _obj: "make", layerID: 7 }];
    const rec = recordingBridge(() => results);
    const { c, close } = await photoshopClient(rec.bridge, GATE_ON);
    const descriptors = [{ _obj: "fill", using: { _enum: "fillContents", _value: "white" } }, { _obj: "make" }];
    const r = await c.callTool({ name: "ps_batch_play", arguments: { descriptors } });
    expect(r.isError).toBeFalsy();
    const env = JSON.parse(textOf(r));
    expect(Object.keys(env)).toEqual(["ok", "durationMs", "value", "logs"]);
    expect(env).toMatchObject({ ok: true, value: results, logs: [] });
    expect(typeof env.durationMs).toBe("number");
    expect(rec.calls).toEqual([{ name: "ps.batch_play", params: { descriptors } }]);
    expect(audit).toHaveBeenCalledTimes(1);
    const line = audit.mock.calls[0]![0] as string;
    expect(line).toMatch(/^raw-script tool=ps_batch_play app=photoshop sha256=[0-9a-f]{12} len=\d+ count=2 via=stdio outcome=run$/);
    expect(line).toContain(`len=${JSON.stringify(descriptors).length} `);
    expect(line).not.toContain("fillContents");
    await close();
  });

  it("reports an in-band error entry as a dispatched failure naming the index", async () => {
    const results: JsonValue = [{ _obj: "fill" }, { _obj: "error", message: "x", result: -25920 }];
    const rec = recordingBridge(() => results);
    const { c, close } = await photoshopClient(rec.bridge, GATE_ON);
    const r = await c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }, { _obj: "make" }, { _obj: "set" }] } });
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r)); // a JSON envelope = the batch was dispatched
    expect(Object.keys(env)).toEqual(["ok", "error", "durationMs", "value", "logs"]);
    expect(env.ok).toBe(false);
    expect(env.value).toEqual(results);
    expect(env.error.line).toBeNull();
    expect(env.error.bodyLine).toBeNull();
    expect(env.error.message).toContain("descriptors[1] (make) failed: x (code -25920)");
    expect(env.error.message).toContain("descriptors[0..0] already ran");
    expect(env.error.message).toContain("resend only descriptors[1..]");
    await close();
  });

  it("says nothing ran before a failing first descriptor", async () => {
    const rec = recordingBridge(() => [{ _obj: "Error", message: "nope" }]);
    const { c, close } = await photoshopClient(rec.bridge, GATE_ON);
    const r = await c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r));
    expect(env.error.message).toContain("descriptors[0] (fill) failed: nope (code ?)");
    expect(env.error.message).toContain("Nothing before it ran");
    await close();
  });

  it("passes a non-array reply through as ok:true without scanning it", async () => {
    const rec = recordingBridge(() => ({ _obj: "error", message: "not an array" }));
    const { c, close } = await photoshopClient(rec.bridge, GATE_ON);
    const r = await c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(r.isError).toBeFalsy();
    const env = JSON.parse(textOf(r));
    expect(env).toMatchObject({ ok: true, value: { _obj: "error", message: "not an array" }, logs: [] });
    await close();
  });

  it("turns a rejected batch into an envelope, and a missing panel into plain text", async () => {
    const rejected = recordingBridge(() => {
      throw new ScriptError("photoshop", "user cancelled");
    });
    const a = await photoshopClient(rejected.bridge, GATE_ON);
    const r = await a.c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(r.isError).toBe(true);
    const env = JSON.parse(textOf(r));
    expect(env).toMatchObject({ ok: false, value: null, logs: [] });
    expect(env.error.message).toContain("user cancelled — Photoshop rejected the batch; some descriptors may already have run.");
    await a.close();

    const absent = recordingBridge(() => {
      throw new AppNotConnectedError("photoshop", "Open Photoshop.");
    });
    const b = await photoshopClient(absent.bridge, GATE_ON);
    const r2 = await b.c.callTool({ name: "ps_batch_play", arguments: { descriptors: [{ _obj: "fill" }] } });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/^No running host connected for "photoshop"/);
    await b.close();
  });
});
