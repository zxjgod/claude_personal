// ============================================================
// Background Job Tools — job_list / job_output / job_kill (M38)
// ============================================================
// The kind-agnostic controller for background work (currently background Bash,
// extensible to background sub-agents / terminals). All three tools read and
// write the session-keyed store in ../job-store.js via context.sessionId, so
// they only ever see the jobs THIS session started.
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { getJob, listJobs } from "../job-store.js";
import { buildTool } from "../registry.js";

const DEFAULT_WAIT_MS = 30_000;
/** Hard cap on `wait` — a caller-supplied timeout_ms must not block the loop forever. */
const MAX_WAIT_MS = 5 * 60_000;

// --- job_list -------------------------------------------------------------

const JobListSchema = z.strictObject({});

export const JobListTool: Tool = buildTool({
  name: "job_list",
  description: "List background jobs for the current session",
  promptDescription:
    "List your background jobs (running and finished) with their ids, kinds, and statuses.",
  schema: JobListSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(_input, context): Promise<ToolResult> {
    const jobs = listJobs(context.sessionId);
    if (jobs.length === 0) {
      return { content: "No background jobs." };
    }
    const lines = jobs.map((job) => {
      const label = job.description || job.command;
      return `${job.id}  ${job.kind}  ${job.status}  ${label.slice(0, 60)}`;
    });
    return { content: lines.join("\n") };
  },

  async checkPermissions() {
    return { allowed: true }; // Read-only
  },
});

// --- job_output -----------------------------------------------------------

const JobOutputSchema = z.strictObject({
  job_id: z.string().describe("Job id returned by the tool that started the background work"),
  wait: z
    .boolean()
    .optional()
    .describe("Block until the job reaches a terminal status or the timeout expires"),
  timeout_ms: z
    .number()
    .optional()
    .describe(`Max wait in ms (only meaningful with wait; default ${DEFAULT_WAIT_MS})`),
});

export const JobOutputTool: Tool = buildTool({
  name: "job_output",
  description: "Read the accumulated output of a background job",
  promptDescription:
    "Read a background job's output. Every response ends with `[status: ...]`. " +
    "Reads are non-blocking unless `block: true`, which waits up to `timeout` ms. " +
    "The official names are task_id/block/timeout; job_id/wait/timeout_ms are also accepted.",
  schema: JobOutputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const job = getJob(context.sessionId, input.job_id);
    if (!job) {
      return { content: "", error: `Unknown job: ${input.job_id}` };
    }

    if (input.wait && job.status === "running") {
      const timeoutMs =
        input.timeout_ms && input.timeout_ms > 0
          ? Math.min(input.timeout_ms, MAX_WAIT_MS)
          : DEFAULT_WAIT_MS;
      // Race the job's settlement against a timeout, clearing the timer on the
      // path that loses so a job that finishes early doesn't leave a dangling
      // timer keeping the event loop alive until `timeoutMs` elapses.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        job.settled.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const output = [job.stdout, job.stderr].filter(Boolean).join("\n");
    const flags: string[] = [];
    if (job.status === "killed" && job.killReason) flags.push(`killed: ${job.killReason}`);
    if (job.truncated) flags.push("output truncated (over 10MB limit)");
    const flagNote = flags.length > 0 ? `\n${flags.map((f) => `[${f}]`).join(" ")}` : "";
    return {
      content: `${output || "(no output yet)"}\n[status: ${job.status}]${flagNote}`,
    };
  },

  async checkPermissions() {
    return { allowed: true }; // Read-only
  },
});

// --- job_kill -------------------------------------------------------------

const JobKillSchema = z.strictObject({
  job_id: z.string().describe("Job id to stop"),
  reason: z.string().optional().describe("Optional short reason, recorded in the job"),
});

export const JobKillTool: Tool = buildTool({
  name: "job_kill",
  description: "Stop a running background job",
  promptDescription:
    "Stop a background job by its job id. Returns immediately; the job settles as " +
    "killed once its process tree actually stops. Killing an already-finished job is a no-op.",
  schema: JobKillSchema,
  // Mutating (kills a process), so NOT read-only — like task_stop, it routes
  // through the normal permission flow rather than auto-approving.
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    const job = getJob(context.sessionId, input.job_id);
    if (!job) {
      return { content: "", error: `Unknown job: ${input.job_id}` };
    }

    if (job.status === "running") {
      job.killReason = input.reason;
      job.kill?.();
      // Review fix ("kill 在进程真正退出前就 settle"): wait (bounded) for the
      // process tree to actually stop so waiters and notifications see the
      // FINAL status/output. settleJob fires from the close handler; if the
      // kill fails outright, report an error instead of "killed".
      await Promise.race([job.settled, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (job.status === "running") {
        return {
          content: "",
          error: `Job ${job.id} did not stop within 5s after job_kill — the process may be unkillable; investigate manually.`,
        };
      }
      const reason = input.reason ? ` (${input.reason})` : "";
      return { content: `Job ${job.id} killed${reason} (status: ${job.status}).` };
    }

    return { content: `Job ${job.id} is already ${job.status}.` };
  },

  async checkPermissions() {
    return { allowed: true }; // Only ever touches this session's own jobs
  },
});
