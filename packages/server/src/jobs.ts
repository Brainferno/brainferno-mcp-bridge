import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * In-memory job registry for anything that runs longer than a tool call
 * should block: aerender, Premiere exports, and the cross-app pipelines.
 *
 * A job is a named list of steps run in order. Each step's result is kept,
 * failures record which step broke and which tool recovers it, and a job can
 * be cancelled between steps (process-lane steps also get an AbortSignal so
 * a running ffmpeg/aerender is killed). Every job gets a private work folder
 * under `<workRoot>/<jobId>/` for cross-app hand-offs.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface JobContext {
  readonly jobId: string;
  readonly workDir: string;
  readonly signal: AbortSignal;
  /** Append a line to the job log (tail kept) and make it the progress message. */
  log(message: string): void;
  /** Report progress inside the current step (0–100). */
  progress(message: string, percent?: number): void;
  /** Record a file the job produced. */
  artifact(path: string): void;
}

export interface JobStepDef {
  name: string;
  /** Tool to call by hand when this step fails. */
  recoveryTool?: string;
  /** Return false to skip this step (recorded as skipped). */
  when?: (previous: unknown[]) => boolean;
  run: (ctx: JobContext, previous: unknown[]) => Promise<unknown>;
}

export interface JobStep {
  name: string;
  status: StepStatus;
  recoveryTool?: string;
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

export interface JobFailure {
  step: string;
  message: string;
  recoveryTool?: string;
  completedSteps: string[];
}

export interface JobProgress {
  step: string | null;
  stepIndex: number;
  stepCount: number;
  percent: number;
  message: string;
}

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  workDir: string;
  steps: JobStep[];
  progress: JobProgress;
  artifacts: string[];
  log: string[];
  result?: unknown;
  error?: JobFailure;
}

export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled.`);
    this.name = "JobCancelledError";
  }
}

interface JobRecord {
  job: Job;
  controller: AbortController;
  done: Promise<Job>;
}

const LOG_TAIL = 200;

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly options: { workRoot: string; keep?: number }) {}

  /** Start a job now. Resolves `done` when it reaches a terminal state (never rejects). */
  start(kind: string, steps: JobStepDef[], finalize?: (results: unknown[], job: Job) => unknown): { job: Job; done: Promise<Job> } {
    const id = randomUUID();
    const job: Job = {
      id,
      kind,
      status: "queued",
      createdAt: Date.now(),
      workDir: join(this.options.workRoot, id),
      steps: steps.map((s) => ({ name: s.name, status: "pending", ...(s.recoveryTool !== undefined ? { recoveryTool: s.recoveryTool } : {}) })),
      progress: { step: null, stepIndex: 0, stepCount: steps.length, percent: 0, message: "queued" },
      artifacts: [],
      log: [],
    };
    const controller = new AbortController();
    const done = this.execute(job, controller, steps, finalize);
    this.jobs.set(id, { job, controller, done });
    this.prune();
    return { job, done };
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  list(limit = 50): Job[] {
    return [...this.jobs.values()]
      .map((r) => r.job)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** Request cancellation. Returns false if the job is unknown or already finished. */
  cancel(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec || isTerminal(rec.job.status)) return false;
    rec.controller.abort(new JobCancelledError(id));
    return true;
  }

  /** Wait for a terminal state or the timeout; `onTick` fires every ~2 s with the live job. */
  async wait(id: string, timeoutMs: number, onTick?: (job: Job) => void): Promise<Job> {
    const rec = this.jobs.get(id);
    if (!rec) throw new Error(`No job ${id}. Call cc_list_jobs.`);
    const deadline = Date.now() + timeoutMs;
    let lastTick = 0;
    while (!isTerminal(rec.job.status) && Date.now() < deadline) {
      if (onTick && Date.now() - lastTick >= 2000) {
        lastTick = Date.now();
        onTick(rec.job);
      }
      await Promise.race([rec.done, sleep(500)]);
    }
    return rec.job;
  }

  private prune(): void {
    const keep = this.options.keep ?? 100;
    if (this.jobs.size <= keep) return;
    const finished = [...this.jobs.entries()].filter(([, r]) => isTerminal(r.job.status)).sort((a, b) => a[1].job.createdAt - b[1].job.createdAt);
    for (const [id] of finished.slice(0, this.jobs.size - keep)) this.jobs.delete(id);
  }

  private async execute(job: Job, controller: AbortController, steps: JobStepDef[], finalize?: (results: unknown[], job: Job) => unknown): Promise<Job> {
    const results: unknown[] = [];
    const completed: string[] = [];
    const setProgress = (i: number, message: string, within = 0) => {
      job.progress = {
        step: steps[i]?.name ?? null,
        stepIndex: i,
        stepCount: steps.length,
        percent: steps.length === 0 ? 100 : Math.min(100, Math.round(((i + within / 100) / steps.length) * 100)),
        message,
      };
    };
    const ctx = (i: number): JobContext => ({
      jobId: job.id,
      workDir: job.workDir,
      signal: controller.signal,
      log: (m) => {
        job.log.push(m);
        if (job.log.length > LOG_TAIL) job.log.splice(0, job.log.length - LOG_TAIL);
        setProgress(i, m, within(job));
      },
      progress: (m, p) => setProgress(i, m, p ?? within(job)),
      artifact: (p) => {
        if (!job.artifacts.includes(p)) job.artifacts.push(p);
      },
    });
    const within = (j: Job) => (j.progress.stepIndex === job.progress.stepIndex ? Math.round(((j.progress.percent / 100) * steps.length - j.progress.stepIndex) * 100) : 0);

    job.status = "running";
    job.startedAt = Date.now();
    try {
      await mkdir(job.workDir, { recursive: true });
    } catch {
      /* the work dir is a convenience; steps that need it will fail loudly */
    }
    for (let i = 0; i < steps.length; i++) {
      const def = steps[i]!;
      const step = job.steps[i]!;
      if (controller.signal.aborted) {
        job.status = "cancelled";
        break;
      }
      if (def.when && !def.when(results)) {
        step.status = "skipped";
        results.push(undefined);
        continue;
      }
      step.status = "running";
      step.startedAt = Date.now();
      setProgress(i, `${def.name}…`);
      try {
        const value = await def.run(ctx(i), results);
        step.result = value;
        step.status = "succeeded";
        step.finishedAt = Date.now();
        results.push(value);
        completed.push(def.name);
      } catch (e) {
        step.finishedAt = Date.now();
        if (controller.signal.aborted || e instanceof JobCancelledError) {
          step.status = "skipped";
          job.status = "cancelled";
          break;
        }
        const message = e instanceof Error ? e.message : String(e);
        step.status = "failed";
        step.error = message;
        job.status = "failed";
        job.error = { step: def.name, message, completedSteps: completed, ...(def.recoveryTool !== undefined ? { recoveryTool: def.recoveryTool } : {}) };
        break;
      }
    }
    if (job.status === "running") {
      job.status = "succeeded";
      try {
        job.result = finalize ? finalize(results, job) : results;
      } catch (e) {
        job.status = "failed";
        job.error = { step: "finalize", message: e instanceof Error ? e.message : String(e), completedSteps: completed };
      }
    }
    for (const s of job.steps) if (s.status === "pending") s.status = "skipped";
    job.finishedAt = Date.now();
    job.progress = { ...job.progress, percent: job.status === "succeeded" ? 100 : job.progress.percent, message: job.status === "succeeded" ? "done" : job.status === "failed" ? `failed at ${job.error?.step ?? "?"}` : job.status };
    return job;
  }
}

export function isTerminal(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** JSON-safe view of a job for tool results (no internal handles, bounded log). */
export function jobView(job: Job, options: { includeLog?: boolean } = {}) {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt !== undefined ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt !== undefined ? new Date(job.finishedAt).toISOString() : null,
    elapsedSeconds: job.startedAt !== undefined ? Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000) : 0,
    progress: job.progress,
    steps: job.steps.map((s) => ({ name: s.name, status: s.status, ...(s.error !== undefined ? { error: s.error } : {}), ...(s.recoveryTool !== undefined && s.status === "failed" ? { recoveryTool: s.recoveryTool } : {}) })),
    artifacts: job.artifacts,
    workDir: job.workDir,
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(options.includeLog ? { log: job.log.slice(-40) } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
