// ============================================================
// Background Job Store — session-keyed job table (M38)
// ============================================================
// Unified in-memory registry for background work (currently background Bash).
// Keyed by the owning conversation, independently of checkpoint session IDs.
// The owner can manage every delegated job; workers can see only their own
// delegation path and descendants, never parent or sibling work.
// Live handles are in-memory only. Session snapshots retain diagnostics and
// terminal status; restoring a running snapshot marks interruption, never
// reconnects to a PID or restarts a command.
// ============================================================

import { loopExecution } from "../loop-execution-context.js";
import type { ToolContext } from "../types.js";
import { pushTaskNotification } from "./notifications.js";

export type JobStatus = "running" | "done" | "killed" | "error";

/** How much of a finished job's output rides along in its notification. */
const NOTIFICATION_OUTPUT_TAIL = 500;

export interface Job {
  id: string;
  /** Owning session — jobs are session-scoped and notifications route by it. */
  sessionId: string;
  /** Creator's delegation path; the owning conversation can see all paths. */
  scope?: readonly string[];
  kind: "bash" | "agent";
  loopId?: string;
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
export function restoreJobs(sessionId: string, values: unknown[]): void {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<Job>;
    if (
      typeof entry.id !== "string" ||
      typeof entry.command !== "string" ||
      !["bash", "agent"].includes(String(entry.kind))
    )
      continue;
    // Review fix ("同进程 /resume 覆盖仍存活的后台 job"): the snapshot was
    // taken when the session was switched away, but in THIS process the job
    // may still be live (holding its process tree and kill handle). The
    // restored "interrupted" copy must not clobber it — keep the live entry.
    const existing = bucket(sessionId).get(entry.id);
    if (existing && existing.status === "running") continue;
    const job: Job = {
      id: entry.id,
      sessionId,
      command: entry.command,
      kind: entry.kind!,
      scope:
        Array.isArray(entry.scope) && entry.scope.every((part) => typeof part === "string")
          ? entry.scope
          : undefined,
      description: entry.description,
      status:
        entry.status === "running"
          ? "error"
          : ["done", "killed", "error"].includes(String(entry.status))
            ? entry.status!
            : "error",
      stdout: String(entry.stdout ?? "").slice(-1000000),
      stderr:
        entry.status === "running"
          ? [
              String(entry.stderr ?? ""),
              "The previous CLI no longer owns this job. It was marked interrupted and was not restarted. The saved record does not confirm the command's exit.",
            ]
              .filter(Boolean)
              .join("\n")
              .slice(-1000000)
          : String(entry.stderr ?? "").slice(-1000000),
      exitCode: entry.status === "running" ? null : (entry.exitCode ?? null),
      startedAt: entry.startedAt ?? Date.now(),
      endedAt: entry.endedAt ?? Date.now(),
      truncated: entry.truncated === true,
      settled: Promise.resolve(),
      resolveSettled: () => {},
    };
    bucket(sessionId).set(job.id, job);
    counters.set(
      sessionId,
      Math.max(counters.get(sessionId) ?? 0, Number(job.id.replace("job-", "")) || 0),
    );
  }
}

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
    loopId: loopExecution()?.id,
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

type JobContext = Pick<ToolContext, "sessionId" | "jobOwnerSessionId" | "jobScope">;
function visibleTo(job: Job, context: JobContext): boolean {
  return (
    !context.jobScope?.length ||
    context.jobScope.every((part, index) => job.scope?.[index] === part)
  );
}
/** Producers use conversation ownership while retaining worker visibility. */
export function createContextJob(context: JobContext, entry: NewJob): Job {
  const job = createJob(context.jobOwnerSessionId ?? context.sessionId, entry);
  job.scope = context.jobScope ? [...context.jobScope] : undefined;
  return job;
}
export function contextJob(context: JobContext, id: string): Job | undefined {
  const job = getJob(context.jobOwnerSessionId ?? context.sessionId, id);
  return job && visibleTo(job, context) ? job : undefined;
}
export function contextJobs(context: JobContext): Job[] {
  return listJobs(context.jobOwnerSessionId ?? context.sessionId).filter((job) =>
    visibleTo(job, context),
  );
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
    loopId: job.loopId,
  });
}

/** Wait for actual producer settlement, with a bounded/cancellable read wait.
 * Cancelling this wait does not cancel the background work itself. */
export function waitForJob(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (job.status !== "running") return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const finish = (settled: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(settled);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    job.settled.then(() => finish(true));
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

/**
 * Kill every RUNNING job of a session (review fix "正常退出不清理后台 Bash"):
 * the user asked to leave — a live process tree and its 2h TTL timer must not
 * keep the CLI alive or outlive the session UI. Used by exit cleanup paths.
 */
export async function killRunningJobs(
  sessionId: string,
  reason = "session exited",
  timeoutMs = 5000,
): Promise<string[]> {
  const running = listJobs(sessionId).filter((job) => job.status === "running");
  for (const job of running) {
    job.killReason ||= reason;
    try {
      job.kill?.();
    } catch {
      /* already gone */
    }
  }
  // Only the producer knows when its process/agent cleanup has really ended.
  // A failed kill stays running and is reported to the caller, never fabricated
  // into a terminal notification or a "killed" persistence record.
  await Promise.all(running.map((job) => waitForJob(job, timeoutMs)));
  return running.filter((job) => job.status === "running").map((job) => job.id);
}

/** CLI teardown includes previously visited conversations, not unrelated roots. */
export async function killOwnedSessionJobs(
  sessionIds: Iterable<string>,
  reason = "session exited",
  timeoutMs = 5000,
): Promise<string[]> {
  const pending = await Promise.all(
    [...new Set(sessionIds)].map(async (sessionId) =>
      (await killRunningJobs(sessionId, reason, timeoutMs)).map((id) => `${sessionId}/${id}`),
    ),
  );
  return pending.flat();
}
