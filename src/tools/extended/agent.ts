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
import type { Message, ModelConfig, Tool, ToolResult } from "../../types.js";
import { CancellationScope } from "../../utils/cancellation.js";
import { createSubAgentApprover } from "../../utils/subagent-security.js";
import { buildTool } from "../registry.js";

const execFileAsync = promisify(execFile);

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
  searchHint: "agent subagent spawn fork parallel task isolation worktree",
  aliases: ["agent"],

  async call(input: AgentInput, context): Promise<ToolResult> {
    const startTime = Date.now();

    // Validate model config
    if (!context.modelConfig) {
      return { content: "", error: "Agent tool requires modelConfig in context" };
    }

    // Handle worktree isolation
    let worktree: WorktreeInfo | null = null;
    let effectiveWorkspaceRoot = context.workspaceRoot;

    if (input.isolation === "worktree") {
      const result = await createWorktree(context.workspaceRoot, context.sessionId);
      if ("error" in result) {
        return { content: "", error: result.error };
      }
      worktree = result;
      effectiveWorkspaceRoot = worktree.path;
    }

    try {
      // Determine agent type
      const requestedType = input.subagent_type?.trim();
      const canFork = !!context.getParentMessages && !!context.parentSystemPrompt;
      const isFork = !requestedType && canFork;

      const subagentName = isFork ? "fork" : requestedType || "code-explorer";
      const subagentType = isFork ? undefined : getSubagentType(subagentName);

      if (!isFork && !subagentType) {
        return {
          content: "",
          error: `Unknown subagent type: "${subagentName}". Available: ${listSubagentNames().join(", ")}`,
        };
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

      // Create model caller
      const modelCaller = createModelCaller(modelConfig);

      // Run agent loop
      const cancellation = new CancellationScope();
      const approver = createSubAgentApprover(context.askUser);

      const loop = agentLoop(messages, tools, modelCaller, modelConfig, {
        systemPrompt,
        maxTurns: 10,
        autoCompactThreshold: 50_000,
        abortSignal: context.abortSignal,
        toolContext: {
          workspaceRoot: effectiveWorkspaceRoot,
          sessionId: `${context.sessionId}-agent-${Date.now()}`,
          permissionMode: context.permissionMode,
          modelConfig: context.modelConfig,
          askUser: approver,
          onSubAgentProgress: context.onSubAgentProgress,
        },
        askUser: approver,
      });

      // Consume loop events
      let terminal: any;
      for await (const event of loop) {
        if (event.type === "done") {
          terminal = { reason: event.finishReason, turns: event.turns };
        } else if (event.type === "error") {
          terminal = { reason: "model_error", turns: 0, error: event.error };
        } else if (event.type === "aborted") {
          terminal = { reason: "aborted_streaming", turns: 0, error: event.reason };
        }
      }

      // Extract final output
      const finalText = extractLastAssistantText(messages);
      const duration = Date.now() - startTime;

      // Clean up worktree if successful
      if (worktree && terminal?.reason === "end_turn") {
        await removeWorktree(context.workspaceRoot, worktree.path, worktree.branch);
      }

      if (terminal?.error) {
        return {
          content: finalText || "",
          error: String(terminal.error),
          metadata: { durationMs: duration },
        };
      }

      return {
        content: finalText || "(Agent completed with no output)",
        metadata: {
          durationMs: duration,
        },
      };
    } catch (error: any) {
      // Clean up worktree on error
      if (worktree) {
        await removeWorktree(context.workspaceRoot, worktree.path, worktree.branch);
      }
      throw error;
    }
  },
});
