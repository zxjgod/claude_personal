// ============================================================
// Shared Cron Scheduling Logic
// ============================================================
// Extracted from breadth/orchestration.ts to allow reuse by both ScheduleCron and CronCreate/Delete/List.
// ============================================================

export interface ScheduledJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: bigint;
}

const JOBS = new Map<string, ScheduledJob>();
let jobCounter = 0;

/** Generate next job ID */
function nextJobId(): string {
  jobCounter += 1;
  return `job-${process.hrtime.bigint().toString(36)}-${jobCounter}`;
}

/**
 * Validate a 5-field cron expression minimally: 5 whitespace-separated
 * fields, each a recognized pattern (number, star, star-slash-n, range a-b,
 * list a,b). Returns null if valid, an error string if not.
 */
export function validateCron(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
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

/** Register a new scheduled job */
export function registerScheduledJob(input: {
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}): ScheduledJob {
  const job: ScheduledJob = {
    id: nextJobId(),
    cron: input.cron.trim(),
    prompt: input.prompt,
    recurring: input.recurring,
    durable: input.durable,
    createdAt: process.hrtime.bigint(),
  };
  JOBS.set(job.id, job);
  return job;
}

/** List all scheduled jobs */
export function listScheduledJobs(): ScheduledJob[] {
  return [...JOBS.values()];
}

/** Get a job by id */
export function getScheduledJob(id: string): ScheduledJob | undefined {
  return JOBS.get(id);
}

/** Remove a job. Returns true if it existed. */
export function removeScheduledJob(id: string): boolean {
  return JOBS.delete(id);
}

/** Test/util: clear all scheduled jobs. */
export function resetScheduledJobs(): void {
  JOBS.clear();
  jobCounter = 0;
}
