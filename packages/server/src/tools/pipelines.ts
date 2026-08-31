import { join } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge, JsonValue } from "../bridge/types.js";
import type { JobContext, JobRegistry, JobStepDef } from "../jobs.js";
import { addLayerScript, importFootageScript, renderCompHeadless } from "./after-effects.js";
import { denoise, measureLoudness, normalizeLoudness, type AudioToolOptions } from "./audio.js";
import { exportArtboardScript } from "./illustrator.js";
import { runOrQueue, waitParam, type ProgressExtra } from "./jobs.js";
import { exportSequence, findPresets, presetRoots } from "./premiere.js";
import { guard } from "./result.js";

/**
 * Cross-application pipelines: one tool call chains several apps and the
 * ffmpeg lane, as a job with per-step progress. A failure names the step that
 * broke and the single-app tool that recovers it. Hand-off files live in the
 * job's work folder unless the caller names paths.
 */

export interface PipelineDeps {
  photoshop: AppBridge;
  afterEffects: AppBridge;
  premiere: AppBridge;
  illustrator: AppBridge;
  jobs: JobRegistry;
  audio: AudioToolOptions;
  /** Installer choice: a pipeline is registered only when every app it needs is enabled. Missing = all. */
  enabled?: Set<string>;
  /** Whether pipelines block when the caller passes no `wait` (BRAINFERNO_MCP_DEFAULT_WAIT). */
  defaultWait?: boolean;
}

const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "output";

export function registerPipelineTools(server: McpServer, deps: PipelineDeps): void {
  const wait = waitParam(deps.defaultWait ?? true, "the pipeline");
  const runPipeline = (kind: string, steps: JobStepDef[], finalize: (results: unknown[]) => unknown, doWait: boolean | undefined, extra: unknown) =>
    runOrQueue(deps.jobs, kind, steps, (results) => finalize(results), { wait: doWait ?? deps.defaultWait ?? true, timeoutMs: 30 * 60_000, extra: extra as ProgressExtra });
  const on = (...apps: string[]) => !deps.enabled || apps.every((a) => deps.enabled!.has(a));

  // ---- Photoshop → After Effects ---------------------------------------------
  if (on("photoshop", "after_effects"))
  server.registerTool(
    "pipeline_ps_to_ae",
    {
      title: "Pipeline: Photoshop → After Effects",
      description:
        "Export the active Photoshop document as a flattened image and import it into After Effects as footage; optionally add it as a " +
        "layer to a comp. Steps: ps_export → ae_import_footage → ae_add_layer. Runs as a job with progress; a failure names the step and its recovery tool.",
      inputSchema: {
        format: z.enum(["png", "jpg"]).optional().describe("Defaults to png."),
        outputPath: z.string().min(1).optional().describe("Where to write the export. Defaults to the job's work folder."),
        compId: z.number().int().optional().describe("Comp id from ae_list_compositions to add the footage to as a layer."),
        layerName: z.string().min(1).optional(),
        wait,
      },
    },
    async (a, extra) =>
      guard(async () => {
        const format = a.format ?? "png";
        const steps: JobStepDef[] = [
          {
            name: "Export from Photoshop",
            recoveryTool: "ps_export",
            run: async (ctx) => {
              const path = a.outputPath ?? join(ctx.workDir, `photoshop-export.${format}`);
              const r = obj(await deps.photoshop.execute("ps.export", { path, format, quality: 10 }, { timeoutClass: "slow" }));
              const written = str(r["path"]) ?? path;
              ctx.artifact(written);
              return { path: written };
            },
          },
          {
            name: "Import into After Effects",
            recoveryTool: "ae_import_footage",
            run: async (ctx, prev) => {
              const path = str(obj(prev[0])["path"]);
              if (!path) throw new Error("No export path from the previous step.");
              ctx.log(`importing ${path}`);
              return deps.afterEffects.evaluate(importFootageScript(path), { timeoutClass: "slow" });
            },
          },
          {
            name: "Add layer to comp",
            recoveryTool: "ae_add_layer",
            when: () => a.compId !== undefined,
            run: async (_ctx, prev) => {
              const itemId = obj(prev[1])["id"];
              if (typeof itemId !== "number") throw new Error("The imported footage has no id.");
              return deps.afterEffects.evaluate(addLayerScript({ compId: a.compId!, kind: "footage", itemId, ...(a.layerName !== undefined ? { name: a.layerName } : {}) }), { timeoutClass: "slow" });
            },
          },
        ];
        return runPipeline("pipeline_ps_to_ae", steps, (r) => ({ exportedPath: str(obj(r[0])["path"]), footage: r[1] ?? null, layer: r[2] ?? null }), a.wait, extra);
      }),
  );

  // ---- After Effects → aerender → Premiere ---------------------------------
  if (on("after_effects", "premiere"))
  server.registerTool(
    "pipeline_render_and_import",
    {
      title: "Pipeline: After Effects render → Premiere Pro",
      description:
        "Save the AE project, render a comp headlessly with aerender, import the file into the open Premiere project, and optionally insert " +
        "it into a sequence. Steps: ae_render_comp → pp_import_files → pp_insert_clip. Runs as a job with progress (aerender frame progress is logged).",
      inputSchema: {
        compName: z.string().min(1).describe("Exact After Effects composition name."),
        outputPath: z.string().min(1).optional().describe("Render output path. Defaults to <work folder>/<comp>.avi (Lossless) — give .mp4 with an H.264 output module."),
        outputModule: z.string().min(1).optional().describe("AE output module template, e.g. 'H.264 - Match Render Settings - 15 Mbps' or 'Lossless'."),
        renderSettings: z.string().min(1).optional(),
        sequenceId: z.string().optional().describe("Premiere sequence to insert into. Defaults to the active sequence."),
        insertAtSeconds: z.number().min(0).optional().describe("Insert the render into the sequence at this time. Omit to only import."),
        videoTrackIndex: z.number().int().min(0).optional().describe("0 = V1. Defaults to 0."),
        audioTrackIndex: z.number().int().min(0).optional().describe("0 = A1. Defaults to 0."),
        mode: z.enum(["insert", "overwrite"]).optional().describe("Defaults to insert."),
        wait,
      },
    },
    async (a, extra) =>
      guard(async () => {
        const steps: JobStepDef[] = [
          {
            name: "Render with aerender",
            recoveryTool: "ae_render_comp",
            run: async (ctx) => {
              const outputPath = a.outputPath ?? join(ctx.workDir, `${safeName(a.compName)}.avi`);
              const r = await renderCompHeadless(
                deps.afterEffects,
                { compName: a.compName, outputPath, ...(a.outputModule !== undefined ? { outputModule: a.outputModule } : {}), ...(a.renderSettings !== undefined ? { renderSettings: a.renderSettings } : {}) },
                { signal: ctx.signal, log: ctx.log },
              );
              ctx.artifact(r.outputPath);
              return r;
            },
          },
          {
            name: "Import into Premiere Pro",
            recoveryTool: "pp_import_files",
            run: async (ctx, prev) => {
              const path = str(obj(prev[0])["outputPath"]);
              if (!path) throw new Error("No render path from the previous step.");
              ctx.log(`importing ${path}`);
              const r = obj(await deps.premiere.execute("pp.import_files", { paths: [path], asNumberedStills: false }, { timeoutClass: "slow" }));
              const imported = Array.isArray(r["imported"]) ? (r["imported"] as unknown[]) : [];
              const first = obj(imported[0]);
              if (!str(first["id"])) throw new Error(`Premiere imported nothing for ${path}.`);
              return first;
            },
          },
          {
            name: "Insert into sequence",
            recoveryTool: "pp_insert_clip",
            when: () => a.insertAtSeconds !== undefined,
            run: async (_ctx, prev) =>
              deps.premiere.execute(
                "pp.insert_clip",
                {
                  sequenceId: a.sequenceId ?? null,
                  projectItemId: str(obj(prev[1])["id"]) ?? "",
                  seconds: a.insertAtSeconds ?? 0,
                  videoTrackIndex: a.videoTrackIndex ?? 0,
                  audioTrackIndex: a.audioTrackIndex ?? 0,
                  mode: a.mode ?? "insert",
                  limitShift: true,
                },
                { timeoutClass: "slow" },
              ),
          },
        ];
        return runPipeline("pipeline_render_and_import", steps, (r) => ({ render: r[0], projectItem: r[1], inserted: r[2] ?? null }), a.wait, extra);
      }),
  );

  // ---- Premiere audio → ffmpeg → Premiere ----------------------------------
  if (on("premiere"))
  server.registerTool(
    "pipeline_audio_roundtrip",
    {
      title: "Pipeline: Premiere audio → ffmpeg → Premiere",
      description:
        "Export a sequence's audio as WAV, measure it, optionally denoise, normalize loudness (EBU R128 two-pass), import the result and " +
        "lay it on an audio track. Steps: pp_export_sequence → audio_measure_loudness → audio_denoise → audio_normalize_loudness → pp_import_files → pp_insert_clip.",
      inputSchema: {
        sequenceId: z.string().optional().describe("Defaults to the active sequence."),
        presetPath: z.string().min(1).optional().describe("WAV encoder preset (.epr). Defaults to Adobe's 'Waveform Audio 48kHz 16-bit'."),
        targetLufs: z.number().max(-5).min(-70).optional().describe("Defaults to -16."),
        truePeakDb: z.number().max(0).min(-9).optional().describe("Defaults to -1.5."),
        denoise: z.boolean().optional().describe("Run afftdn before normalizing. Defaults to false."),
        insertAtSeconds: z.number().min(0).optional().describe("Where to place the processed audio. Defaults to 0. Set null-like by omitting insert via audioTrackIndex -1? No: pass insert=false."),
        insert: z.boolean().optional().describe("Insert the processed audio back into the sequence (overwrite). Defaults to true."),
        audioTrackIndex: z.number().int().min(0).optional().describe("Target audio track, 0 = A1. Defaults to 1 (A2) so the original stays."),
        wait,
      },
    },
    async (a, extra) =>
      guard(async () => {
        const steps: JobStepDef[] = [
          {
            name: "Export sequence audio from Premiere Pro",
            recoveryTool: "pp_export_sequence",
            run: async (ctx) => {
              let presetPath = a.presetPath;
              if (!presetPath) {
                const found = await findPresets(presetRoots(), "Waveform Audio 48kHz");
                presetPath = found[0]?.path;
                if (!presetPath) throw new Error("No WAV encoder preset found. Pass presetPath (see pp_list_export_presets with filter 'Waveform').");
              }
              const outputPath = join(ctx.workDir, "sequence-audio.wav");
              ctx.log(`exporting with ${presetPath}`);
              await exportSequence(deps.premiere, { outputPath, presetPath, mode: "immediately", full: true, ...(a.sequenceId !== undefined ? { sequenceId: a.sequenceId } : {}) });
              ctx.artifact(outputPath);
              return { path: outputPath, presetPath };
            },
          },
          {
            name: "Measure loudness",
            recoveryTool: "audio_measure_loudness",
            run: (ctx, prev) => measureLoudness(deps.audio, str(obj(prev[0])["path"]) ?? "", ctx.signal),
          },
          {
            name: "Denoise",
            recoveryTool: "audio_denoise",
            when: () => a.denoise === true,
            run: async (ctx, prev) => {
              const out = join(ctx.workDir, "sequence-audio-denoised.wav");
              const r = await denoise(deps.audio, str(obj(prev[0])["path"]) ?? "", out, 12, -30, ctx.signal);
              ctx.artifact(out);
              return { path: out, ...r };
            },
          },
          {
            name: "Normalize loudness",
            recoveryTool: "audio_normalize_loudness",
            run: async (ctx, prev) => {
              const input = str(obj(prev[2])["path"]) ?? str(obj(prev[0])["path"]) ?? "";
              const out = join(ctx.workDir, "sequence-audio-normalized.wav");
              const r = await normalizeLoudness(deps.audio, input, out, { targetLufs: a.targetLufs ?? -16, truePeakDb: a.truePeakDb ?? -1.5, loudnessRange: 11 }, ctx.signal);
              ctx.artifact(out);
              return { path: out, ...r };
            },
          },
          {
            name: "Import into Premiere Pro",
            recoveryTool: "pp_import_files",
            run: async (_ctx, prev) => {
              const path = str(obj(prev[3])["path"]) ?? "";
              const r = obj(await deps.premiere.execute("pp.import_files", { paths: [path], asNumberedStills: false }, { timeoutClass: "slow" }));
              const first = obj((Array.isArray(r["imported"]) ? (r["imported"] as unknown[]) : [])[0]);
              if (!str(first["id"])) throw new Error(`Premiere imported nothing for ${path}.`);
              return first;
            },
          },
          {
            name: "Insert on audio track",
            recoveryTool: "pp_insert_clip",
            when: () => a.insert !== false,
            run: (_ctx, prev) =>
              deps.premiere.execute(
                "pp.insert_clip",
                { sequenceId: a.sequenceId ?? null, projectItemId: str(obj(prev[4])["id"]) ?? "", seconds: a.insertAtSeconds ?? 0, videoTrackIndex: 0, audioTrackIndex: a.audioTrackIndex ?? 1, mode: "overwrite", limitShift: true },
                { timeoutClass: "slow" },
              ),
          },
        ];
        return runPipeline(
          "pipeline_audio_roundtrip",
          steps,
          (r) => ({ exportedPath: str(obj(r[0])["path"]), before: r[1], denoised: r[2] ?? null, normalized: r[3], projectItem: r[4], inserted: r[5] ?? null }),
          a.wait,
          extra,
        );
      }),
  );

  // ---- Illustrator → Photoshop ---------------------------------------------
  if (on("illustrator", "photoshop"))
  server.registerTool(
    "pipeline_ai_to_ps",
    {
      title: "Pipeline: Illustrator → Photoshop",
      description:
        "Export the active Illustrator artboard as a PNG and place it into the active Photoshop document as a new smart-object layer. " +
        "Steps: ai_export_artboard → ps_place_image.",
      inputSchema: {
        scalePercent: z.number().positive().max(1000).optional().describe("Export scale, 100 = artboard size at 72 ppi. Defaults to 200 for a crisp placement."),
        outputPath: z.string().min(1).optional().describe("Where to write the PNG. Defaults to the job's work folder."),
        layerName: z.string().min(1).optional(),
        wait,
      },
    },
    async (a, extra) =>
      guard(async () => {
        const steps: JobStepDef[] = [
          {
            name: "Export artboard from Illustrator",
            recoveryTool: "ai_export_artboard",
            run: async (ctx) => {
              const path = a.outputPath ?? join(ctx.workDir, "artboard.png");
              const r = obj(await deps.illustrator.evaluate(exportArtboardScript("png", path, a.scalePercent ?? 200), { timeoutClass: "slow" }));
              const written = str(r["path"]) ?? path;
              ctx.artifact(written);
              return { path: written };
            },
          },
          {
            name: "Place into Photoshop",
            recoveryTool: "ps_place_image",
            run: (_ctx, prev) => deps.photoshop.execute("ps.place_image", { path: str(obj(prev[0])["path"]) ?? "", name: a.layerName ?? null }, { timeoutClass: "slow" }),
          },
        ];
        return runPipeline("pipeline_ai_to_ps", steps, (r) => ({ exportedPath: str(obj(r[0])["path"]), layer: r[1] }), a.wait, extra);
      }),
  );
}

/** Exported for tests: a step that just records its context. */
export function noopStep(name: string, value: JsonValue): JobStepDef {
  return { name, run: async (_ctx: JobContext) => value };
}
