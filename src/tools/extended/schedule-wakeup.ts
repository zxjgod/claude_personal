// ============================================================
// ScheduleWakeup Tool — Dynamic loop scheduling
// ============================================================
// For /loop dynamic mode self-paced iterations. Different from CronCreate:
// - Single wakeup (not recurring)
// - Considers prompt cache TTL (5 min)
// - Integrated with /loop workflow
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

export interface WakeupJob {
  id: string;
  delaySeconds: number;
  prompt: string;
  reason: string;
  scheduledAt: bigint;
  fireAt: bigint;
}

const WAKEUP_JOBS = new Map<string, WakeupJob>();
let wakeupCounter = 0;

function nextWakeupId(): string {
  wakeupCounter += 1;
  return `wakeup-${process.hrtime.bigint().toString(36)}-${wakeupCounter}`;
}

/**
 * Schedule a wakeup job. Returns the job ID.
 */
export function scheduleWakeup(delaySeconds: number, prompt: string, reason: string): WakeupJob {
  const now = process.hrtime.bigint();
  const delayNs = BigInt(delaySeconds * 1_000_000_000);

  const job: WakeupJob = {
    id: nextWakeupId(),
    delaySeconds,
    prompt,
    reason,
    scheduledAt: now,
    fireAt: now + delayNs,
  };

  WAKEUP_JOBS.set(job.id, job);
  return job;
}

/**
 * List all pending wakeup jobs.
 */
export function listWakeupJobs(): WakeupJob[] {
  return [...WAKEUP_JOBS.values()];
}

/**
 * Get a wakeup job by ID.
 */
export function getWakeupJob(id: string): WakeupJob | undefined {
  return WAKEUP_JOBS.get(id);
}

/**
 * Cancel a wakeup job. Returns true if it existed.
 */
export function cancelWakeup(id: string): boolean {
  return WAKEUP_JOBS.delete(id);
}

/**
 * Cancel every pending wakeup (ends all /loop dynamic-mode loops).
 * Returns how many were cancelled.
 */
export function cancelAllWakeupJobs(): number {
  const n = WAKEUP_JOBS.size;
  WAKEUP_JOBS.clear();
  return n;
}

/**
 * Clear all wakeup jobs (for tests).
 */
export function resetWakeupJobs(): void {
  WAKEUP_JOBS.clear();
  wakeupCounter = 0;
}

// ============================================================
// ScheduleWakeup Tool
// ============================================================

const ScheduleWakeupSchema = z.strictObject({
  delaySeconds: z
    .number()
    .min(60)
    .max(3600)
    .describe("Seconds from now to wake up (60-3600, clamped by runtime)"),
  prompt: z.string().min(1).describe("The /loop input to fire on wake-up"),
  reason: z
    .string()
    .min(1)
    .describe("One short sentence explaining the chosen delay (shown to user)"),
  stop: z
    .boolean()
    .optional()
    .describe("Set to true to end the dynamic loop immediately (ignores other fields)"),
});

export const ScheduleWakeupTool: Tool = buildTool({
  name: "ScheduleWakeup",
  description: "Schedule when to resume work in /loop dynamic mode",
  promptDescription:
    "Schedule a wakeup for /loop dynamic mode self-paced iterations. " +
    "delaySeconds (60-3600) is the delay from now. prompt is the /loop input to fire. " +
    "reason (short sentence) explains the delay to the user. " +
    "stop=true ends the loop immediately (omit other fields). " +
    "\n\n" +
    "Anthropic prompt cache has 5-minute TTL. Delays under 300s keep cache warm. " +
    "Over 300s pays cache miss. Don't pick exactly 300s (worst of both). " +
    "For idle ticks with no signal, default to 1200-1800s (20-30 min). " +
    "\n\n" +
    "Example delays:\n" +
    "  - 60-270s: active polling (CI run, deploy status) — cache stays warm\n" +
    "  - 1200-1800s: idle heartbeat — amortize cache miss\n" +
    "  - Never 300s: pay cache miss without amortizing it\n" +
    "\n\n" +
    "Think about what you're waiting for, not just 'how long to sleep'.",
  schema: ScheduleWakeupSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  searchHint: "schedule wakeup loop dynamic delay sleep resume",
  aliases: ["schedule_wakeup"],

  async call(input): Promise<ToolResult> {
    // Stop the loop
    if (input.stop === true) {
      // Clear all pending wakeups
      const count = WAKEUP_JOBS.size;
      WAKEUP_JOBS.clear();
      return {
        content: `Dynamic loop stopped. Cancelled ${count} pending wakeup(s).`,
      };
    }

    // Validate required fields when not stopping
    if (!input.prompt || !input.reason) {
      return {
        content: "",
        error: "prompt and reason are required (unless stop=true)",
      };
    }

    // Clamp delay
    const delay = Math.min(Math.max(Math.round(input.delaySeconds), 60), 3600);

    // Warn about cache-inefficient delays
    let cacheNote = "";
    if (delay >= 295 && delay <= 305) {
      cacheNote =
        "\n⚠️  Warning: 300s is cache-inefficient. Use 270s (stay warm) or 1200s+ (amortize miss).";
    }

    const job = scheduleWakeup(delay, input.prompt, input.reason);

    return {
      content:
        `Scheduled wakeup in ${delay}s (${input.reason})\n` +
        `Job ID: ${job.id}\n` +
        `Will enqueue: ${input.prompt.slice(0, 100)}${input.prompt.length > 100 ? "..." : ""}` +
        cacheNote,
    };
  },
});
