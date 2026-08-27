import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JobRegistry, jobView } from "../src/jobs.js";

const registry = () => new JobRegistry({ workRoot: join(tmpdir(), `acm-jobs-${process.pid}`) });

describe("job registry", () => {
  it("runs steps in order, keeps each result, and finalizes", async () => {
    const jobs = registry();
    const seen: string[] = [];
    const { job, done } = jobs.start(
      "t",
      [
        { name: "one", run: async (ctx) => (seen.push("one"), ctx.log("hello"), 1) },
        { name: "two", run: async (_ctx, prev) => (seen.push("two"), (prev[0] as number) + 1) },
        { name: "maybe", when: () => false, run: async () => "never" },
      ],
      (results) => ({ sum: results[1] }),
    );
    expect(job.status).toBe("running");
    const finished = await done;
    expect(seen).toEqual(["one", "two"]);
    expect(finished.status).toBe("succeeded");
    expect(finished.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded", "skipped"]);
    expect(finished.result).toEqual({ sum: 2 });
    expect(finished.progress.percent).toBe(100);
    expect(finished.log).toContain("hello");
    expect(jobView(finished).jobId).toBe(job.id);
  });

  it("records the failed step with its recovery tool and skips the rest", async () => {
    const jobs = registry();
    const { done } = jobs.start("t", [
      { name: "ok", run: async () => 1 },
      { name: "boom", recoveryTool: "fix_it", run: async () => Promise.reject(new Error("nope")) },
      { name: "after", run: async () => 3 },
    ]);
    const j = await done;
    expect(j.status).toBe("failed");
    expect(j.error).toEqual({ step: "boom", message: "nope", recoveryTool: "fix_it", completedSteps: ["ok"] });
    expect(j.steps.map((s) => s.status)).toEqual(["succeeded", "failed", "skipped"]);
  });

  it("cancels between steps and aborts a running step through the signal", async () => {
    const jobs = registry();
    const { job, done } = jobs.start("t", [
      { name: "slow", run: (ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")))) },
      { name: "never", run: async () => 2 },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(jobs.cancel(job.id)).toBe(true);
    const j = await done;
    expect(j.status).toBe("cancelled");
    expect(j.steps[1]?.status).toBe("skipped");
    expect(jobs.cancel(job.id)).toBe(false);
  });

  it("wait returns early on completion and reports ticks while running", async () => {
    const jobs = registry();
    const { job } = jobs.start("t", [{ name: "quick", run: async () => new Promise((r) => setTimeout(() => r("v"), 30)) }]);
    const j = await jobs.wait(job.id, 5000);
    expect(j.status).toBe("succeeded");
    expect(jobs.list()[0]?.id).toBe(job.id);
    await expect(jobs.wait("missing", 10)).rejects.toThrow(/No job/);
  });
});
