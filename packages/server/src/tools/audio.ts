import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { guard, imageResult, jsonResult } from "./result.js";

/**
 * The audio process lane: deterministic audio work through ffmpeg/ffprobe,
 * independent of Audition (works with every Adobe app closed). Audition's
 * scripting DOM is thin and menu-driven, so measurement, loudness
 * normalization, conversion, trimming, denoising and mixing live here.
 *
 * Every tool takes absolute paths and writes a new file — inputs are never
 * modified in place.
 */

export interface AudioToolOptions {
  ffmpegPath: string;
  ffprobePath: string;
}

const TEN_MINUTES = 10 * 60_000;

export function runProcess(exe: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${exe} did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(`${exe} was not found. Install ffmpeg (https://ffmpeg.org) or set ADOBE_CC_MCP_FFMPEG / ADOBE_CC_MCP_FFPROBE to its path.`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function fail(what: string, stderr: string): never {
  const tail = stderr.trim().split(/\r?\n/).filter((l) => l.trim() !== "").slice(-4).join(" | ");
  throw new Error(`${what} failed: ${tail || "no output from ffmpeg"}`);
}

/** Pull the JSON object loudnorm prints at the end of its stderr. */
export function parseLoudnormJson(stderr: string): Record<string, string> {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm printed no measurement (is the input an audio file?)");
  return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
}

export interface Loudness {
  integratedLufs: number;
  truePeakDb: number;
  loudnessRange: number;
  threshold: number;
  raw: Record<string, string>;
}

export function toLoudness(raw: Record<string, string>): Loudness {
  return {
    integratedLufs: Number(raw["input_i"]),
    truePeakDb: Number(raw["input_tp"]),
    loudnessRange: Number(raw["input_lra"]),
    threshold: Number(raw["input_thresh"]),
    raw,
  };
}

/** Argument builders are exported so tests can check them without running ffmpeg. */
export const args = {
  probe: (input: string) => ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
  measure: (input: string, targetLufs: number, truePeak: number, lra: number) => [
    "-hide_banner",
    "-nostats",
    "-i",
    input,
    "-af",
    `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:print_format=json`,
    "-f",
    "null",
    "-",
  ],
  normalize: (input: string, output: string, targetLufs: number, truePeak: number, lra: number, m: Record<string, string>) => [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    input,
    "-af",
    `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:measured_I=${m["input_i"]}:measured_TP=${m["input_tp"]}:measured_LRA=${m["input_lra"]}:measured_thresh=${m["input_thresh"]}:offset=${m["target_offset"]}:linear=true:print_format=json`,
    "-vn",
    output,
  ],
  convert: (input: string, output: string, o: { sampleRate?: number; channels?: number; bitrate?: string; codec?: string }) => [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    input,
    "-vn",
    ...(o.sampleRate !== undefined ? ["-ar", String(o.sampleRate)] : []),
    ...(o.channels !== undefined ? ["-ac", String(o.channels)] : []),
    ...(o.bitrate !== undefined ? ["-b:a", o.bitrate] : []),
    ...(o.codec !== undefined ? ["-c:a", o.codec] : []),
    output,
  ],
  trim: (input: string, output: string, start: number | undefined, end: number | undefined) => [
    "-hide_banner",
    "-nostats",
    "-y",
    ...(start !== undefined ? ["-ss", String(start)] : []),
    ...(end !== undefined ? ["-to", String(end)] : []),
    "-i",
    input,
    "-vn",
    output,
  ],
  trimSilence: (input: string, output: string, thresholdDb: number, minSilence: number) => [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    input,
    "-af",
    `silenceremove=start_periods=1:start_threshold=${thresholdDb}dB:start_silence=${minSilence},areverse,silenceremove=start_periods=1:start_threshold=${thresholdDb}dB:start_silence=${minSilence},areverse`,
    "-vn",
    output,
  ],
  denoise: (input: string, output: string, reductionDb: number, noiseFloorDb: number) => [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    input,
    "-af",
    `afftdn=nr=${reductionDb}:nf=${noiseFloorDb}:tn=1`,
    "-vn",
    output,
  ],
  mix: (inputs: string[], output: string, volumes: number[] | undefined) => {
    const filters = inputs.map((_, i) => `[${i}:a]volume=${volumes?.[i] ?? 1}[a${i}]`).join(";");
    const labels = inputs.map((_, i) => `[a${i}]`).join("");
    return [
      "-hide_banner",
      "-nostats",
      "-y",
      ...inputs.flatMap((p) => ["-i", p]),
      "-filter_complex",
      `${filters};${labels}amix=inputs=${inputs.length}:normalize=0:duration=longest[out]`,
      "-map",
      "[out]",
      output,
    ];
  },
  waveform: (input: string, output: string, width: number, height: number, color: string) => [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    input,
    "-filter_complex",
    `color=c=#1e1e2e:s=${width}x${height}[bg];[0:a]showwavespic=s=${width}x${height}:colors=${color}:scale=lin[w];[bg][w]overlay=format=auto`,
    "-frames:v",
    "1",
    output,
  ],
};

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  width?: number;
  height?: number;
  duration?: string;
}
interface ProbeOutput {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams?: ProbeStream[];
}

export function summarizeProbe(p: ProbeOutput) {
  const audio = (p.streams ?? []).filter((s) => s.codec_type === "audio");
  const video = (p.streams ?? []).filter((s) => s.codec_type === "video");
  const a = audio[0];
  return {
    format: p.format?.format_name ?? null,
    durationSeconds: p.format?.duration !== undefined ? Number(p.format.duration) : null,
    sizeBytes: p.format?.size !== undefined ? Number(p.format.size) : null,
    bitRate: p.format?.bit_rate !== undefined ? Number(p.format.bit_rate) : null,
    audio: a
      ? { codec: a.codec_name ?? null, sampleRate: a.sample_rate !== undefined ? Number(a.sample_rate) : null, channels: a.channels ?? null, channelLayout: a.channel_layout ?? null, bitRate: a.bit_rate !== undefined ? Number(a.bit_rate) : null }
      : null,
    audioStreams: audio.length,
    videoStreams: video.length,
    video: video[0] ? { codec: video[0].codec_name ?? null, width: video[0].width ?? null, height: video[0].height ?? null } : null,
  };
}

export function registerAudioTools(server: McpServer, options: AudioToolOptions): void {
  const ffmpeg = (a: string[], what: string, timeoutMs = TEN_MINUTES) =>
    runProcess(options.ffmpegPath, a, timeoutMs).then((r) => (r.code === 0 ? r : fail(what, r.stderr)));

  const ensureDir = async (output: string) => mkdir(dirname(output), { recursive: true });
  const outInfo = async (output: string) => ({ output, sizeBytes: (await stat(output)).size });

  const input = z.string().min(1).describe("Absolute path of the input file (audio, or a video whose audio track is used).");
  const output = z.string().min(1).describe("Absolute path of the file to write; the extension picks the format (.wav, .mp3, .aac, .flac, .m4a…).");

  server.registerTool(
    "audio_probe",
    {
      title: "Audio: probe a file",
      description: "Read a media file's format, duration, sample rate, channels, codec and bit rate with ffprobe. Works on video files too.",
      inputSchema: { path: input },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) =>
      guard(async () => {
        const r = await runProcess(options.ffprobePath, args.probe(path), 60_000);
        if (r.code !== 0) fail("ffprobe", r.stderr);
        return jsonResult(summarizeProbe(JSON.parse(r.stdout) as ProbeOutput));
      }),
  );

  server.registerTool(
    "audio_measure_loudness",
    {
      title: "Audio: measure loudness",
      description: "Measure integrated loudness (LUFS), true peak (dBTP) and loudness range (EBU R128) with ffmpeg's loudnorm. Nothing is written.",
      inputSchema: { path: input },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) =>
      guard(async () => {
        const r = await ffmpeg(args.measure(path, -16, -1.5, 11), "loudness measurement");
        return jsonResult(toLoudness(parseLoudnormJson(r.stderr)));
      }),
  );

  server.registerTool(
    "audio_normalize_loudness",
    {
      title: "Audio: normalize loudness (EBU R128, two-pass)",
      description:
        "Write a copy normalized to a target integrated loudness with a true-peak ceiling (two-pass loudnorm, linear gain when possible). " +
        "Defaults suit podcasts/social (-16 LUFS, -1.5 dBTP); broadcast is -23 LUFS, -1 dBTP; Apple Music -16, Spotify/YouTube -14.",
      inputSchema: {
        input,
        output,
        targetLufs: z.number().max(-5).min(-70).optional().describe("Integrated loudness target. Defaults to -16."),
        truePeakDb: z.number().max(0).min(-9).optional().describe("True-peak ceiling in dBTP. Defaults to -1.5."),
        loudnessRange: z.number().min(1).max(50).optional().describe("Target loudness range (LU). Defaults to 11."),
      },
    },
    async (a) =>
      guard(async () => {
        const I = a.targetLufs ?? -16;
        const TP = a.truePeakDb ?? -1.5;
        const LRA = a.loudnessRange ?? 11;
        const pass1 = await ffmpeg(args.measure(a.input, I, TP, LRA), "loudness measurement");
        const before = parseLoudnormJson(pass1.stderr);
        await ensureDir(a.output);
        const pass2 = await ffmpeg(args.normalize(a.input, a.output, I, TP, LRA, before), "loudness normalization");
        const after = parseLoudnormJson(pass2.stderr);
        return jsonResult({
          ...(await outInfo(a.output)),
          target: { integratedLufs: I, truePeakDb: TP, loudnessRange: LRA },
          before: toLoudness(before),
          after: { integratedLufs: Number(after["output_i"]), truePeakDb: Number(after["output_tp"]), loudnessRange: Number(after["output_lra"]) },
        });
      }),
  );

  server.registerTool(
    "audio_convert",
    {
      title: "Audio: convert / extract",
      description:
        "Convert an audio file, or extract the audio track from a video, to another format. The output extension picks the container/codec " +
        "(e.g. .wav, .mp3, .m4a, .flac); optionally resample, change channel count, or set a bit rate.",
      inputSchema: {
        input,
        output,
        sampleRate: z.number().int().positive().optional().describe("e.g. 48000."),
        channels: z.number().int().min(1).max(8).optional().describe("1 = mono, 2 = stereo."),
        bitrate: z.string().regex(/^\d+k$/).optional().describe("Lossy bit rate like 192k."),
        codec: z.string().min(1).optional().describe("Explicit ffmpeg audio codec (pcm_s24le, aac, libmp3lame, flac…). Usually unnecessary."),
      },
    },
    async (a) =>
      guard(async () => {
        await ensureDir(a.output);
        await ffmpeg(args.convert(a.input, a.output, { sampleRate: a.sampleRate, channels: a.channels, bitrate: a.bitrate, codec: a.codec }), "conversion");
        return jsonResult(await outInfo(a.output));
      }),
  );

  server.registerTool(
    "audio_trim",
    {
      title: "Audio: trim to a time range",
      description: "Write the part of a file between two times (seconds). Omit one end to keep from the start or to the end.",
      inputSchema: {
        input,
        output,
        startSeconds: z.number().min(0).optional(),
        endSeconds: z.number().min(0).optional(),
      },
    },
    async (a) =>
      guard(async () => {
        if (a.startSeconds === undefined && a.endSeconds === undefined) throw new Error("Give startSeconds and/or endSeconds.");
        await ensureDir(a.output);
        await ffmpeg(args.trim(a.input, a.output, a.startSeconds, a.endSeconds), "trim");
        return jsonResult(await outInfo(a.output));
      }),
  );

  server.registerTool(
    "audio_trim_silence",
    {
      title: "Audio: trim leading and trailing silence",
      description: "Remove silence from the start and end of a file (not from the middle).",
      inputSchema: {
        input,
        output,
        thresholdDb: z.number().max(0).min(-90).optional().describe("Anything quieter counts as silence. Defaults to -50 dB."),
        minSilenceSeconds: z.number().positive().optional().describe("How long it must stay quiet to count. Defaults to 0.5."),
      },
    },
    async (a) =>
      guard(async () => {
        await ensureDir(a.output);
        await ffmpeg(args.trimSilence(a.input, a.output, a.thresholdDb ?? -50, a.minSilenceSeconds ?? 0.5), "silence trim");
        return jsonResult(await outInfo(a.output));
      }),
  );

  server.registerTool(
    "audio_denoise",
    {
      title: "Audio: reduce broadband noise",
      description: "Write a denoised copy using ffmpeg's FFT denoiser (afftdn) with noise tracking. Good for room tone and hiss; gentle settings by default.",
      inputSchema: {
        input,
        output,
        reductionDb: z.number().min(0.01).max(97).optional().describe("Noise reduction amount in dB. Defaults to 12."),
        noiseFloorDb: z.number().min(-80).max(-20).optional().describe("Estimated noise floor. Defaults to -30."),
      },
    },
    async (a) =>
      guard(async () => {
        await ensureDir(a.output);
        await ffmpeg(args.denoise(a.input, a.output, a.reductionDb ?? 12, a.noiseFloorDb ?? -30), "denoise");
        return jsonResult(await outInfo(a.output));
      }),
  );

  server.registerTool(
    "audio_mix",
    {
      title: "Audio: mix files together",
      description: "Sum several audio files into one (e.g. voice + music bed), each with its own gain. Length = the longest input.",
      inputSchema: {
        inputs: z.array(z.string().min(1)).min(2).describe("Absolute paths, mixed in parallel from time 0."),
        output,
        volumes: z.array(z.number().min(0).max(10)).optional().describe("Linear gain per input (1 = unchanged, 0.3 = music bed). Same order as inputs."),
      },
    },
    async (a) =>
      guard(async () => {
        if (a.volumes !== undefined && a.volumes.length !== a.inputs.length) throw new Error("volumes must have one entry per input.");
        await ensureDir(a.output);
        await ffmpeg(args.mix(a.inputs, a.output, a.volumes), "mix");
        return jsonResult(await outInfo(a.output));
      }),
  );

  server.registerTool(
    "audio_waveform_image",
    {
      title: "Audio: draw the waveform",
      description: "Render a file's waveform to a PNG and return it as an image so you can see levels, silences and clipping.",
      inputSchema: {
        path: input,
        width: z.number().int().min(64).max(4096).optional().describe("Defaults to 1200."),
        height: z.number().int().min(32).max(2048).optional().describe("Defaults to 300."),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Waveform color. Defaults to #f5a623."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      guard(async () => {
        const dir = join(tmpdir(), "adobe-cc-mcp", "previews");
        await mkdir(dir, { recursive: true });
        const out = join(dir, `${randomUUID()}.png`);
        await ffmpeg(args.waveform(a.path, out, a.width ?? 1200, a.height ?? 300, a.color ?? "#f5a623"), "waveform render", 120_000);
        return imageResult(out, "image/png", `Waveform of ${a.path}`);
      }),
  );
}
