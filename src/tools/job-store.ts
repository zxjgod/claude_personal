// ============================================================
// Background Job Store — session-keyed job table (M38)
// ============================================================
// Unified in-memory registry for background work (currently background Bash).
// Keyed by sessionId — the same bucket pattern as change-tracker.ts — so
// concurrent sessions and sub-agents never see each other's jobs. Tools read
// and write it through the `context.sessionId` threaded into every tool call.
// Deliberately in-memory only: a background job is a live process tree, so
// there is nothing meaningful to persist across a process restart.
// ============================================================

import { pushTaskNotification } from "./notifications.js";

export type JobStatus = "running" | "done" | "killed" | "error";

/** How much of a finished job's output rides along in its notification. */
const NOTIFICATION_OUTPUT_TAIL = 500;

export interface Job {
  id: string;
  /** Owning session — jobs are session-scoped and notifications route by it. */
  sessionId: string;
  kind: "bash" | "agent";
  command: string;
  description?: string;
  status: JobStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  /**
   * Reason supplied to job_kill (M38). Recorded on the job so readers can see
   * WHY a job was stopped, not just that it was.
   */
  killReason?: string;
  /** True when accumulated stdout/stderr exceeded the 10MB cap and was cut off. */
  truncated: boolean;
  /**
   * Kill the underlying process tree (set only while the job is killable).
   * Wired by the producer (Bash) after spawn, since it needs the child pid.
   */
  kill?: () => void;
  /**
   * Resolves when the job settles (exits or is killed). Lets `job_output`
   * with `wait: true` block without polling.
   */
  settled: Promise<void>;
  resolveSettled: () => void;
}

const jobs = new Map<string, Map<string, Job>>();
const counters = new Map<string, number>();

// Bound per-session retention: a long-lived process (or many sub-agent
// sessions) must not accumulate completed job stdout/stderr forever.
const MAX_JOBS_PER_SESSION = 50;

function bucket(sessionId: string): Map<string, Job> {
  let m = jobs.get(sessionId);
  if (!m) {
    m = new Map();
    jobs.set(sessionId, m);
  }
  return m;
}

/** Monotonic, human-readable job id scoped to a session (`job-1`, `job-2`, …). */
export function nextJobId(sessionId: string): string {
  const n = (counters.get(sessionId) ?? 0) + 1;
  counters.set(sessionId, n);
  return `job-${n}`;
}

export interface NewJob {
  kind: "bash" | "agent";
  command: string;
  description?: string;
}

/** Register a new running job and return it. */
export function createJob(sessionId: string, entry: NewJob): Job {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const job: Job = {
    id: nextJobId(sessionId),
    sessionId,
    kind: entry.kind,
    command: entry.command,
    description: entry.description,
    status: "running",
    stdout: "",
    stderr: "",
    exitCode: null,
    startedAt: Date.now(),
    truncated: false,
    settled,
    resolveSettled,
  };
  const b = bucket(sessionId);
  // Drop the oldest SETTLED jobs when at the cap so memory stays bounded.
  // Running jobs are never dropped — they still hold live process trees.
  if (b.size >= MAX_JOBS_PER_SESSION) {
    for (const [id, existing] of b) {
      if (existing.status !== "running") {
        b.delete(id);
        if (b.size < MAX_JOBS_PER_SESSION) break;
      }
    }
  }
  b.set(job.id, job);
  return job;
}

export function getJob(sessionId: string, id: string): Job | undefined {
  return bucket(sessionId).get(id);
}

/** All jobs for a session, in creation order. */
export function listJobs(sessionId: string): Job[] {
  return Array.from(bucket(sessionId).values());
}

/** Mark a job terminal (exited or killed) and wake any `wait`-ing readers. */
export function settleJob(job: Job, status: JobStatus, exitCode: number | null): void {
  // Idempotent: `child.on('error')` and `child.on('close')` can both fire for
  // a spawn failure; the first one wins and the second is a no-op.
  if (job.status !== "running") return;
  job.status = status;
  job.exitCode = exitCode;
  job.endedAt = Date.now();
  job.resolveSettled();
  // M41: notify the owning session's loop that the background work settled —
  // the model learns the completion without polling job_output.
  const tail = [job.stdout, job.stderr]
    .filter(Boolean)
    .join("\n")
    .slice(-NOTIFICATION_OUTPUT_TAIL)
    .trim();
  pushTaskNotification(job.sessionId, {
    id: job.id,
    kind: job.kind,
    status,
    summary: job.description || job.command.slice(0, 80),
    outputTail: tail || undefined,
  });
}

/**
 * Drop a session's SETTLED jobs (called on /clear). Running jobs are kept —
 * they still hold live process trees and must remain reachable so job_kill can
 * stop them; dropping them would leak the process and orphan its output. The
 * per-session id counter is left in place so a fresh job id never collides with
 * a job that is still running after the clear.
 */
export function clearJobs(sessionId: string): void {
  const b = jobs.get(sessionId);
  if (!b) return;
  for (const [id, job] of b) {
    if (job.status !== "running") b.delete(id);
  }
  if (b.size === 0) jobs.delete(sessionId);
}
