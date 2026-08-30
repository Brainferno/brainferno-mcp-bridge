import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppBridge, JsonValue } from "../src/bridge/types.js";
import { findPresets, presetRoots, registerPremiereTools } from "../src/tools/premiere.js";

function recordingBridge() {
  const calls: { name: string; params: JsonValue | undefined }[] = [];
  const bridge: AppBridge = {
    appId: "premiere",
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

describe("Premiere tools send named commands", () => {
  let client: Client;
  let calls: { name: string; params: JsonValue | undefined }[];
  let close: () => Promise<void>;

  beforeEach(async () => {
    const rec = recordingBridge();
    calls = rec.calls;
    const server = new McpServer({ name: "t", version: "0" });
    registerPremiereTools(server, rec.bridge);
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

  it("registers the v1 tool set", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of [
      "pp_project_info",
      "pp_list_sequences",
      "pp_list_project_items",
      "pp_get_sequence",
      "pp_list_markers",
      "pp_list_transitions",
      "pp_list_effects",
      "pp_get_clip_effects",
      "pp_open_project",
      "pp_create_project",
      "pp_save_project",
      "pp_import_files",
      "pp_create_sequence",
      "pp_set_active_sequence",
      "pp_set_player_position",
      "pp_insert_clip",
      "pp_remove_clips",
      "pp_move_clip",
      "pp_trim_clip",
      "pp_set_clip_props",
      "pp_add_transition",
      "pp_apply_effect",
      "pp_remove_effect",
      "pp_set_effect_param",
      "pp_add_marker",
      "pp_export_frame",
      "pp_list_export_presets",
      "pp_export_sequence",
    ]) {
      expect(names, n).toContain(n);
    }
  });

  it("fills clip-reference and mode defaults", async () => {
    await client.callTool({ name: "pp_insert_clip", arguments: { projectItemId: "abc", seconds: 2 } });
    expect(calls.at(-1)).toEqual({
      name: "pp.insert_clip",
      params: { sequenceId: null, projectItemId: "abc", seconds: 2, videoTrackIndex: 0, audioTrackIndex: 0, mode: "insert", limitShift: true },
    });

    await client.callTool({ name: "pp_add_transition", arguments: { clipIndex: 1 } });
    expect(calls.at(-1)?.params).toMatchObject({ trackType: "video", trackIndex: 0, clipIndex: 1, matchName: null, position: "end" });

    await client.callTool({ name: "pp_set_effect_param", arguments: { component: "Motion", param: "Scale", value: 50, seconds: 1.5 } });
    expect(calls.at(-1)?.params).toMatchObject({ component: "Motion", param: "Scale", value: 50, seconds: 1.5, interpolation: null });

    await client.callTool({ name: "pp_remove_clips", arguments: { clips: [{ clipIndex: 2 }, { trackType: "audio" }] } });
    expect(calls.at(-1)?.params).toEqual({
      sequenceId: null,
      clips: [
        { trackType: "video", trackIndex: 0, clipIndex: 2 },
        { trackType: "audio", trackIndex: 0, clipIndex: 0 },
      ],
      ripple: true,
    });
  });

  it("rejects bad input before sending anything", async () => {
    const before = calls.length;
    const r1 = await client.callTool({ name: "pp_insert_clip", arguments: { projectItemId: "abc", seconds: -1 } });
    expect(r1.isError).toBe(true);
    const r2 = await client.callTool({ name: "pp_add_marker", arguments: { name: "x", seconds: 1, type: "bookmark" } });
    expect(r2.isError).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("asks the panel for a frame in the previews folder and names the file itself", async () => {
    // The recording bridge never writes a file, so the tool must time out cleanly.
    const server = new McpServer({ name: "t2", version: "0" });
    const rec = recordingBridge();
    registerPremiereTools(server, rec.bridge);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test2", version: "0" });
    await Promise.all([c.connect(ct), server.connect(st)]);
    const call = c.callTool({ name: "pp_export_frame", arguments: { seconds: 3 } });
    // Give the tool a moment to send the command, then satisfy it by writing the file.
    await new Promise((r) => setTimeout(r, 50));
    const sent = rec.calls.at(-1);
    expect(sent?.name).toBe("pp.export_frame");
    const p = sent?.params as { dir: string; baseName: string; seconds: number };
    expect(p.seconds).toBe(3);
    await mkdir(p.dir, { recursive: true });
    await writeFile(join(p.dir, `${p.baseName}.png`), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect((result.content as { type: string }[])[0]?.type).toBe("image");
    await c.close();
    await server.close();
  });
});

describe("export preset discovery", () => {
  it("knows the Adobe preset roots per platform", () => {
    expect(presetRoots("win32", "C:\\Users\\x").some((r) => /Adobe$/.test(r))).toBe(true);
    expect(presetRoots("darwin", "/Users/x")[0]).toBe("/Applications");
    // Adobe ships Creative Cloud for Windows and macOS only: nowhere else has presets to find.
    expect(presetRoots("unsupported" as NodeJS.Platform, "/home/x")).toEqual([]);
  });

  it("walks a folder for .epr files and filters by substring", async () => {
    const root = join(tmpdir(), `acm-presets-${process.pid}`);
    const dir = join(root, "Adobe Media Encoder 2026", "MediaIO", "systempresets", "H264");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Match Source - Adaptive High Bitrate.epr"), "<x/>");
    await writeFile(join(dir, "Other.epr"), "<x/>");
    await writeFile(join(dir, "notes.txt"), "");
    const all = await findPresets([root], undefined);
    expect(all.map((p) => p.name).sort()).toEqual(["Match Source - Adaptive High Bitrate", "Other"]);
    const some = await findPresets([root], "adaptive");
    expect(some).toHaveLength(1);
    expect(some[0]?.category).toContain("H264");
  });
});
