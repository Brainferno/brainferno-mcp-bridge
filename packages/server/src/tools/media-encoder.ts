import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { isSuccessStatus, type AmeJobInfo, type AmeWebService } from "../drivers/ame-webservice.js";
import type { JobRegistry, JobStepDef } from "../jobs.js";
import { runOrQueue, type ProgressExtra } from "./jobs.js";
import { findPresets, presetRoots } from "./premiere.js";
import { errorResult, guard, jsonResult } from "./result.js";

/**
 * Adobe Media Encoder through its built-in web service (see
 * drivers/ame-webservice.ts). Headless: no panel, no AME window. The server
 * starts the service on the first job and stops it after an idle period.
 */

export interface MediaEncoderToolOptions {
  jobs?: JobRegistry;
}

const presetDoc = "Encoder preset: give presetPath (absolute .epr) or presetName (substring, resolved with the same search as pp_list_export_presets, e.g. 'H264 Match Source - High bitrate', 'MP3 128', 'Waveform Audio 48kHz').";

export function registerMediaEncoderTools(server: McpServer, ame: AmeWebService, options: MediaEncoderToolOptions = {}): void {
  // The service runs one job at a time: submissions queue behind each other.
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const resolvePreset = async (presetPath: string | undefined, presetName: string | undefined): Promise<string> => {
    if (presetPath) return presetPath;
    if (!presetName) throw new Error("Give presetPath or presetName.");
    const found = await findPresets(presetRoots(), presetName, 5);
    const hit = found[0];
    if (!hit) throw new Error(`No encoder preset matching "${presetName}". Call pp_list_export_presets to browse.`);
    return hit.path;
  };

  server.registerTool(
    "ame_server",
    {
      title: "Media Encoder: service status",
      description:
        "Status of Adobe Media Encoder's headless web service (address, online, current job). With start=true the service is started " +
        "(hidden AME renderer, ~5–20 s) if it is not already running.",
      inputSchema: { start: z.boolean().optional().describe("Start the service if needed. Defaults to false.") },
      annotations: { readOnlyHint: true },
    },
    async ({ start }) =>
      guard(async () => {
        if (!ame.isRunning && !start) {
          return jsonResult({ running: false, hint: "Call ame_server with start=true, or ame_encode (it starts the service itself)." });
        }
        const url = await ame.ensureRunning();
        return jsonResult({ running: true, address: url, ...(await ame.server()) });
      }),
  );

  server.registerTool(
    "ame_encode",
    {
      title: "Media Encoder: encode a file, sequence or project",
      description:
        "Encode with Adobe Media Encoder, headless: any media file, a Premiere .prproj (optionally a specific sequence by id from pp_list_sequences), " +
        "or FCP XML, with an .epr preset, to an output path. Runs as a job (progress, cancel); the service is started on demand. " +
        presetDoc,
      inputSchema: {
        source: z.string().min(1).describe("Absolute path of the media file, .prproj, or FCP .xml."),
        output: z.string().min(1).describe("Absolute output path; the preset decides the format, so match the extension (.mp4, .mp3, .mov…)."),
        presetPath: z.string().min(1).optional(),
        presetName: z.string().min(1).optional(),
        sequenceId: z.string().min(1).optional().describe("For a .prproj source: the sequence GUID to render (default: the first sequence)."),
        overwrite: z.boolean().optional().describe("Replace an existing output file. Defaults to true."),
        wait: z.boolean().optional().describe("Block until the encode finishes (default). false returns a jobId at once; poll with cc_job_wait."),
      },
    },
    async (a, extra) =>
      guard(async () => {
        const presetPath = await resolvePreset(a.presetPath, a.presetName);
        let ameJobId = "";
        const steps: JobStepDef[] = [
          {
            name: "Start Media Encoder service",
            recoveryTool: "ame_server",
            run: async (ctx) => {
              const url = await ame.ensureRunning();
              ctx.log(`service at ${url}`);
              return { address: url };
            },
          },
          {
            name: "Submit job",
            recoveryTool: "ame_encode",
            run: async (ctx) => {
              await mkdir(dirname(a.output), { recursive: true });
              const info = await serialized(() => ame.submit({ sourcePath: a.source, presetPath, destinationPath: a.output, overwrite: a.overwrite ?? true, ...(a.sequenceId !== undefined ? { sequenceGuid: a.sequenceId } : {}) }));
              ameJobId = info.jobId;
              ctx.log(`AME job ${info.jobId}: ${info.jobStatus} ${info.details}`);
              return info;
            },
          },
          {
            name: "Encode",
            recoveryTool: "ame_job_status",
            run: async (ctx) => {
              const final = await ame.waitForJob(ameJobId, {
                timeoutMs: 6 * 60 * 60_000,
                signal: ctx.signal,
                onProgress: (j) => ctx.progress(`${j.jobStatus}${j.jobProgress ? ` ${j.jobProgress}%` : ""}${j.details ? ` — ${j.details}` : ""}`, Number(j.jobProgress) || undefined),
              });
              if (!isSuccessStatus(final.jobStatus)) throw new Error(`Media Encoder reported ${final.jobStatus}: ${final.details}`);
              ctx.artifact(a.output);
              return final;
            },
          },
        ];
        if (!options.jobs) {
          // No registry (tests / minimal setups): run inline.
          for (const s of steps) await s.run({ jobId: "inline", workDir: "", signal: new AbortController().signal, log: () => {}, progress: () => {}, artifact: () => {} }, []);
          return jsonResult({ output: a.output, ameJobId, presetPath });
        }
        return runOrQueue(options.jobs, "ame_encode", steps, (r) => ({ output: a.output, presetPath, ameJobId, final: r[2] as AmeJobInfo }), { wait: a.wait ?? true, timeoutMs: 6 * 60 * 60_000, extra: extra as ProgressExtra });
      }),
  );

  server.registerTool(
    "ame_job_status",
    {
      title: "Media Encoder: current job",
      description: "The service's current (or last) job: status, progress, details, source/preset/output paths.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        if (!ame.isRunning) return jsonResult({ running: false, job: null });
        return jsonResult({ running: true, job: await ame.job() });
      }),
  );

  server.registerTool(
    "ame_history",
    {
      title: "Media Encoder: job history",
      description: "Completed jobs the service remembers (newest first), with status and paths.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Defaults to 20.") },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      guard(async () => {
        if (!ame.isRunning) return jsonResult([]);
        const all = await ame.history();
        return jsonResult(all.reverse().slice(0, limit ?? 20));
      }),
  );

  server.registerTool(
    "ame_cancel",
    {
      title: "Media Encoder: abort the current job",
      description: "Abort the job Media Encoder is working on (or a given AME job id).",
      inputSchema: { ameJobId: z.string().min(1).optional().describe("Defaults to the current job.") },
    },
    async ({ ameJobId }) =>
      guard(async () => {
        if (!ame.isRunning) return errorResult("Media Encoder web service is not running.");
        const id = ameJobId ?? (await ame.job()).jobId;
        if (!id) return errorResult("No current job to cancel.");
        return jsonResult(await ame.cancel(id));
      }),
  );

  server.registerTool(
    "ame_stop_server",
    {
      title: "Media Encoder: stop the service",
      description: "Stop the headless Media Encoder web service (and its renderer) now instead of waiting for the idle timeout.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        await ame.stop();
        return jsonResult({ running: ame.isRunning });
      }),
  );
}
