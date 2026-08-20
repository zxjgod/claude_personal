// ============================================================
// Cron Management Tools — CronCreate, CronDelete, CronList
// ============================================================
// Complete cron scheduling API aligned with official Claude Code.
// CronCreate is an alias for the existing ScheduleCron functionality.
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";
// Re-export the shared job registration from m9.ts
import {
  getScheduledJob,
  listScheduledJobs,
  registerScheduledJob,
  removeScheduledJob,
  type ScheduledJob,
  validateCron,
} from "./cron-shared.js";

// ============================================================
// CronCreate (alias for schedule_cron)
// ============================================================

const CronCreateSchema = z.strictObject({
  cron: z.string().describe("5-field cron expression, local time (M H DoM Mon DoW)"),
  prompt: z.string().describe("Prompt to enqueue at each fire time"),
  recurring: z
    .boolean()
    .optional()
    .describe("true (default) = fire repeatedly, false = fire once then auto-delete"),
  durable: z
    .boolean()
    .optional()
    .describe("true = persist to .claude/scheduled_tasks.json, false (default) = session-only"),
});

export const CronCreateTool: Tool = buildTool({
  name: "CronCreate",
  description: "Schedule a prompt to fire on a cron schedule",
  promptDescription:
    "Schedule a prompt to run on a recurring (or one-shot) cron schedule. " +
    "cron is a 5-field expression (min hour dom mon dow) in local time. " +
    "recurring=true (default) fires repeatedly; false fires once then deletes. " +
    "durable=true persists across restarts. Avoid :00 and :30 minute marks to spread load. " +
    "Returns a job ID you can pass to CronDelete. Fires only while REPL is idle.",
  schema: CronCreateSchema,
  isReadOnly: false,
  isConcurrencySafe: true,
  searchHint: "cron schedule recurring timer task automation",
  aliases: ["schedule_cron", "cron_create"],

  async call(input): Promise<ToolResult> {
    const err = validateCron(input.cron);
    if (err) return { content: "", error: err };

    const job = registerScheduledJob({
      cron: input.cron.trim(),
      prompt: input.prompt,
      recurring: input.recurring ?? true,
      durable: input.durable ?? false,
    });

    return {
      content:
        `Scheduled ${job.recurring ? "recurring" : "one-shot"} job ${job.id}\n` +
        `Cron: "${job.cron}"${job.durable ? " (durable)" : " (session-only)"}\n` +
        `Fires while the REPL is idle. Cancel with CronDelete.`,
    };
  },
});

// ============================================================
// CronDelete
// ============================================================

const CronDeleteSchema = z.strictObject({
  id: z.string().describe("Job ID returned by CronCreate"),
});

export const CronDeleteTool: Tool = buildTool({
  name: "CronDelete",
  description: "Cancel a scheduled cron job",
  promptDescription:
    "Cancel a cron job by its ID (returned from CronCreate). Removes it from both " +
    "session memory and .claude/scheduled_tasks.json if durable. Returns success if " +
    "the job existed, error if not found.",
  schema: CronDeleteSchema,
  isReadOnly: false,
  isConcurrencySafe: true,
  searchHint: "cron cancel delete remove unschedule",
  aliases: ["cron_delete"],

  async call(input): Promise<ToolResult> {
    const removed = removeScheduledJob(input.id);
    if (!removed) {
      return { content: "", error: `Job ${input.id} not found` };
    }
    return { content: `Job ${input.id} cancelled and removed.` };
  },
});

// ============================================================
// CronList
// ============================================================

const CronListSchema = z.strictObject({});

export const CronListTool: Tool = buildTool({
  name: "CronList",
  description: "List all scheduled cron jobs",
  promptDescription:
    "List all cron jobs (both durable and session-only) with their ID, cron expression, " +
    "recurring status, and durable flag. Use to see what's scheduled or find a job ID for CronDelete.",
  schema: CronListSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "cron list show scheduled jobs",
  aliases: ["cron_list"],

  async call(): Promise<ToolResult> {
    const jobs = listScheduledJobs();
    if (jobs.length === 0) {
      return { content: "No scheduled jobs. Create one with CronCreate." };
    }

    const lines = jobs.map((job) => {
      const flags = [
        job.recurring ? "recurring" : "one-shot",
        job.durable ? "durable" : "session-only",
      ].join(", ");
      return `${job.id}: "${job.cron}" [${flags}]`;
    });

    return {
      content: `Scheduled jobs (${jobs.length}):\n${lines.join("\n")}`,
    };
  },
});
