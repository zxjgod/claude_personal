// ============================================================
// Shared Cron Scheduling Logic
// ============================================================
// Extracted from breadth/orchestration.ts to allow reuse by both ScheduleCron and CronCreate/Delete/List.
//
// M41: this module is now the complete scheduling ENGINE, not just a registry:
//   - cronMatches(): 5-field cron matching (star / list / range / step, with
//     the standard DOM/DOW "both restricted → OR" semantics)
//   - collectDueCronJobs(): the firing pass — minute-level dedup, one-shot
//     removal, relative "+N seconds" delays (used by Sleep)
//   - durable persistence: jobs marked durable round-trip through
//     <root>/.claude/scheduled_tasks.json so they survive restarts
// The CLI/TUI own the timer loop and the idle-delivery policy (jobs fire
// only while the REPL is idle); see tools/extended/scheduler.ts.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { renameSyncWithRetry } from "../../utils/atomic-rename.js";
import { withFileLock } from "../../utils/file-lock.js";
import {
  cancelScheduledInputs,
  enqueueScheduledInput,
  matchesScheduleScope,
  type ScheduleScope,
  scheduleWorkspaceKey,
} from "./schedule-scope.js";

export interface ScheduledJob extends ScheduleScope {
  id: string;
  /**
   * Either a 5-field cron expression (local time) or a relative delay
   * "+<seconds>" (one-shot, used by the Sleep tool).
   */
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: bigint;
  /** Wall-clock ms at creation — anchors "+N" delays across restarts. */
  createdAtMs: number;
  /** Last minute (epoch minutes) this job fired; dedups within the minute. */
  lastFiredMinute?: number;
  /**
   * Review fix ("durable 一次性任务交付前即被删除"): a durable one-shot that
   * came due is marked here instead of being deleted; the record (and its
   * prompt) survives on disk until the queued input is actually DELIVERED,
   * so a crash between "collected" and "delivered" replays instead of losing
   * the execution. Cleared by completeDeliveredCronJob at delivery.
   */
  pendingDelivery?: boolean;
}

/** Cap on live scheduled jobs — a runaway creator must not grow this forever. */
export const MAX_SCHEDULED_JOBS = 50;

const JOBS = new Map<string, ScheduledJob>();
export function releaseSessionCronJobs(sessionId: string): void {
  for (const [key, job] of JOBS)
    if (!job.durable && job.sessionId === sessionId) {
      JOBS.delete(key);
      cancelScheduledInputs("cron", job.id, { sessionId });
    }
}
const loadedWorkspaces = new Map<string, string>();
export function restoreSessionJobs(root: string, sessionId: string, values: unknown[]): void {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<ScheduledJob>;
    if (
      typeof entry.id !== "string" ||
      JOBS.has(entry.id) ||
      typeof entry.cron !== "string" ||
      validateCron(entry.cron) ||
      typeof entry.prompt !== "string" ||
      typeof entry.createdAtMs !== "number" ||
      Date.now() - entry.createdAtMs > 7 * 86400000
    )
      continue;
    JOBS.set(entry.id, {
      id: entry.id,
      cron: entry.cron,
      prompt: entry.prompt,
      createdAtMs: entry.createdAtMs,
      createdAt: process.hrtime.bigint(),
      workspaceRoot:
        typeof entry.workspaceRoot === "string"
          ? path.resolve(entry.workspaceRoot)
          : path.resolve(root),
      sessionId,
      recurring: entry.recurring === true,
      durable: false,
      lastFiredMinute:
        typeof entry.lastFiredMinute === "number" ? entry.lastFiredMinute : undefined,
    });
  }
}
let jobCounter = 0;

function deleteJobEntry(job: ScheduledJob): void {
  for (const [key, entry] of JOBS) {
    if (entry === job) {
      JOBS.delete(key);
      break;
    }
  }
}

/** Generate next job ID */
function nextJobId(): string {
  jobCounter += 1;
  return `job-${process.hrtime.bigint().toString(36)}-${jobCounter}`;
}

/**
 * Validate a schedule expression: a 5-field cron expression (min hour dom mon
 * dow; each field a number, star, star-slash-n, range a-b, or list a,b) or a
 * relative delay "+<seconds>". Returns null if valid, an error string if not.
 */
export function validateCron(cron: string): string | null {
  const trimmed = cron.trim();
  if (trimmed.startsWith("+")) {
    const secs = Number(trimmed.slice(1));
    if (!Number.isInteger(secs) || secs <= 0) {
      return `"${trimmed}" is not a positive integer second count`;
    }
    return null;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return `Cron must have exactly 5 fields (min hour dom mon dow), got ${fields.length}`;
  }
  const ranges: Array<[number, number]> = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week (0 and 7 both = Sunday)
  ];
  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i]!, ranges[i]![0], ranges[i]![1]);
    if (err) return `Field ${i + 1} (${fields[i]}): ${err}`;
  }
  return null;
}

function validateCronField(field: string, min: number, max: number): string | null {
  for (const part of field.split(",")) {
    const stepped = part.split("/");
    if (stepped.length > 2) return "too many / separators";
    const base = stepped[0]!;
    if (base !== "*") {
      const rangeMatch = base.match(/^(\d+)(?:-(\d+))?$/);
      if (!rangeMatch) return `"${base}" is not a number, range, or *`;
      const lo = parseInt(rangeMatch[1]!, 10);
      const hi = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : lo;
      if (Number.isNaN(lo) || Number.isNaN(hi)) return "non-numeric value";
      if (lo < min || lo > max || hi < min || hi > max) {
        return `value out of range ${min}-${max}`;
      }
      if (hi < lo) return "range end before start";
    }
    if (stepped[1] !== undefined) {
      const step = parseInt(stepped[1], 10);
      if (Number.isNaN(step) || step < 1) return "step must be a positive integer";
    }
  }
  return null;
}

// --- cron matching -----------------------------------------------------------

/** Parse one field into the set of matching values, or null when malformed. */
function expandField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepped = part.split("/");
    const base = stepped[0]!;
    const step = stepped[1] !== undefined ? parseInt(stepped[1], 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (base !== "*") {
      const m = base.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      lo = parseInt(m[1]!, 10);
      hi = m[2] !== undefined ? parseInt(m[2], 10) : lo;
      if (lo < min || hi > max || hi < lo) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Does `date` (local time) match a 5-field cron expression? Standard cron
 * semantics: DOM and DOW are AND-ed unless BOTH are restricted (non-`*`),
 * in which case a match on EITHER fires the job.
 */
export function cronMatches(date: Date, cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  const minutes = expandField(minF, 0, 59);
  const hours = expandField(hourF, 0, 23);
  const doms = expandField(domF, 1, 31);
  const months = expandField(monF, 1, 12);
  // 0 and 7 both mean Sunday — normalize into 0-6.
  const dows = expandField(dowF, 0, 7);
  if (!minutes || !hours || !doms || !months || !dows) return false;
  if (dows.has(7)) dows.add(0);

  if (!minutes.has(date.getMinutes())) return false;
  if (!hours.has(date.getHours())) return false;
  if (!months.has(date.getMonth() + 1)) return false;

  const domMatch = doms.has(date.getDate());
  const domRestricted = domF !== "*";
  const dowMatch = dows.has(date.getDay());
  const dowRestricted = dowF !== "*";
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

// --- registry ----------------------------------------------------------------

/** Register a new scheduled job. Returns null when the job cap is reached. */
export function registerScheduledJob(input: {
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  workspaceRoot?: string;
  sessionId?: string;
}): ScheduledJob | null {
  if (input.workspaceRoot) ensureDurableJobsLoaded(input.workspaceRoot);
  if (JOBS.size >= MAX_SCHEDULED_JOBS) return null;
  const job: ScheduledJob = {
    id: nextJobId(),
    cron: input.cron.trim(),
    prompt: input.prompt,
    recurring: input.recurring,
    durable: input.durable,
    workspaceRoot: input.workspaceRoot ? path.resolve(input.workspaceRoot) : undefined,
    sessionId: input.durable ? undefined : input.sessionId,
    createdAt: process.hrtime.bigint(),
    createdAtMs: Date.now(),
  };
  JOBS.set(job.id, job);
  // Locked persist with a disk merge first: two processes registering durable
  // jobs used to full-rewrite from their own in-memory registry and the later
  // writer silently dropped the other's job (review fix "跨进程全量重写抹任务").
  if (job.durable && job.workspaceRoot) persistDurableJobs(job.workspaceRoot);
  return job;
}

/** List all scheduled jobs */
export function listScheduledJobs(scope?: ScheduleScope): ScheduledJob[] {
  return [...JOBS.values()].filter((job) => matchesScheduleScope(job, scope));
}

/** Get a job by id */
export function getScheduledJob(id: string, scope?: ScheduleScope): ScheduledJob | undefined {
  return [...JOBS.values()].find((job) => job.id === id && matchesScheduleScope(job, scope));
}

/** Remove a job. Returns true if it existed. */
export function removeScheduledJob(id: string, scope?: ScheduleScope): boolean {
  const job = getScheduledJob(id, scope);
  const cancelled = cancelScheduledInputs("cron", id, scope) > 0;
  if (!job) return cancelled;
  deleteJobEntry(job);
  if (job.durable && job.workspaceRoot) persistDurableJobs(job.workspaceRoot);
  return true;
}

/**
 * The firing pass (M41): mark and return every job due at `now`. Cron jobs
 * fire at most once per matched minute (minute-level dedup); relative "+N"
 * jobs fire once when the delay elapsed; one-shots are removed after firing
 * EXCEPT durable one-shots, which flip to pendingDelivery and only leave the
 * registry at actual delivery (completeDeliveredCronJob) — a crash between
 * collection and delivery then replays instead of losing the run.
 * The caller owns delivery (inject as user input while the REPL is idle).
 */
export function collectDueCronJobs(
  now: Date,
  scope?: ScheduleScope,
): Array<{ job: ScheduledJob; prompt: string }> {
  const due: Array<{ job: ScheduledJob; prompt: string }> = [];
  const minuteMarker = Math.floor(now.getTime() / 60_000);
  const tryFire = (job: ScheduledJob): void => {
    if (scope?.sessionId && !job.durable && !job.sessionId) return;
    if (!matchesScheduleScope(job, scope)) return;
    if (scope?.workspaceRoot && !job.workspaceRoot)
      job.workspaceRoot = path.resolve(scope.workspaceRoot);
    if (job.pendingDelivery) return; // already collected, awaiting delivery
    if (job.cron.startsWith("+")) {
      // Monotonic elapsed (review fix "校时后提前/延后触发"): createdAt is an
      // hrtime sample, so a wall-clock jump (NTP, manual) cannot stretch or
      // shrink the delay the user asked for.
      const delaySec = Number(job.cron.slice(1));
      const elapsedSec = Number(process.hrtime.bigint() - job.createdAt) / 1e9;
      if (elapsedSec >= delaySec) {
        due.push({ job, prompt: `[Sleep elapsed (${job.cron}s)] ${job.prompt}` });
        markOneShotFired(job); // relative delays are always one-shot
      }
      return;
    }
    if (job.lastFiredMinute === minuteMarker) return;
    if (cronMatches(now, job.cron)) {
      job.lastFiredMinute = minuteMarker;
      due.push({ job, prompt: `[Scheduled job ${job.id}] ${job.prompt}` });
      if (!job.recurring) markOneShotFired(job);
    }
  };

  // Durable jobs with a loaded workspace root fire INSIDE the file lock, and
  // the post-fire state persists BEFORE the lock releases (self-review fix
  // "同分钟双发窗口仍在"): the first cut only locked the disk merge while the
  // minute marker was set and persisted unlocked afterwards — two processes
  // ticking the same minute before either persisted could both deliver.
  const durableRoots = new Map<string, string>();
  for (const job of JOBS.values()) {
    if (!job.durable || !job.workspaceRoot || !matchesScheduleScope(job, scope)) continue;
    durableRoots.set(scheduleWorkspaceKey(job.workspaceRoot), job.workspaceRoot);
  }
  const handled = new Set<ScheduledJob>();
  for (const root of durableRoots.values()) {
    try {
      withFileLock(durablePath(root), () => {
        syncDurableFromDisk(root);
        for (const job of [...JOBS.values()]) {
          if (!job.durable || handled.has(job)) continue;
          if (scheduleWorkspaceKey(job.workspaceRoot ?? root) !== scheduleWorkspaceKey(root))
            continue;
          handled.add(job);
          tryFire(job);
        }
        if (due.some(({ job }) => job.durable && job.workspaceRoot === root))
          persistDurableJobsLocked(root);
      });
    } catch {
      // Lock trouble: leave these jobs unhandled — the unlocked pass below
      // keeps them firing (availability over the narrowed race).
    }
  }

  // Everything else (ephemeral jobs, and durable jobs without a loaded root —
  // they never touch the shared file, so there is nothing to lock).
  for (const job of [...JOBS.values()]) {
    if (handled.has(job)) continue;
    tryFire(job);
  }
  for (const root of new Set(
    due.filter(({ job }) => job.durable).map(({ job }) => job.workspaceRoot),
  )) {
    if (root) persistDurableJobs(root);
  }
  return due;
}

/** A fired one-shot either leaves the registry (ephemeral) or — durable —
 *  flips to pendingDelivery, surviving on disk until real delivery. */
function markOneShotFired(job: ScheduledJob): void {
  if (job.durable) {
    job.pendingDelivery = true;
    return;
  }
  deleteJobEntry(job);
}

/**
 * Delivery completion (review fix): the durable one-shot's queued input was
 * actually handed to a host — NOW it is safe to forget the job. The delete
 * runs INSIDE the file lock after the disk merge, so the just-deleted record
 * cannot be re-adopted from the still-on-disk copy and resurrected. Returns
 * true when a pending job was retired.
 */
export function completeDeliveredCronJob(jobId: string, workspaceRoot?: string): boolean {
  const job = getScheduledJob(jobId, workspaceRoot ? { workspaceRoot } : undefined);
  if (!job || !job.durable || !job.pendingDelivery) return false;
  const root =
    job.workspaceRoot ??
    (typeof workspaceRoot === "string" ? path.resolve(workspaceRoot) : undefined);
  if (!root) {
    deleteJobEntry(job);
    return true;
  }
  ensureDurableJobsLoaded(root);
  try {
    withFileLock(durablePath(root), () => {
      syncDurableFromDisk(root);
      deleteJobEntry(job);
      persistDurableJobsLocked(root);
    });
  } catch {
    // Lock failure: retire in memory; the next persist/load pass drops the
    // stale disk copy (pendingDelivery replays at worst — never a loss).
    deleteJobEntry(job);
    persistDurableJobs(root);
  }
  return true;
}

// --- durable persistence -----------------------------------------------------

interface DurableJobRecord {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAtMs: number;
  /**
   * Review fix ("重启后同分钟双发"): the minute-dedup marker was NOT
   * persisted, so a recurring job that fired at 10:00:30 pre-restart fired
   * AGAIN when the process restarted inside the same minute. Round-trip it.
   */
  lastFiredMinute?: number;
  /** Durable one-shot collected but not yet delivered (see ScheduledJob). */
  pendingDelivery?: boolean;
}

function durablePath(root: string): string {
  return path.join(root, ".claude", "scheduled_tasks.json");
}

/** Write the durable set for `root` from the in-memory registry. MUST run
 *  under the scheduled_tasks.json lock (call persistDurableJobs). */
function persistDurableJobsLocked(root: string): void {
  for (const job of JOBS.values()) {
    if (job.durable && !job.workspaceRoot) job.workspaceRoot = path.resolve(root);
  }
  const jobs: DurableJobRecord[] = [...JOBS.values()]
    .filter((j) => j.durable && matchesScheduleScope(j, { workspaceRoot: root }))
    .map((j) => ({
      id: j.id,
      cron: j.cron,
      prompt: j.prompt,
      recurring: j.recurring,
      createdAtMs: j.createdAtMs,
      lastFiredMinute: j.lastFiredMinute,
      ...(j.pendingDelivery ? { pendingDelivery: true } : {}),
    }));
  const dir = path.dirname(durablePath(root));
  fs.mkdirSync(dir, { recursive: true });
  const file = durablePath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`);
  renameSyncWithRetry(tmp, file);
}

/**
 * Merge the on-disk durable set into memory (call under the lock). Entries
 * another process added appear here; entries it deleted leave memory; minute
 * markers take the fresher value. This is what makes concurrent terminals
 * converge instead of overwriting each other (review fix).
 */
function syncDurableFromDisk(root: string): void {
  let records: DurableJobRecord[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(durablePath(root), "utf8")) as { jobs?: unknown };
    if (Array.isArray(parsed.jobs)) records = parsed.jobs as DurableJobRecord[];
  } catch {
    return; // unreadable disk state — keep memory as-is
  }
  const diskById = new Map(records.map((record) => [record.id, record]));
  const wsKey = scheduleWorkspaceKey(root);
  // Drop durable jobs for this root that another process removed.
  for (const job of [...JOBS.values()]) {
    if (
      job.durable &&
      matchesScheduleScope(job, { workspaceRoot: root }) &&
      !diskById.has(job.id)
    ) {
      deleteJobEntry(job);
      cancelScheduledInputs("cron", job.id, { workspaceRoot: root });
    }
  }
  // Adopt jobs another process added; refresh markers of shared ones. Lookups
  // accept BOTH key spellings — registerScheduledJob stores bare ids while
  // loadDurableJobs stores `<workspaceKey>:<id>` (review fix: the mismatch
  // re-adopted an already-loaded job under a second key, and a persist then
  // wrote the same job twice).
  for (const record of records) {
    const existing = JOBS.get(record.id) ?? JOBS.get(`${wsKey}:${record.id}`);
    if (existing) {
      if (typeof record.lastFiredMinute === "number")
        existing.lastFiredMinute = Math.max(existing.lastFiredMinute ?? 0, record.lastFiredMinute);
      // OR, not assign: a pendingDelivery marking from THIS process must not
      // be erased by the stale on-disk copy still saying false.
      if (record.pendingDelivery === true) existing.pendingDelivery = true;
      continue;
    }
    if (
      typeof record?.id !== "string" ||
      typeof record?.cron !== "string" ||
      typeof record?.prompt !== "string" ||
      validateCron(record.cron) !== null ||
      JOBS.size >= MAX_SCHEDULED_JOBS
    )
      continue;
    JOBS.set(`${wsKey}:${record.id}`, {
      id: record.id,
      cron: record.cron.trim(),
      prompt: record.prompt,
      recurring: record.recurring !== false,
      durable: true,
      workspaceRoot: path.resolve(root),
      createdAt: process.hrtime.bigint(),
      createdAtMs: typeof record.createdAtMs === "number" ? record.createdAtMs : Date.now(),
      lastFiredMinute:
        typeof record.lastFiredMinute === "number" ? record.lastFiredMinute : undefined,
      pendingDelivery: record.pendingDelivery === true || undefined,
    });
  }
}

/**
 * Persist all durable jobs to <root>/.claude/scheduled_tasks.json. Best-effort:
 * a write failure is swallowed (the in-memory registry stays authoritative;
 * durability is a convenience, not a guarantee). Runs the disk-merge + write
 * under the file lock so concurrent processes never clobber each other.
 */
export function persistDurableJobs(root: string): void {
  try {
    ensureDurableJobsLoaded(root);
    withFileLock(durablePath(root), () => {
      syncDurableFromDisk(root);
      persistDurableJobsLocked(root);
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Load durable jobs saved by a previous run. Invalid records (bad cron
 * expression, malformed entries) are skipped rather than aborting the load;
 * ids are preserved so CronDelete keeps working across restarts.
 */
export function loadDurableJobs(root: string): { loaded: number; skipped: number } {
  loadedWorkspaces.set(scheduleWorkspaceKey(root), root);
  let raw: string;
  try {
    raw = fs.readFileSync(durablePath(root), "utf8");
  } catch {
    return { loaded: 0, skipped: 0 };
  }
  let parsed: { jobs?: DurableJobRecord[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { loaded: 0, skipped: 0 };
  }
  let loaded = 0;
  let skipped = 0;
  for (const record of Array.isArray(parsed?.jobs) ? parsed.jobs : []) {
    if (
      typeof record?.id !== "string" ||
      typeof record?.cron !== "string" ||
      typeof record?.prompt !== "string" ||
      validateCron(record.cron) !== null ||
      getScheduledJob(record.id, { workspaceRoot: root }) ||
      JOBS.size >= MAX_SCHEDULED_JOBS
    ) {
      skipped++;
      continue;
    }
    JOBS.set(`${scheduleWorkspaceKey(root)}:${record.id}`, {
      id: record.id,
      cron: record.cron.trim(),
      prompt: record.prompt,
      recurring: record.recurring !== false,
      durable: true,
      workspaceRoot: path.resolve(root),
      createdAt: process.hrtime.bigint(),
      createdAtMs: typeof record.createdAtMs === "number" ? record.createdAtMs : Date.now(),
      lastFiredMinute:
        typeof record.lastFiredMinute === "number" ? record.lastFiredMinute : undefined,
      pendingDelivery: record.pendingDelivery === true || undefined,
    });
    // A one-shot marked pending-delivery never reached a host before the
    // process ended — re-enqueue its prompt so the run replays after restart
    // instead of vanishing (review fix "collect 后、deliver 前退出即丢失").
    if (record.pendingDelivery === true) {
      enqueueScheduledInput({
        registry: "cron",
        source: "cron",
        jobId: record.id,
        prompt: `[Scheduled job ${record.id}] ${record.prompt}`,
        label: `定时任务 ${record.id} 补投递`,
        workspaceRoot: path.resolve(root),
      });
    }
    loaded++;
  }
  return { loaded, skipped };
}

/** Load a newly selected workspace before any registry write can overwrite its file. */
export function ensureDurableJobsLoaded(root: string): void {
  if (!loadedWorkspaces.has(scheduleWorkspaceKey(root))) loadDurableJobs(root);
}

/** Test/util: clear all scheduled jobs. */
export function resetScheduledJobs(): void {
  JOBS.clear();
  cancelScheduledInputs("cron");
  loadedWorkspaces.clear();
  jobCounter = 0;
}
