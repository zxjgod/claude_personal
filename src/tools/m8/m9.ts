// ============================================================
// M14 Tools — Worktree, Skill, Cron/Sleep, PowerShell
// ============================================================
// Breadth tools added in milestone M14. Kept in a separate file so
// tools.ts stays focused on the core file/shell tools.
//
//   14.1 EnterWorktree / ExitWorktree — git worktree isolation so
//        sub-tasks can mutate files in parallel without clobbering the
//        main working tree.
//   14.2 SkillTool — resolve a registered skill (src/skills.ts) and
//        surface its prompt to the model.
//   14.3 ScheduleCron / Sleep — register cron-scheduled prompts and a
//        one-shot delay. Session-scoped unless durable.
//   14.4 PowerShell — Windows-only explicit PowerShell execution path.
//
// Worktree / cron are potentially destructive or long-running; they
// require interactive approval in default mode (createTool derives
// requiresApproval from !isReadOnly) and degrade gracefully when the
// interactive callbacks are absent.
// ============================================================

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { runForkSkill } from "../../skills/forkSkill.js";
import { getSkill, listSkills, resolveSkillPrompt } from "../../skills.js";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

const execFileAsync = promisify(execFile);

// ============================================================
// 14.1 Worktree isolation — session-scoped worktree stack
// ============================================================
// Real Claude Code tracks an active worktree per session and rewrites
// the cwd the agent operates in. Here we keep an in-process stack
// (session id -> array of created worktree paths) so EnterWorktree can
// create one and ExitWorktree can keep/remove it. The cwd switch itself
// is surfaced in the tool result for the agent loop / user to act on;
// mutating process.cwd() globally would be unsafe across concurrent
// sub-agents, so we report the path instead.

interface WorktreeEntry {
  /** Absolute path to the created worktree. */
  path: string;
  /** Branch created for the worktree. */
  branch: string;
}

const WORKTREES = new Map<string, WorktreeEntry[]>();

function worktreeDir(sessionId: string): string {
  return path.join(".claude", "worktrees");
}

export function resetWorktrees(sessionId: string): void {
  WORKTREES.delete(sessionId);
}

async function git(args: string[], cwd: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

function randomName(): string {
  const t = process.hrtime.bigint().toString(16).slice(-8);
  return `wt-${t}`;
}

const EnterWorktreeSchema = z.strictObject({
  name: z.string().optional().describe("Branch/worktree name (optional)"),
  baseRef: z
    .enum(["fresh", "head"])
    .optional()
    .describe("fresh = origin default branch, head = current HEAD (default: fresh)"),
});

export const EnterWorktreeTool: Tool = buildTool({
  name: "enter_worktree",
  description: "Create a git worktree and switch the session into it",
  promptDescription:
    "Create an isolated git worktree on a new branch so you can make changes " +
    "without touching the main working tree. name sets the branch name " +
    "(a random one is used otherwise); baseRef=fresh branches from the " +
    "upstream default branch, head from current HEAD. Returns the worktree " +
    "path — operate there until exit_worktree.",
  schema: EnterWorktreeSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    const root = context.workspaceRoot;
    const inside = await git(["rev-parse", "--is-inside-work-tree"], root);
    if (inside?.trim() !== "true") {
      return { content: "", error: "Not a git repository — cannot create a worktree." };
    }

    const baseRef = input.baseRef ?? "fresh";
    let startPoint = "HEAD";
    if (baseRef === "fresh") {
      const def = await git(["rev-parse", "--abbrev-ref", "refs/remotes/origin/HEAD"], root);
      if (def) {
        const resolved = await git(["rev-parse", def.trim()], root);
        if (resolved) startPoint = resolved.trim();
      }
    }

    const branch = (input.name?.trim() || randomName()).replace(/[^A-Za-z0-9._-]/g, "-");
    const wtPath = path.join(root, worktreeDir(context.sessionId), branch);

    const out = await git(["worktree", "add", "-b", branch, wtPath, startPoint], root, 15_000);
    if (out === null) {
      return {
        content: "",
        error: `git worktree add failed for branch "${branch}" (it may already exist).`,
      };
    }

    const stack = WORKTREES.get(context.sessionId) ?? [];
    stack.push({ path: wtPath, branch });
    WORKTREES.set(context.sessionId, stack);

    return {
      content:
        `Created worktree on branch "${branch}" (from ${baseRef}).\n` +
        `Path: ${wtPath}\n` +
        `Operate inside this path until you call exit_worktree.`,
      metadata: {},
    };
  },
});

const ExitWorktreeSchema = z.strictObject({
  action: z.enum(["keep", "remove"]).optional().describe("keep (default) or remove"),
  discardChanges: z.boolean().optional().describe("Force-remove with uncommitted changes"),
});

export const ExitWorktreeTool: Tool = buildTool({
  name: "exit_worktree",
  description: "Leave the active worktree, keeping or removing it",
  promptDescription:
    "Exit the current worktree session. action=keep leaves the branch and " +
    "directory on disk; action=remove deletes them (use discardChanges=true " +
    "to force-remove even with uncommitted changes). Returns to the main " +
    "working tree.",
  schema: ExitWorktreeSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    const stack = WORKTREES.get(context.sessionId);
    if (!stack || stack.length === 0) {
      return { content: "No active worktree to exit.", error: undefined };
    }
    const entry = stack[stack.length - 1]!;
    const action = input.action ?? "keep";
    const root = context.workspaceRoot;

    if (action === "remove") {
      const dirty = await git(["status", "--porcelain"], entry.path);
      const hasChanges = !!dirty && dirty.trim().length > 0;
      if (hasChanges && !input.discardChanges) {
        return {
          content: "",
          error:
            `Worktree "${entry.branch}" has uncommitted changes. ` +
            `Re-run with discardChanges=true to force-remove, or action=keep.`,
        };
      }
      const removed = await git(["worktree", "remove", "--force", entry.path], root, 15_000);
      await git(["branch", "-D", entry.branch], root, 8000);
      if (removed === null) {
        return { content: "", error: `git worktree remove failed for ${entry.path}` };
      }
    }

    stack.pop();
    if (stack.length === 0) WORKTREES.delete(context.sessionId);

    return {
      content:
        `Exited worktree "${entry.branch}". ` +
        (action === "remove" ? "Worktree and branch deleted." : "Kept on disk at " + entry.path),
    };
  },
});

// ============================================================
// 14.2 SkillTool — resolve + surface a registered skill
// ============================================================

const SkillSchema = z.strictObject({
  skill: z.string().describe("Skill name (kebab-case)"),
  args: z.string().optional().describe("Optional arguments for the skill"),
});

export const SkillTool: Tool = buildTool({
  name: "skill",
  description: "Invoke a registered skill by name and load its instructions",
  promptDescription:
    "Invoke a named skill (e.g. skill=deep-research) to load its specialized " +
    "instructions into the conversation. Pass args to parameterize it. A skill's " +
    "full body is loaded only when invoked. context:'fork' skills run in a " +
    "sub-agent and return only their final report. If the skill name is unknown, " +
    "the result lists available skills. Only invoke skills from the available-" +
    "skills list or one the user explicitly named.",
  schema: SkillSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const name = input.skill.trim();
    if (!name) {
      return { content: "", error: "skill is required" };
    }
    const skill = getSkill(name);
    if (!skill) {
      const available = listSkills()
        .map((s) => `  - ${s.name}: ${s.description}`)
        .join("\n");
      return {
        content: "",
        error: `Unknown skill "${name}". Available skills:\n${available}`,
      };
    }

    // Resolve the body now (kernel: discovery cheap, loading expensive — the
    // template/shell expansion happens here, at invocation, not at discovery).
    let resolved: string;
    try {
      resolved = await resolveSkillPrompt(skill, {
        args: input.args,
        workspaceRoot: context.workspaceRoot,
      });
    } catch (error: any) {
      return { content: "", error: `Skill "${name}" failed to load: ${error?.message ?? error}` };
    }

    // context:'fork' → run the body in a sub-agent and return only its final
    // text (kernel §6 context protection). Falls back to inline injection when
    // the loop didn't provide modelConfig (e.g. unit tests calling .call bare).
    if (skill.context === "fork" && context.modelConfig) {
      return runForkSkill(skill, resolved, context);
    }

    return {
      content: `Skill "${skill.name}" loaded.\n\n` + `Instructions:\n${resolved}`,
    };
  },
});

// ============================================================
// 14.3 ScheduleCron / Sleep — session-scoped scheduling
// ============================================================
// The scheduler surface mirrors the real tool's contract: jobs fire only
// while the REPL is idle, are session-scoped by default, and may opt into
// durable persistence. Here we provide the registry + validation; the
// CLI wires the actual firing loop (it already owns the idle loop). Tests
// cover validation/registration without needing a live timer.

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

/** Test/util: clear all scheduled jobs. */
export function resetScheduledJobs(): void {
  JOBS.clear();
  jobCounter = 0;
}

/** List registered jobs (for /status and tests). */
export function listScheduledJobs(): ScheduledJob[] {
  return [...JOBS.values()];
}

/** Get a job by id (for cancellation/tests). */
export function getScheduledJob(id: string): ScheduledJob | undefined {
  return JOBS.get(id);
}

/** Remove a job. Returns true if it existed. */
export function removeScheduledJob(id: string): boolean {
  return JOBS.delete(id);
}

/** Next id without Math.random (banned in some harnesses). */
function nextJobId(): string {
  jobCounter += 1;
  return `job-${process.hrtime.bigint().toString(36)}-${jobCounter}`;
}

/**
 * Validate a 5-field cron expression minimally: 5 whitespace-separated
 * fields, each a recognized pattern (number, star, star-slash-n, range a-b,
 * list a,b). This is intentionally permissive — it catches gross typos, not
 * every edge of real cron grammar. Returns null if valid, an error string
 * if not.
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

const ScheduleCronSchema = z.strictObject({
  cron: z.string().describe("5-field cron expression, local time"),
  prompt: z.string().describe("Prompt to enqueue at each fire"),
  recurring: z.boolean().optional().describe("Fire repeatedly (default true)"),
  durable: z.boolean().optional().describe("Persist across restarts (default false)"),
});

export const ScheduleCronTool: Tool = buildTool({
  name: "schedule_cron",
  description: "Schedule a prompt to fire on a cron schedule",
  promptDescription:
    "Enqueue a prompt to run on a recurring (or one-shot) cron schedule. " +
    "cron is a 5-field expression (min hour dom mon dow, local time). The " +
    "prompt fires only while the REPL is idle. durable=true persists the " +
    "job across restarts. Avoid the :00 and :30 minute marks to spread load.",
  schema: ScheduleCronSchema,
  isReadOnly: false,
  isConcurrencySafe: true,

  async call(input): Promise<ToolResult> {
    const err = validateCron(input.cron);
    if (err) return { content: "", error: err };
    const job: ScheduledJob = {
      id: nextJobId(),
      cron: input.cron.trim(),
      prompt: input.prompt,
      recurring: input.recurring ?? true,
      durable: input.durable ?? false,
      createdAt: process.hrtime.bigint(),
    };
    JOBS.set(job.id, job);
    return {
      content:
        `Scheduled ${job.recurring ? "recurring" : "one-shot"} job ${job.id} ` +
        `(cron "${job.cron}"${job.durable ? ", durable" : ""}). ` +
        `Fires while the REPL is idle. Cancel via the scheduled-jobs list.`,
    };
  },
});

const SleepSchema = z.strictObject({
  delaySeconds: z.number().describe("Seconds to wait (60-3600)"),
  reason: z.string().describe("Why you are waiting"),
  prompt: z.string().optional().describe("Optional prompt to enqueue after the delay"),
});

export const SleepTool: Tool = buildTool({
  name: "sleep",
  description: "Pause for N seconds, optionally enqueuing a prompt afterward",
  promptDescription:
    "Sleep for delaySeconds (clamped 60-3600) before continuing. reason is " +
    "shown to the user. If prompt is provided, it is enqueued after the " +
    "delay. Use for self-paced loops; for external polling prefer waiting " +
    "on the actual signal rather than a fixed short interval.",
  schema: SleepSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input): Promise<ToolResult> {
    const raw = Number(input.delaySeconds);
    if (!Number.isFinite(raw) || raw <= 0) {
      return { content: "", error: "delaySeconds must be a positive number" };
    }
    const delay = Math.min(Math.max(Math.round(raw), 60), 3600);
    if (input.prompt?.trim()) {
      const job: ScheduledJob = {
        id: nextJobId(),
        cron: `+${delay}`,
        prompt: input.prompt,
        recurring: false,
        durable: false,
        createdAt: process.hrtime.bigint(),
      };
      JOBS.set(job.id, job);
      return {
        content: `Will enqueue prompt after ${delay}s (${input.reason}). Job ${job.id}.`,
      };
    }
    return {
      content:
        `Sleep acknowledged for ${delay}s (${input.reason}). ` +
        `No prompt to enqueue — returning immediately; the REPL does not block.`,
    };
  },
});

// ============================================================
// 14.4 PowerShell — Windows-only explicit shell
// ============================================================

const PowerShellSchema = z.strictObject({
  command: z.string().describe("PowerShell command or script"),
  description: z.string().describe("What the command does"),
  timeout: z.number().optional().describe("Max runtime in ms (default 120000)"),
});

export const PowerShellTool: Tool = buildTool({
  name: "powershell",
  description: "Run a PowerShell command (Windows only)",
  promptDescription:
    "Execute a PowerShell command on Windows when bash semantics won't do " +
    "(e.g. Windows-specific cmdlets, registry, COM objects). Disabled off " +
    "Windows. Provide a description of what the command does. Returns stdout " +
    "and exit code; non-zero exit is surfaced as an error.",
  schema: PowerShellSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input): Promise<ToolResult> {
    if (process.platform !== "win32") {
      return { content: "", error: "PowerShell tool is only available on Windows." };
    }
    const timeout = Math.min(input.timeout ?? 120_000, 600_000);
    const bin = "powershell.exe";
    try {
      const { stdout, stderr } = await execFileAsync(
        bin,
        ["-NoProfile", "-NonInteractive", "-Command", input.command],
        { timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      );
      const out = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).trimEnd();
      return { content: out || "(no output)", metadata: { exitCode: 0 } };
    } catch (error: any) {
      const code = error.code ?? 1;
      const out = (error.stdout ?? "") + (error.stderr ? "\n[stderr]\n" + error.stderr : "");
      return {
        content: out.trimEnd() || "(no output)",
        error: `PowerShell exited with code ${code}`,
        metadata: { exitCode: code },
      };
    }
  },
});

PowerShellTool.isEnabled = () => process.platform === "win32";

// ============================================================
// Exports bundle
// ============================================================

export const M14_TOOLS: Tool[] = [
  EnterWorktreeTool,
  ExitWorktreeTool,
  SkillTool,
  ScheduleCronTool,
  SleepTool,
  PowerShellTool,
];
