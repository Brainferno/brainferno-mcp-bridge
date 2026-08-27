import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { args, parseLoudnormJson, registerAudioTools, runProcess, summarizeProbe, toLoudness } from "../src/tools/audio.js";

describe("audio lane argument builders", () => {
  it("build a two-pass loudnorm from the first-pass measurement", () => {
    const m = { input_i: "-23.5", input_tp: "-3.1", input_lra: "7.2", input_thresh: "-34.0", target_offset: "0.4" };
    const a = args.normalize("in.wav", "out.wav", -16, -1.5, 11, m);
    const af = a[a.indexOf("-af") + 1];
    expect(af).toContain("measured_I=-23.5");
    expect(af).toContain("measured_TP=-3.1");
    expect(af).toContain("offset=0.4");
    expect(af).toContain("linear=true");
    expect(a.at(-1)).toBe("out.wav");
  });

  it("only add convert flags that were asked for", () => {
    expect(args.convert("a.mov", "a.wav", {})).toEqual(["-hide_banner", "-nostats", "-y", "-i", "a.mov", "-vn", "a.wav"]);
    expect(args.convert("a.wav", "a.mp3", { sampleRate: 44100, channels: 2, bitrate: "192k" })).toContain("-b:a");
  });

  it("mix applies a per-input gain and sums with amix", () => {
    const a = args.mix(["v.wav", "m.wav"], "out.wav", [1, 0.3]);
    const fc = a[a.indexOf("-filter_complex") + 1];
    expect(fc).toBe("[0:a]volume=1[a0];[1:a]volume=0.3[a1];[a0][a1]amix=inputs=2:normalize=0:duration=longest[out]");
  });

  it("parses the JSON block loudnorm prints on stderr", () => {
    const stderr = 'size=N/A time=00:00:01.00\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-20.10",\n\t"input_tp" : "-2.00",\n\t"input_lra" : "3.00",\n\t"input_thresh" : "-30.50",\n\t"target_offset" : "0.10"\n}\n';
    const l = toLoudness(parseLoudnormJson(stderr));
    expect(l.integratedLufs).toBe(-20.1);
    expect(l.truePeakDb).toBe(-2);
    expect(() => parseLoudnormJson("nothing here")).toThrow(/no measurement/);
  });

  it("summarizes ffprobe output", () => {
    const s = summarizeProbe({ format: { format_name: "wav", duration: "1.5", size: "100" }, streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "48000", channels: 2 }] });
    expect(s).toMatchObject({ format: "wav", durationSeconds: 1.5, audio: { codec: "pcm_s16le", sampleRate: 48000, channels: 2 }, videoStreams: 0 });
  });
});

async function hasFfmpeg(): Promise<boolean> {
  try {
    const r = await runProcess("ffmpeg", ["-version"], 10_000);
    return r.code === 0;
  } catch {
    return false;
  }
}

describe("audio lane against a real ffmpeg", async () => {
  const available = await hasFfmpeg();

  it.skipIf(!available)("generates a tone, probes it, measures it, normalizes it, and draws it", async () => {
    const dir = join(tmpdir(), `acm-audio-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const tone = join(dir, "tone.wav");
    const gen = await runProcess("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-af", "volume=0.1", tone], 60_000);
    expect(gen.code).toBe(0);

    const server = new McpServer({ name: "t", version: "0" });
    registerAudioTools(server, { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const text = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { type: string; text: string }[])[0]!.text) as Record<string, unknown>;

    const probe = text(await client.callTool({ name: "audio_probe", arguments: { path: tone } }));
    expect(probe["durationSeconds"]).toBeCloseTo(2, 1);

    const before = text(await client.callTool({ name: "audio_measure_loudness", arguments: { path: tone } }));
    expect(before["integratedLufs"]).toBeLessThan(-16);

    const normalized = join(dir, "tone-norm.wav");
    const norm = text(await client.callTool({ name: "audio_normalize_loudness", arguments: { input: tone, output: normalized, targetLufs: -16 } }));
    expect((norm["after"] as { integratedLufs: number }).integratedLufs).toBeCloseTo(-16, 0);
    expect((await stat(normalized)).size).toBeGreaterThan(1000);

    const wave = await client.callTool({ name: "audio_waveform_image", arguments: { path: tone, width: 400, height: 100 } });
    expect((wave.content as { type: string }[])[0]?.type).toBe("image");

    await client.close();
    await server.close();
  }, 120_000);
});
