// ============================================================
// Agent Tool — Enhanced sub-agent spawning with full API compatibility
// ============================================================
// Provides the official Claude Code "Agent" tool API as an enhanced wrapper
// around the existing Task tool, with added support for isolation modes,
// effort levels, and schema-based structured output.
// ============================================================

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { agentLoop } from "../../agent-loop.js";
import { createModelCaller } from "../../llm-adapter.js";
import {
  buildSubagentSystemPrompt,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  getSubagentType,
  listSubagentNames,
  listSubagentSelectionHints,
  resolveSubagentTools,
} from "../../subagents.js";
import type { Message, Tool, ToolResult } from "../../types.js";
import { Semaphore } from "../../utils/semaphore.js";
import { createSubAgentApprover } from "../../utils/subagent-security.js";
import { createJob, settleJob } from "../job-store.js";
import { buildTool } from "../registry.js";
import { collectPartialReport } from "./subagent-report.js";

const execFileAsync = promisify(execFile);

// ============================================================
// Guards — fork depth + concurrency
// ============================================================

// Fork nesting cap: a fork inherits the full core tool set (including the
// Agent tool itself), so without a limit fork → fork → … recurses unbounded.
// Main agent (depth 0) forks at depth 1; that fork may delegate once more
// (depth 2); a depth-2 agent cannot fork again.
const MAX_FORK_DEPTH = 2;

// Max concurrent Agent loops. Deliberately a SEPARATE semaphore from Task's:
// a fan-out mixing Task and Agent calls should not starve either kind.
// Override via AGENT_MAX_CONCURRENCY.
const MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.AGENT_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
})();

const agentSlots = new Semaphore(MAX_CONCURRENCY, "Agent");

// ============================================================
// Worktree isolation helpers
// ============================================================

interface WorktreeInfo {
  path: string;
  branch: string;
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

function randomWorktreeName(): string {
  const t = process.hrtime.bigint().toString(16).slice(-8);
  return `agent-wt-${t}`;
}

async function createWorktree(
  workspaceRoot: string,
  sessionId: string,
): Promise<WorktreeInfo | { error: string }> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], workspaceRoot);
  if (inside?.trim() !== "true") {
    return { error: "Not a git repository — cannot create worktree for isolation." };
  }

  // Branch from current HEAD
  const branch = randomWorktreeName();
  const wtPath = path.join(workspaceRoot, ".claude", "worktrees", sessionId, branch);

  const out = await git(["worktree", "add", "-b", branch, wtPath, "HEAD"], workspaceRoot, 15_000);
  if (out === null) {
    return { error: `git worktree add failed for branch "${branch}"` };
  }

  return { path: wtPath, branch };
}

async function removeWorktree(
  workspaceRoot: string,
  wtPath: string,
  branch: string,
): Promise<void> {
  await git(["worktree", "remove", "--force", wtPath], workspaceRoot, 15_000);
  await git(["branch", "-D", branch], workspaceRoot, 8000);
}

// ============================================================
// Agent Tool
// ============================================================

const AgentSchema = z.strictObject({
  prompt: z.string().min(1).describe("The task for the agent to perform"),
  description: z.string().optional().describe("A short (3-5 word) description of the task"),
  subagent_type: z
    .string()
    .optional()
    .describe(
      `Type of agent to launch. Omit to fork the current agent. Available: ${listSubagentNames().join(", ")}`,
    ),
  model: z.string().optional().describe("Model override for this agent"),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Reasoning effort level for this agent"),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe("Run in isolated git worktree (expensive, use only for parallel mutations)"),
  run_in_background: z
    .boolean()
    .optional()
    .describe("Run agent in background, return immediately with task ID"),
});

type AgentInput = z.infer<typeof AgentSchema>;

function buildAgentPromptDescription(): string {
  const hints = listSubagentSelectionHints()
    .map((h) => `  - ${h.name}: ${h.whenToUse}`)
    .join("\n");

  return (
    "Launch a sub-agent to handle complex tasks. Each agent has its own context and tools.\n" +
    "Parameters:\n" +
    "  - prompt (required): detailed task instructions\n" +
    "  - description (optional): short summary shown in UI\n" +
    "  - subagent_type (optional): agent type, omit to fork current agent\n" +
    "  - model (optional): override model for this agent\n" +
    "  - effort (optional): reasoning effort (low/medium/high/xhigh/max)\n" +
    "  - isolation (optional): 'worktree' for git worktree isolation (expensive)\n" +
    "  - run_in_background (optional): return immediately, agent runs async\n\n" +
    "Available agent types:\n" +
    hints +
    "\n\nOmit subagent_type to FORK: inherits conversation context and prompt cache."
  );
}

export const AgentTool: Tool = buildTool({
  name: "Agent",
  description: "Launch a sub-agent to handle complex, multi-step tasks autonomously",
  promptDescription: buildAgentPromptDescription(),
  schema: AgentSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  timeoutMs: 15 * 60 * 1000,
  searchHint: "agent subagent spawn fork parallel task isolation worktree",
  aliases: ["agent"],

  async call(input: AgentInput, context): Promise<ToolResult> {
    const startTime = Date.now();

    // Validate model config
    if (!context.modelConfig) {
      return { content: "", error: "Agent tool requires modelConfig in context" };
    }

    // Guard against unbounded fork recursion (fork → fork → …). Computed from
    // context alone so the cheap rejection happens before any slot or worktree
    // is created.
    const canFork = !!context.getParentMessages && !!context.parentSystemPrompt;
    const isFork = !input.subagent_type?.trim() && canFork;
    const forkDepth = context.subagentDepth ?? 0;
    if (isFork && forkDepth >= MAX_FORK_DEPTH) {
      return {
        content: "",
        error:
          `Fork nesting limit reached (depth ${forkDepth}). ` +
          `Use a typed sub-agent (subagent_type) instead of forking again.`,
      };
    }

    // F3: background mode. This call returns immediately with a job handle;
    // the work re-enters this same tool synchronously minus the flag, so
    // slots, approvals, worktree cleanup and abort cascading all reuse the
    // one foreground code path. The job stores the final report in stdout;
    // settleJob pushes the M41 completion notification (no polling needed).
    if (input.run_in_background) {
      // An already-aborted parent signal never fires "abort" again — starting
      // the job anyway would run it to completion, unreachable by the
      // cascade. Refuse before creating any job state.
      if (context.abortSignal?.aborted) {
        return { content: "", error: "Session aborted; background agent not started." };
      }
      const { run_in_background: _bg, ...foregroundInput } = input;
      const job = createJob(context.sessionId, {
        kind: "agent",
        command: input.description || input.prompt.slice(0, 80),
        description: input.description,
      });
      const controller = new AbortController();
      const onParentAbort = () => controller.abort();
      context.abortSignal?.addEventListener("abort", onParentAbort, { once: true });
      // Self-settling kill: aborting cascades into the inner run, whose own
      // settle would be a no-op (idempotent) — settling here means `killed`
      // wins even if the inner run takes a moment to unwind.
      job.kill = () => {
        controller.abort();
        settleJob(job, "killed", null);
      };
      void (async () => {
        try {
          const result = await AgentTool.call(foregroundInput, {
            ...context,
            abortSignal: controller.signal,
          });
          job.stdout = result.content ?? "";
          if (result.error) job.stderr = result.error;
          settleJob(job, result.error ? "error" : "done", result.error ? null : 0);
        } catch (error) {
          job.stderr = error instanceof Error ? error.message : String(error);
          settleJob(job, "error", null);
        } finally {
          context.abortSignal?.removeEventListener("abort", onParentAbort);
        }
      })();
      return {
        content:
          `Background agent started (${job.id}). A completion notification will arrive when it ` +
          `finishes; use job_output (wait: true) to retrieve the report, or job_kill to stop it.`,
        metadata: { jobId: job.id, summary: `Background agent ${job.id} started` },
      };
    }

    // Resolve the agent type FIRST — before any resource (slot, worktree) is
    // acquired — so this validation error's early return cannot leak them.
    // (canFork/isFork were computed above.)
    const requestedType = input.subagent_type?.trim();
    const subagentName = isFork ? "fork" : requestedType || "code-explorer";
    const subagentType = isFork ? undefined : getSubagentType(subagentName);

    if (!isFork && !subagentType) {
      return {
        content: "",
        error: `Unknown subagent type: "${subagentName}". Available: ${listSubagentNames().join(", ")}`,
      };
    }

    // Worktree isolation — created AFTER the slot guard below. Creating it
    // first would orphan a fresh worktree+branch on the nested-agent
    // rejection path, whose early return bypasses the catch-block cleanup.
    let worktree: WorktreeInfo | null = null;
    let effectiveWorkspaceRoot = context.workspaceRoot;

    let slotAcquired = false;
    try {
      // Concurrency guard. Top-level agents QUEUE for a slot — a fan-out of
      // Agent calls is the normal use. NESTED agents must never queue: their
      // parent already holds a slot and is waiting on this result, so parking
      // here under full load would deadlock the whole batch.
      if (forkDepth === 0) {
        await agentSlots.acquire(context.abortSignal);
        slotAcquired = true;
      } else if (agentSlots.tryAcquire()) {
        slotAcquired = true;
      } else {
        return {
          content: "",
          error:
            `Too many concurrent agents (${agentSlots.active}/${MAX_CONCURRENCY}). ` +
            `A nested agent cannot queue behind its own parent — finish or narrow the fan-out first.`,
        };
      }

      if (input.isolation === "worktree") {
        const result = await createWorktree(context.workspaceRoot, context.sessionId);
        if ("error" in result) {
          return { content: "", error: result.error };
        }
        worktree = result;
        effectiveWorkspaceRoot = worktree.path;
      }

      // Build model config with overrides
      let modelConfig = context.modelConfig;
      if (input.model || input.effort) {
        modelConfig = {
          ...modelConfig,
          ...(input.model && { model: input.model }),
          ...(input.effort && { effort: input.effort }),
        };
      }

      // Get available tools
      const availableTools = await getCoreToolsForSubagents();

      // Build system prompt
      let systemPrompt: string;
      let initialMessages: Message[];
      let tools: Tool[];

      if (isFork) {
        systemPrompt = context.parentSystemPrompt!;
        initialMessages = context.getParentMessages!();
        tools = availableTools; // Fork gets all available tools
      } else {
        systemPrompt = buildSubagentSystemPrompt(
          subagentType!,
          input.description || "Sub-agent task",
        );
        initialMessages = [];
        tools = resolveSubagentTools(subagentType!, availableTools);
      }

      // Add user prompt
      const messages: Message[] = [
        ...initialMessages,
        {
          role: "user",
          content: [{ type: "text", text: input.prompt }],
        },
      ];

      // Mark the inherited context by IDENTITY, not index: autoCompact splices
      // this array in place, so a `slice(initialMessages.length)` boundary
      // drifts after compaction and a completed fork reads as "no final report".
      const inherited = new Set<Message>(initialMessages);

      // Create model caller
      const modelCaller = createModelCaller(modelConfig);

      // Run agent loop
      const approver = createSubAgentApprover(context.askUser);

      const loop = agentLoop(messages, tools, modelCaller, modelConfig, {
        systemPrompt,
        applyEffortInstruction: !isFork,
        maxTurns: subagentType?.maxTurns ?? 20,
        autoCompactThreshold: 50_000,
        abortSignal: context.abortSignal,
        toolContext: {
          workspaceRoot: effectiveWorkspaceRoot,
          sessionId: `${context.sessionId}-agent-${Date.now()}`,
          permissionMode: context.permissionMode,
          modelConfig: context.modelConfig,
          askUser: approver,
          onSubAgentProgress: context.onSubAgentProgress,
          hooks: context.hooks,
          // Thread the nesting depth so a fork-of-a-fork is capped.
          subagentDepth: forkDepth + 1,
        },
        askUser: approver,
      });

      // Consume loop events
      let terminal: { reason: string; turns: number; error?: unknown } | undefined;
      for await (const event of loop) {
        if (event.type === "tool_use") {
          context.onSubAgentProgress?.({
            subagentName,
            phase: "tool_use",
            toolName: event.name,
            input: event.input,
          });
        } else if (event.type === "tool_results") {
          context.onSubAgentProgress?.({
            subagentName,
            phase: "tool_results",
            results: event.results,
          });
        }
        if (event.type === "done") {
          terminal = { reason: event.finishReason, turns: event.turns };
        } else if (event.type === "error") {
          terminal = { reason: "model_error", turns: 0, error: event.error };
        } else if (event.type === "aborted") {
          terminal = { reason: "aborted_streaming", turns: 0, error: event.reason };
        }
      }

      const partialReport =
        terminal?.reason === "max_turns"
          ? await collectPartialReport(
              messages,
              modelCaller,
              modelConfig,
              systemPrompt,
              context.abortSignal,
            )
          : "";
      context.onSubAgentProgress?.({
        subagentName,
        phase: "done",
        reason: context.abortSignal?.aborted ? "aborted" : (terminal?.reason ?? "model_error"),
      });
      await context.hooks
        ?.runEvent?.("SubagentStop", {
          subagent_name: subagentName,
          reason: context.abortSignal?.aborted ? "aborted" : (terminal?.reason ?? "model_error"),
        })
        .catch(() => {});

      // Extract final output — the last assistant message the sub-agent itself
      // produced. Compaction keeps surviving messages by reference, so identity
      // filtering still sees the fork's own turns and never echoes a parent
      // assistant message that happened to survive in the tail.
      const finalText = extractLastAssistantText(messages.filter((m) => !inherited.has(m)));
      const duration = Date.now() - startTime;

      // Clean up worktree if successful
      if (worktree && terminal?.reason === "end_turn") {
        await removeWorktree(context.workspaceRoot, worktree.path, worktree.branch);
      }

      if (terminal?.reason === "max_turns" && !context.abortSignal?.aborted) {
        // The bounded handoff call can come back empty (timeout, refusal, or
        // the model tried a tool); the sub-agent's own final text is the
        // next-best report. Either way the result stays labeled incomplete —
        // hitting the turn budget is never reported as a completed task.
        const report = partialReport || finalText;
        if (report) {
          return {
            content: `[Agent partial report — turn budget reached; task incomplete]\n${report}`,
            metadata: { durationMs: duration, incomplete: true },
          };
        }
      }
      if (terminal?.reason !== "end_turn" || !finalText) {
        return {
          content: finalText || "",
          error: `Agent incomplete: ${terminal?.error || terminal?.reason || "no terminal event"}${!finalText ? "; no final report" : ""}`,
          metadata: { durationMs: duration },
        };
      }

      return {
        content: finalText || "(Agent completed with no output)",
        metadata: {
          durationMs: duration,
        },
      };
    } catch (error) {
      // Clean up worktree on error
      if (worktree) {
        await removeWorktree(context.workspaceRoot, worktree.path, worktree.branch);
      }
      throw error;
    } finally {
      if (slotAcquired) agentSlots.release();
    }
  },
  formatResult: (result) =>
    result.error
      ? `Error: ${result.error}${result.content ? `\nPartial output (not a completed report):\n${result.content}` : ""}`
      : result.content,
});
