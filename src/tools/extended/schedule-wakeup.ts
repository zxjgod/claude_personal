// ============================================================
// ScheduleWakeup Tool — Dynamic loop scheduling
// ============================================================
// For /loop dynamic mode self-paced iterations. Different from CronCreate:
// - Single wakeup (not recurring)
// - Considers prompt cache TTL (5 min)
// - Integrated with /loop workflow
// ============================================================

import { z } from "zod";
import { executionForConfig } from "../../loop-budget.js";
import { loopExecution } from "../../loop-execution-context.js";
import { suggestLoopWakeup, ticketRecord } from "../../loop-runtime.js";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";
import {
  cancelScheduledInputs,
  matchesScheduleScope,
  type ScheduleScope,
} from "./schedule-scope.js";

export interface WakeupJob extends ScheduleScope {
  id: string;
  delaySeconds: number;
  prompt: string;
  reason: string;
  scheduledAt: bigint;
  fireAt: bigint;
  scheduledAtMs?: number;
}

const WAKEUP_JOBS = new Map<string, WakeupJob>();
export function restoreWakeups(root: string, sessionId: string, values: unknown[]): void {
  // Review fix ("atMs 立即触发"): a wakeup whose absolute fireAtMs passed
  // while the process was down used to restore with delaySeconds=0 and fire
  // on the FIRST scheduler tick — a /loop paused days ago resurrected
  // instantly on session resume. Past-due wakeups get a short catch-up
  // grace; older ones are dropped (the loop is long dead — the user can
  // restart it deliberately).
  const CATCH_UP_GRACE_MS = 10 * 60_000;
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<WakeupJob> & { fireAtMs?: number };
    if (
      typeof entry.id !== "string" ||
      WAKEUP_JOBS.has(entry.id) ||
      typeof entry.prompt !== "string" ||
      typeof entry.fireAtMs !== "number" ||
      entry.fireAtMs < Date.now() - 7 * 86400000 ||
      entry.fireAtMs < Date.now() - CATCH_UP_GRACE_MS
    )
      continue;
    const delaySeconds = Math.max(0, Math.ceil((entry.fireAtMs - Date.now()) / 1000));
    const now = process.hrtime.bigint();
    WAKEUP_JOBS.set(entry.id, {
      id: entry.id,
      prompt: entry.prompt,
      reason: entry.reason ?? "restored wakeup",
      delaySeconds,
      scheduledAt: now,
      fireAt: now + BigInt(delaySeconds) * 1000000000n,
      workspaceRoot: root,
      sessionId,
      scheduledAtMs: entry.scheduledAtMs,
    });
  }
}
let wakeupCounter = 0;

function nextWakeupId(): string {
  wakeupCounter += 1;
  return `wakeup-${process.hrtime.bigint().toString(36)}-${wakeupCounter}`;
}

/**
 * Schedule a wakeup job. Returns the job ID.
 */
export function scheduleWakeup(
  delaySeconds: number,
  prompt: string,
  reason: string,
  scope: ScheduleScope = {},
): WakeupJob {
  const now = process.hrtime.bigint();
  // Review fix (§五 "小数 RangeError"): BigInt(non-integer) throws a
  // RangeError — the tool schema rounds before calling, but scheduleWakeup
  // is also reachable directly (tests, restore). Round at the boundary.
  const delayNs = BigInt(Math.round(delaySeconds) * 1_000_000_000);

  const job: WakeupJob = {
    id: nextWakeupId(),
    delaySeconds,
    prompt,
    reason,
    scheduledAt: now,
    fireAt: now + delayNs,
    scheduledAtMs: Date.now(),
    workspaceRoot: scope.workspaceRoot,
    sessionId: scope.sessionId,
  };

  WAKEUP_JOBS.set(job.id, job);
  return job;
}

/**
 * List all pending wakeup jobs.
 */
export function listWakeupJobs(scope?: ScheduleScope): WakeupJob[] {
  return [...WAKEUP_JOBS.values()].filter((job) => matchesScheduleScope(job, scope));
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
export function cancelWakeup(id: string, scope?: ScheduleScope): boolean {
  const job = WAKEUP_JOBS.get(id);
  const removed = job && matchesScheduleScope(job, scope) ? WAKEUP_JOBS.delete(id) : false;
  return cancelScheduledInputs("wakeup", id, scope) > 0 || removed;
}

/**
 * Cancel every pending wakeup (ends all /loop dynamic-mode loops).
 * Returns how many were cancelled.
 */
export function cancelAllWakeupJobs(scope?: ScheduleScope): number {
  const jobs = listWakeupJobs(scope);
  for (const job of jobs) WAKEUP_JOBS.delete(job.id);
  return jobs.length + cancelScheduledInputs("wakeup", undefined, scope);
}

/**
 * Clear all wakeup jobs (for tests).
 */
export function resetWakeupJobs(): void {
  WAKEUP_JOBS.clear();
  cancelScheduledInputs("wakeup");
  wakeupCounter = 0;
}

// ============================================================
// ScheduleWakeup Tool
// ============================================================

const ScheduleWakeupSchema = z
  .strictObject({
    delaySeconds: z
      .number()
      .min(60)
      .max(3600)
      .optional()
      .describe("Seconds from now to wake up (60-3600, clamped by runtime)"),
    prompt: z.string().min(1).optional().describe("The /loop input to fire on wake-up"),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe("One short sentence explaining the chosen delay (shown to user)"),
    stop: z
      .boolean()
      .optional()
      .describe("Set to true to end the dynamic loop immediately (ignores other fields)"),
  })
  .superRefine((input, ctx) => {
    if (input.stop === true) return;
    if (input.delaySeconds === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delaySeconds"],
        message: "Required unless stop=true",
      });
    if (input.prompt === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "Required unless stop=true",
      });
    if (input.reason === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Required unless stop=true",
      });
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

  async call(input, context): Promise<ToolResult> {
    const execution = context.modelConfig
      ? executionForConfig(context.modelConfig)
      : loopExecution();
    if (execution) {
      if (context.sessionId !== execution.scope.sessionId)
        return {
          content: "The parent managed loop owns scheduling. Return the findings to the parent.",
        };
      if (!ticketRecord(execution))
        return { content: "", error: "This loop iteration is no longer active." };
      suggestLoopWakeup(
        execution.scope,
        input.delaySeconds ?? 180,
        input.reason ?? "Completion check requested.",
        input.stop === true,
      );
      return {
        content:
          input.stop === true
            ? "Completion requested. The runtime will independently verify the objective before ending the loop."
            : "Delay suggestion recorded. The runtime applies the 3-30 minute interval and the selected profile.",
      };
    }
    // Stop the loop
    if (input.stop === true) {
      // Clear all pending wakeups
      const count = cancelAllWakeupJobs(context);
      return {
        content: `Dynamic loop stopped. Cancelled ${count} pending wakeup(s).`,
      };
    }

    // Validate required fields when not stopping
    if (!input.prompt || !input.reason || input.delaySeconds === undefined) {
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

    const job = scheduleWakeup(delay, input.prompt, input.reason, context);

    return {
      content:
        `Scheduled wakeup in ${delay}s (${input.reason})\n` +
        `Job ID: ${job.id}\n` +
        `Will enqueue: ${input.prompt.slice(0, 100)}${input.prompt.length > 100 ? "..." : ""}` +
        cacheNote,
    };
  },
});
