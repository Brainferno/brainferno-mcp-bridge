import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isTerminal, jobView, type Job, type JobRegistry, type JobStepDef } from "../jobs.js";
import { errorResult, guard, jsonResult } from "./result.js";

/** The slice of the SDK's request `extra` that progress reporting needs. */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
}

export type ProgressFn = (message: string, percent?: number) => void;

/**
 * The `wait` parameter of a long tool, described to match the configured
 * default (BRAINFERNO_MCP_DEFAULT_WAIT) so every client sees the truth.
 */
export function waitParam(defaultWait: boolean, what: string): z.ZodOptional<z.ZodBoolean> {
  return z
    .boolean()
    .optional()
    .describe(
      defaultWait
        ? `Block until ${what} finishes (default; set by BRAINFERNO_MCP_DEFAULT_WAIT). false returns a jobId at once; poll with cc_job_wait.`
        : `Block until ${what} finishes. Default false (set by BRAINFERNO_MCP_DEFAULT_WAIT): returns a jobId at once; poll with cc_job_wait.`,
    );
}

/**
 * Best-effort MCP progress notifications against the client's progressToken.
 * A client that sent no token gets a no-op. Sending never throws into the tool.
 */
export function progressReporter(extra: ProgressExtra | undefined): ProgressFn {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || send === undefined) return () => {};
  return (message, percent) => {
    void send({ method: "notifications/progress", params: { progressToken: token, progress: Math.max(0, Math.min(100, Math.round(percent ?? 0))), total: 100, message } }).catch(() => {});
  };
}

export interface RunOrQueueOptions {
  /** Block until the job finishes (or the timeout), streaming progress. */
  wait: boolean;
  timeoutMs: number;
  extra?: ProgressExtra;
}

/**
 * Start a job. With `wait` the call blocks (with progress notifications) and
 * returns the job's result, or an error naming the failed step and its
 * recovery tool; without it the call returns the jobId at once so the caller
 * can cc_job_wait / cc_job_status.
 */
export async function runOrQueue(jobs: JobRegistry, kind: string, steps: JobStepDef[], finalize: ((results: unknown[], job: Job) => unknown) | undefined, options: RunOrQueueOptions): Promise<CallToolResult> {
  const { job } = jobs.start(kind, steps, finalize);
  if (!options.wait) {
    return jsonResult({ ...jobView(job), hint: `Running in the background. Call cc_job_wait with jobId ${job.id} (or cc_job_status).` });
  }
  const progress = progressReporter(options.extra);
  const finished = await jobs.wait(job.id, options.timeoutMs, (j) => progress(`${j.progress.step ?? j.kind}: ${j.progress.message}`, j.progress.percent));
  return jobResult(finished, options.timeoutMs);
}

export function jobResult(job: Job, timeoutMs?: number): CallToolResult {
  if (job.status === "succeeded") return jsonResult(jobView(job));
  if (job.status === "failed" || job.status === "cancelled") return errorResult(JSON.stringify(jobView(job, { includeLog: true }), null, 2));
  return jsonResult({ ...jobView(job), hint: `Still ${job.status} after ${Math.round((timeoutMs ?? 0) / 1000)}s. Call cc_job_wait with jobId ${job.id} to keep waiting, or cc_job_cancel.` });
}

export interface JobToolOptions {
  /** Default cc_job_wait timeout, seconds. Keep below the client's own tool timeout. */
  defaultWaitSeconds?: number;
}

export function registerJobTools(server: McpServer, jobs: JobRegistry, options: JobToolOptions = {}): void {
  const defaultWaitSeconds = options.defaultWaitSeconds ?? 300;
  server.registerTool(
    "cc_job_status",
    {
      title: "Jobs: status of a job",
      description: "Read a background job (render, export, pipeline): status, per-step results, progress, artifacts, error with the recovery tool, and the log tail.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) =>
      guard(async () => {
        const job = jobs.get(jobId);
        if (!job) return errorResult(`No job ${jobId}. Call cc_list_jobs.`);
        return jsonResult(jobView(job, { includeLog: true }));
      }),
  );

  server.registerTool(
    "cc_list_jobs",
    {
      title: "Jobs: list jobs",
      description: "List recent background jobs, newest first, with status and progress.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Defaults to 20.") },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => guard(async () => jsonResult(jobs.list(limit ?? 20).map((j) => ({ jobId: j.id, kind: j.kind, status: j.status, progress: j.progress, createdAt: new Date(j.createdAt).toISOString() })))),
  );

  server.registerTool(
    "cc_job_wait",
    {
      title: "Jobs: wait for a job",
      description: "Block until a job finishes or the timeout passes (progress is streamed meanwhile), then return its result or its failure report.",
      inputSchema: { jobId: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(1800).optional().describe(`Defaults to ${defaultWaitSeconds} (BRAINFERNO_MCP_JOB_WAIT_SECONDS).`) },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId, timeoutSeconds }, extra) =>
      guard(async () => {
        const timeoutMs = (timeoutSeconds ?? defaultWaitSeconds) * 1000;
        const progress = progressReporter(extra as ProgressExtra);
        const job = await jobs.wait(jobId, timeoutMs, (j) => progress(`${j.progress.step ?? j.kind}: ${j.progress.message}`, j.progress.percent));
        return jobResult(job, timeoutMs);
      }),
  );

  server.registerTool(
    "cc_job_cancel",
    {
      title: "Jobs: cancel a job",
      description: "Cancel a running job. Process steps (aerender, ffmpeg) are killed; in-app steps finish their current command first.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guard(async () => {
        const job = jobs.get(jobId);
        if (!job) return errorResult(`No job ${jobId}. Call cc_list_jobs.`);
        if (isTerminal(job.status)) return jsonResult({ jobId, status: job.status, note: "already finished" });
        jobs.cancel(jobId);
        const after = await jobs.wait(jobId, 10_000);
        return jsonResult(jobView(after));
      }),
  );
}
