// ============================================================
// Orchestration Tools — Worktree, Skill, Cron/Sleep
// ============================================================
// (Originally milestone M14; renamed from m9.ts.) Kept in a separate file so
// tools.ts stays focused on the core file/shell tools.
//
//   14.1 EnterWorktree / ExitWorktree — git worktree isolation so
//        sub-tasks can mutate files in parallel without clobbering the
//        main working tree.
//   14.2 SkillTool — resolve a registered skill (src/skills.ts) and
//        surface its prompt to the model.
//   14.3 ScheduleCron / Sleep — register cron-scheduled prompts and a
//        one-shot delay. Session-scoped unless durable.
//
//   (PowerShell moved to src/tools/core/powershell.ts — a fuller tool with
//    read-only detection, danger patterns, and process-tree-kill.)
//
// Worktree / cron are potentially destructive or long-running; they
// require interactive approval in default mode (createTool derives
// requiresApproval from !isReadOnly) and degrade gracefully when the
// interactive callbacks are absent.
// ============================================================

import { z } from "zod";
import { activateSkill } from "../../scoped-execution.js";
import { runForkSkill } from "../../skills/forkSkill.js";
import { getSkill, listSkills, resolveSkillPrompt } from "../../skills.js";
import type { Tool, ToolResult } from "../../types.js";
import {
  createIsolatedWorktree,
  currentWorktree,
  openExistingWorktree,
  popWorktree,
  pushWorktree,
  removeIsolatedWorktree,
  worktreeGit,
} from "../../worktrees.js";
import { buildTool } from "../registry.js";
import { clearCwd, setCwd } from "../session-cwd.js";

export { resetWorktrees } from "../../worktrees.js";

const EnterWorktreeSchema = z.strictObject({
  name: z.string().optional(),
  path: z.string().optional(),
  baseRef: z.enum(["fresh", "head"]).optional(),
});
export const EnterWorktreeTool: Tool = buildTool({
  name: "enter_worktree",
  description: "Create or enter an isolated git worktree",
  promptDescription:
    "Create a worktree or enter an existing registered worktree with path. All subsequent file and shell tools use it. Exit with exit_worktree.",
  schema: EnterWorktreeSchema,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    try {
      if (input.path && input.name) throw new Error("Specify name or path, not both");
      const root = context.workspaceRoot;
      let base = "HEAD";
      if (input.baseRef !== "head") {
        try {
          base = await worktreeGit(["symbolic-ref", "refs/remotes/origin/HEAD"], root);
        } catch {
          /* local repository */
        }
      }
      const entry = input.path
        ? await openExistingWorktree(root, input.path)
        : await createIsolatedWorktree(
            root,
            (input.name || `wt-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9._-]/g, "-"),
            base,
          );
      pushWorktree(context.sessionId, entry);
      setCwd(context.sessionId, entry.path);
      await context.hooks?.runEvent?.("WorktreeCreate", { worktree_path: entry.path, cwd: root });
      return {
        content: `Created or entered worktree (from ${input.baseRef ?? "fresh"}).\nPath: ${entry.path}\nBranch: ${entry.branch}\nSession cwd switched. File and shell tools now use this workspace.`,
        metadata: { worktreePath: entry.path, worktreeBranch: entry.branch },
      };
    } catch (error) {
      return { content: "", error: String(error) };
    }
  },
});
const ExitWorktreeSchema = z.strictObject({
  action: z.enum(["keep", "remove"]).optional(),
  discardChanges: z.boolean().optional(),
  discard_changes: z.boolean().optional(),
});
export const ExitWorktreeTool: Tool = buildTool({
  name: "exit_worktree",
  description: "Leave a worktree, preserving its changes by default",
  promptDescription:
    "Leave the active worktree. keep preserves files and branch; remove refuses uncommitted files and unique commits unless discard_changes:true is explicit.",
  schema: ExitWorktreeSchema,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    const entry = currentWorktree(context.sessionId);
    if (!entry) return { content: "No active worktree to exit." };
    try {
      const removalWarning =
        input.action === "remove"
          ? await removeIsolatedWorktree(
              entry,
              input.discardChanges === true || input.discard_changes === true,
            )
          : undefined;
      popWorktree(context.sessionId);
      const enclosing = currentWorktree(context.sessionId);
      if (enclosing) setCwd(context.sessionId, enclosing.path);
      else clearCwd(context.sessionId);
      await context.hooks?.runEvent?.("WorktreeRemove", {
        worktree_path: entry.path,
        removed: input.action === "remove",
      });
      return {
        content: `Exited worktree: ${entry.path}\n${removalWarning ?? (input.action === "remove" ? "Worktree and branch deleted." : "Kept on disk with files and branch.")}`,
      };
    } catch (error) {
      return { content: "", error: String(error) };
    }
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
  // Trusted disk templates (CLAUDE.md decision #2) make the approval-free
  // read-only stance intentional — but resolution can run shell expansion and
  // fork skills spawn a full sub-agent, so concurrent interleaving with
  // mutating tools is NOT safe.
  isReadOnly: true,
  isConcurrencySafe: false,

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
    if (skill.disableModelInvocation)
      return { content: "", error: `Skill ${name} can only be invoked explicitly by the user.` };

    // Review fix ("skill 非白名单 command 形态触发执行无闸门" + "fork 模式
    // 无 shell 扫描"): a PROJECT-scope disk skill whose body carries `!`sh``
    // directives runs repo-controlled shell at RESOLUTION time — and the
    // trigger here is the MODEL, which file content can steer (prompt
    // injection → skill=<planted> → shell, zero gate; the fork path ran the
    // same expansion unscanned). Install-is-trust covers CARRYING shell, not
    // model-triggered EXECUTION. Require explicit approval; fail closed when
    // no approval channel exists (headless). The user's own `/<name>` slash
    // invocation never reaches this tool — that IS the explicit approval.
    if (skill.hasShellDirectives && skill.diskScope === "project") {
      const approved = context.askUser
        ? await context.askUser(
            SkillTool,
            { skill: name, args: input.args },
            `project-scope skill "${name}" executes shell (!\`...\`) from the workspace repo`,
          )
        : false;
      if (!approved) {
        return {
          content: "",
          error:
            `Skill "${name}" is a project-scope template with shell directives; ` +
            `model invocation needs explicit approval (or invoke it yourself as /${name}).`,
        };
      }
    }

    // Resolve the body now (kernel: discovery cheap, loading expensive — the
    // template/shell expansion happens here, at invocation, not at discovery).
    let resolved: string;
    try {
      resolved = await resolveSkillPrompt(skill, {
        args: input.args,
        workspaceRoot: context.workspaceRoot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: "", error: `Skill "${name}" failed to load: ${message}` };
    }

    // context:'fork' → run the body in a sub-agent and return only its final
    // text (kernel §6 context protection). Falls back to inline injection when
    // the loop didn't provide modelConfig (e.g. unit tests calling .call bare).
    if (skill.context === "fork" && context.modelConfig) {
      return runForkSkill(skill, resolved, context);
    }
    activateSkill(context.sessionId, skill);

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

// Import shared cron logic
import {
  getScheduledJob,
  listScheduledJobs,
  MAX_SCHEDULED_JOBS,
  registerScheduledJob,
  removeScheduledJob,
  resetScheduledJobs,
  validateCron,
} from "../extended/cron-shared.js";

// Re-export for backward compatibility
export { getScheduledJob, listScheduledJobs, removeScheduledJob, resetScheduledJobs };

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

  async call(input, context): Promise<ToolResult> {
    const err = validateCron(input.cron);
    if (err) return { content: "", error: err };

    const job = registerScheduledJob({
      cron: input.cron.trim(),
      prompt: input.prompt,
      recurring: input.recurring ?? true,
      durable: input.durable ?? false,
      workspaceRoot: context.workspaceRoot,
      sessionId: context.sessionId,
    });
    if (!job) {
      return {
        content: "",
        error: `Scheduled-job limit reached (${MAX_SCHEDULED_JOBS}). Delete some first.`,
      };
    }

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
  // A bare sleep is a no-op acknowledgment (read-only); a sleep carrying a
  // prompt registers a future user-turn injection — that is a side-effecting
  // write and must go through approval, not the read-only fast path. Called
  // without input in static contexts (listings): answer conservatively.
  isReadOnly: (input?: { prompt?: string }) => !!input && !input.prompt?.trim(),
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const raw = Number(input.delaySeconds);
    if (!Number.isFinite(raw) || raw <= 0) {
      return { content: "", error: "delaySeconds must be a positive number" };
    }
    const delay = Math.min(Math.max(Math.round(raw), 60), 3600);
    if (input.prompt?.trim()) {
      const job = registerScheduledJob({
        cron: `+${delay}`,
        prompt: input.prompt,
        recurring: false,
        durable: false,
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
      });
      if (!job) {
        return {
          content: "",
          error: `Scheduled-job limit reached (${MAX_SCHEDULED_JOBS}). Delete some first.`,
        };
      }
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
// Exports bundle
// ============================================================

export const ORCHESTRATION_TOOLS: Tool[] = [
  EnterWorktreeTool,
  ExitWorktreeTool,
  SkillTool,
  ScheduleCronTool,
  SleepTool,
];
