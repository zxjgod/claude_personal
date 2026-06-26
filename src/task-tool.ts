// ============================================================
// Task Tool — Sub-agent system for complex multi-step tasks
// ============================================================
// Spawns an independent sub-agent with a configurable tool set and
// isolated context window. Sub-agent types come from the registry
// (src/subagents.ts). Concurrent sub-agents are capped by a semaphore
// so a fan-out of task calls can't exhaust the model's rate limit.
// ============================================================

import type { Tool, ToolResult, Message } from "./types.js";
import { createTool } from "./tool-registry.js";
import { agentLoop } from "./agent-loop.js";
import { createModelCaller } from "./llm-adapter.js";
import {
  getSubagentType,
  listSubagentNames,
  resolveSubagentTools,
  getCoreToolsForSubagents,
} from "./subagents.js";

// --- Constants ---

const SUBAGENT_MAX_TURNS = 10;
const SUBAGENT_COMPACT_THRESHOLD = 50_000;

// Max sub-agents running at once. A turn can request many `task` calls
// (they're concurrency-safe), so without a cap a wide fan-out would hit
// the provider all at once. Override via TASK_MAX_CONCURRENCY.
const MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.TASK_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
})();

// --- Input ---

interface TaskInput {
  description: string;
  prompt: string;
  subagent_name: string;
  [key: string]: unknown;
}

// Core tools for sub-agent resolution come from the subagents registry, which
// the CLI injects once at startup (16.9). This avoids the old cycle where
// task-tool.ts dynamically imported tools.ts (tools.ts → TaskTool → tools.ts).
// A lazy fallback remains inside getCoreToolsForSubagents for standalone use.

// --- Concurrency semaphore ---

let activeCount = 0;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENCY) {
    activeCount++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  activeCount++;
}

function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next();
}

// --- Tool ---

export const TaskTool: Tool = createTool<TaskInput>({
  name: "task",
  description:
    "Launch a sub-agent to handle complex, multi-step tasks autonomously",
  promptDescription:
    "Launch a sub-agent to handle complex, multi-step tasks. " +
    "Provide description (short summary), prompt (detailed instructions), and subagent_name. " +
    `Available sub-agent types: ${listSubagentNames().join(", ")}. ` +
    "code-explorer/code-reviewer are read-only; general can modify files. " +
    "Use this for broad exploration, review, or research where intermediate " +
    "tool results don't need user review. Multiple sub-agents run concurrently " +
    `(capped at ${MAX_CONCURRENCY}).`,
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short (3-5 word) description of the task",
      },
      prompt: {
        type: "string",
        description:
          "The detailed task for the sub-agent to perform. Be specific about what to find or do.",
      },
      subagent_name: {
        type: "string",
        description: "The type of sub-agent to launch.",
        enum: listSubagentNames(),
        default: "code-explorer",
      },
    },
    required: ["description", "prompt", "subagent_name"],
  },
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const description = input.description?.trim();
    const prompt = input.prompt?.trim();
    const subagentName = input.subagent_name || "code-explorer";

    // --- Validation ---

    if (!description) {
      return { content: "", error: "description is required" };
    }
    if (!prompt) {
      return { content: "", error: "prompt is required" };
    }
    const subagentType = getSubagentType(subagentName);
    if (!subagentType) {
      return {
        content: "",
        error: `Unknown subagent type: "${subagentName}". Allowed: ${listSubagentNames().join(", ")}`,
      };
    }
    if (!context.modelConfig) {
      return {
        content: "",
        error:
          "Task tool requires modelConfig in context. The CLI must provide this.",
      };
    }

    // --- Setup sub-agent ---

    const subMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ];

    const subCaller = createModelCaller(context.modelConfig);
    const subSystemPrompt = [
      subagentType.systemPrompt,
      "",
      `Your task: ${description}`,
    ].join("\n");

    // --- Run sub-agent loop (under the concurrency cap) ---

    const startTime = Date.now();
    const outputChunks: string[] = [];
    let toolCallCount = 0;
    let errorMessage: string | undefined;

    await acquireSlot();
    try {
      const coreTools = await getCoreToolsForSubagents();
      const subagentTools = resolveSubagentTools(subagentType, coreTools);
      const loop = agentLoop(
        subMessages,
        subagentTools,
        subCaller,
        context.modelConfig,
        {
          systemPrompt: subSystemPrompt,
          maxTurns: subagentType.maxTurns ?? SUBAGENT_MAX_TURNS,
          autoCompactThreshold: SUBAGENT_COMPACT_THRESHOLD,
          // Run sub-agent tools in the same workspace/session as the parent.
          toolContext: {
            workspaceRoot: context.workspaceRoot,
            sessionId: context.sessionId,
            permissionMode: context.permissionMode,
            modelConfig: context.modelConfig,
            // Forward the parent's interactive approver so the sub-agent's
            // destructive tools (bash/write/edit) still prompt the user,
            // instead of being auto-approved by the loop's default askUser.
            askUser: context.askUser,
          },
          // Also pass askUser at the LoopOptions level — the sub-loop's own
          // permission checks (the ones NOT inside a nested tool) use this.
          askUser: context.askUser,
        },
      );

      for await (const event of loop) {
        switch (event.type) {
          case "text_delta":
            outputChunks.push(event.delta);
            break;
          case "tool_use":
            toolCallCount++;
            context.onSubAgentProgress?.({
              subagentName,
              phase: "tool_use",
              toolName: event.name,
              input: event.input,
            });
            break;
          case "tool_results":
            context.onSubAgentProgress?.({
              subagentName,
              phase: "tool_results",
              results: event.results,
            });
            break;
          case "done":
            context.onSubAgentProgress?.({
              subagentName,
              phase: "done",
            });
            break;
          case "aborted":
            errorMessage = event.reason;
            break;
          case "error":
            errorMessage = String(event.error);
            break;
          default:
            // thinking / usage / compacting — silent
            break;
        }
      }
    } catch (error: any) {
      errorMessage = error.message || String(error);
    } finally {
      releaseSlot();
    }

    const duration = Date.now() - startTime;
    const output = outputChunks.join("").trim();

    if (errorMessage && !output) {
      return {
        content: "",
        error: `Sub-agent failed: ${errorMessage}`,
        metadata: { durationMs: duration },
      };
    }

    const header = [
      `[Sub-agent "${subagentName}" completed]`,
      `Task: ${description}`,
      `Tool calls: ${toolCallCount}`,
      `Duration: ${(duration / 1000).toFixed(1)}s`,
      ``,
      `--- Findings ---`,
      ``,
    ].join("\n");

    return {
      content: header + (output || "(no output)"),
      truncated: false,
      metadata: { durationMs: duration, linesRead: toolCallCount },
    };
  },

  async checkPermissions(_input, _context) {
    // The `task` tool itself just spawns a sub-agent; the user explicitly
    // requested it, so spawning needs no separate prompt. The sub-agent's
    // own tool calls (bash/write/edit) are permission-checked inside the
    // sub-loop, where the parent's askUser is forwarded so destructive
    // actions still surface for confirmation.
    return { allowed: true };
  },
});
