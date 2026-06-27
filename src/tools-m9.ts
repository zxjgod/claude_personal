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
import { getSkill, listSkills } from "./skills.js";
import { createTool } from "./tool-registry.js";
import type { PermissionResult, Tool, ToolResult } from "./types.js";

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
  // Park worktrees under .claude/worktrees/ in the repo, matching real
  // Claude Code's convention. git worktree add handles creation.
  return path.join(".claude", "worktrees");
}

/** Test/util: clear the worktree stack for a session. */
export function resetWorktrees(sessionId: string): void {
  WORKTREES.delete(sessionId);
}

/** Best-effort git invocation; returns null on any failure. */
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

interface EnterWorktreeInput {
  /** Optional branch name; a random one is generated if omitted. */
  name?: string;
  /** Base ref to branch from: "fresh" (origin/<default>) or "head" (current HEAD). */
  baseRef?: "fresh" | "head";
  [key: string]: unknown;
}

function randomName(): string {
  // Deterministic-free suffix from a counter + timestamp-ish hex. Avoids
  // Math.random (banned in some harnesses) by mixing process.hrtime.
  const t = process.hrtime.bigint().toString(16).slice(-8);
  return `wt-${t}`;
}

export const EnterWorktreeTool: Tool = createTool<EnterWorktreeInput>({
  name: "enter_worktree",
  description: "Create a git worktree and switch the session into it",
  promptDescription:
    "Create an isolated git worktree on a new branch so you can make changes " +
    "without touching the main working tree. name sets the branch name " +
    "(a random one is used otherwise); baseRef=fresh branches from the " +
    "upstream default branch, head from current HEAD. Returns the worktree " +
    "path — operate there until exit_worktree.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Branch/worktree name (optional)" },
      baseRef: {
        type: "string",
        enum: ["fresh", "head"],
        description: "fresh = origin default branch, head = current HEAD (default: fresh)",
      },
    },
    required: [],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async checkPermissions(_input, _context): Promise<PermissionResult> {
    // Creating a worktree writes to .claude/worktrees/ and creates a branch.
    // Default mode prompts; bypass/acceptEdits proceed. No path traversal
    // risk since the path is computed, not user-supplied.
    return { allowed: true };
  },

  async call(input, context): Promise<ToolResult> {
    const root = context.workspaceRoot;
    const inside = await git(["rev-parse", "--is-inside-work-tree"], root);
    if (inside?.trim() !== "true") {
      return { content: "", error: "Not a git repository — cannot create a worktree." };
    }

    const baseRef = input.baseRef ?? "fresh";
    let startPoint = "HEAD";
    if (baseRef === "fresh") {
      // Resolve the default upstream branch's HEAD. Fall back to HEAD.
      const def = await git(["rev-parse", "--abbrev-ref", "refs/remotes/origin/HEAD"], root);
      if (def) {
        const resolved = await git(["rev-parse", def.trim()], root);
        if (resolved) startPoint = resolved.trim();
      }
    }

    const branch = (input.name?.trim() || randomName()).replace(/[^A-Za-z0-9._-]/g, "-");
    const wtPath = path.join(root, worktreeDir(context.sessionId), branch);

    // git worktree add -b <branch> <path> <startpoint>
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

interface ExitWorktreeInput {
  /** keep leaves the worktree + branch on disk; remove deletes both. */
  action?: "keep" | "remove";
  /** Required when action=remove and the worktree has uncommitted changes. */
  discardChanges?: boolean;
  [key: string]: unknown;
}

export const ExitWorktreeTool: Tool = createTool<ExitWorktreeInput>({
  name: "exit_worktree",
  description: "Leave the active worktree, keeping or removing it",
  promptDescription:
    "Exit the current worktree session. action=keep leaves the branch and " +
    "directory on disk; action=remove deletes them (use discardChanges=true " +
    "to force-remove even with uncommitted changes). Returns to the main " +
    "working tree.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["keep", "remove"], description: "keep (default) or remove" },
      discardChanges: { type: "boolean", description: "Force-remove with uncommitted changes" },
    },
    required: [],
  },
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
      // Check for uncommitted changes unless explicitly discarded.
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
      // Drop the branch too (best-effort; -d refuses if not merged).
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

interface SkillInput {
  skill: string;
  args?: string;
  [key: string]: unknown;
}

export const SkillTool: Tool = createTool<SkillInput>({
  name: "skill",
  description: "Invoke a registered skill by name and load its instructions",
  promptDescription:
    "Invoke a named skill (e.g. skill=deep-research) to load its specialized " +
    "instructions into the conversation. Pass args to parameterize it. If the " +
    "skill name is unknown, the result lists available skills. Only invoke " +
    "skills from the available-skills list or one the user explicitly named.",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "Skill name (kebab-case)" },
      args: { type: "string", description: "Optional arguments for the skill" },
    },
    required: ["skill"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input): Promise<ToolResult> {
    const name = input.skill?.trim();
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
    const argsLine = input.args?.trim() ? `\n\nArguments: ${input.args}` : "";
    return {
      content: `Skill "${skill.name}" loaded.\n\n` + `Instructions:\n${skill.prompt}${argsLine}`,
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

interface ScheduleCronInput {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  [key: string]: unknown;
}

export const ScheduleCronTool: Tool = createTool<ScheduleCronInput>({
  name: "schedule_cron",
  description: "Schedule a prompt to fire on a cron schedule",
  promptDescription:
    "Enqueue a prompt to run on a recurring (or one-shot) cron schedule. " +
    "cron is a 5-field expression (min hour dom mon dow, local time). The " +
    "prompt fires only while the REPL is idle. durable=true persists the " +
    "job across restarts. Avoid the :00 and :30 minute marks to spread load.",
  inputSchema: {
    type: "object",
    properties: {
      cron: { type: "string", description: "5-field cron expression, local time" },
      prompt: { type: "string", description: "Prompt to enqueue at each fire" },
      recurring: { type: "boolean", description: "Fire repeatedly (default true)" },
      durable: { type: "boolean", description: "Persist across restarts (default false)" },
    },
    required: ["cron", "prompt"],
  },
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

interface SleepInput {
  delaySeconds: number;
  reason: string;
  prompt?: string;
  [key: string]: unknown;
}

export const SleepTool: Tool = createTool<SleepInput>({
  name: "sleep",
  description: "Pause for N seconds, optionally enqueuing a prompt afterward",
  promptDescription:
    "Sleep for delaySeconds (clamped 60-3600) before continuing. reason is " +
    "shown to the user. If prompt is provided, it is enqueued after the " +
    "delay. Use for self-paced loops; for external polling prefer waiting " +
    "on the actual signal rather than a fixed short interval.",
  inputSchema: {
    type: "object",
    properties: {
      delaySeconds: { type: "number", description: "Seconds to wait (60-3600)" },
      reason: { type: "string", description: "Why you are waiting" },
      prompt: { type: "string", description: "Optional prompt to enqueue after the delay" },
    },
    required: ["delaySeconds", "reason"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input): Promise<ToolResult> {
    const raw = Number(input.delaySeconds);
    if (!Number.isFinite(raw) || raw <= 0) {
      return { content: "", error: "delaySeconds must be a positive number" };
    }
    const delay = Math.min(Math.max(Math.round(raw), 60), 3600);
    // We do not actually block the agent loop here — sleeping would freeze
    // the REPL. We register the prompt as a one-shot scheduled job and let
    // the CLI's scheduler fire it. Without a prompt this is a no-op note.
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

interface PowerShellInput {
  command: string;
  description: string;
  timeout?: number;
  [key: string]: unknown;
}

export const PowerShellTool: Tool = createTool<PowerShellInput>({
  name: "powershell",
  description: "Run a PowerShell command (Windows only)",
  promptDescription:
    "Execute a PowerShell command on Windows when bash semantics won't do " +
    "(e.g. Windows-specific cmdlets, registry, COM objects). Disabled off " +
    "Windows. Provide a description of what the command does. Returns stdout " +
    "and exit code; non-zero exit is surfaced as an error.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "PowerShell command or script" },
      description: { type: "string", description: "What the command does" },
      timeout: { type: "number", description: "Max runtime in ms (default 120000)" },
    },
    required: ["command", "description"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input): Promise<ToolResult> {
    if (process.platform !== "win32") {
      return { content: "", error: "PowerShell tool is only available on Windows." };
    }
    const timeout = Math.min(input.timeout ?? 120_000, 600_000);
    // Prefer pwsh (PowerShell 7+) when present, fall back to powershell.exe.
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

// Override isEnabled off the factory (createTool hard-codes it to true).
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
