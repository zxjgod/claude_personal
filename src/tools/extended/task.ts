// ============================================================
// Task Tool — Sub-agent system for complex multi-step tasks
// ============================================================
// Spawns an independent sub-agent with a configurable tool set and
// isolated context window. Sub-agent types come from the registry
// (src/subagents.ts). Concurrent sub-agents are capped by a semaphore
// so a fan-out of task calls can't exhaust the model's rate limit.
// ============================================================

import { z } from "zod";
import { agentLoop } from "../../agent-loop.js";
import { loadAgentMemoryPrompt } from "../../agent-memory.js";
import { createModelCaller } from "../../llm-adapter.js";
import {
  buildSubagentSystemPrompt,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  getSubagentType,
  listSubagentNames,
  listSubagentSelectionHints,
  resolveSubagentTools,
  setAgentMemoryLoader,
} from "../../subagents.js";
import type { Message, Tool, ToolResult } from "../../types.js";
import { CancellationScope } from "../../utils/cancellation.js";
import { createSubAgentApprover } from "../../utils/subagent-security.js";
import { buildTool } from "../registry.js";

// Register the agent-memory loader once (M35). Done here rather than in
// subagents.ts to keep that module free of a static node:fs dependency.
setAgentMemoryLoader(loadAgentMemoryPrompt);

// --- Constants ---

const SUBAGENT_MAX_TURNS = 10;
const SUBAGENT_COMPACT_THRESHOLD = 50_000;
// Fork nesting cap: a fork inherits the full core tool set (including the Task
// tool itself), so without a limit fork → fork → … would recurse unbounded.
// The main agent (depth 0) may fork once (depth 1); a fork may not fork again.
const MAX_FORK_DEPTH = 1;

// Max sub-agents running at once. A turn can request many `task` calls
// (they're concurrency-safe), so without a cap a wide fan-out would hit
// the provider all at once. Override via TASK_MAX_CONCURRENCY.
const MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.TASK_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
})();

// --- Schema ---

const TaskSchema = z.strictObject({
  description: z.string().min(1).describe("A short (3-5 word) description of the task"),
  prompt: z
    .string()
    .min(1)
    .describe("The detailed task for the sub-agent to perform. Be specific."),
  subagent_name: z
    .string()
    .optional()
    .describe(
      `Type of sub-agent to launch. Omit to FORK the current agent (inherits conversation context). ` +
        `Available types: ${listSubagentNames().join(", ")}`,
    ),
});
type TaskInput = z.infer<typeof TaskSchema>;

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

// Build the promptDescription dynamically to include current subagent types
function buildTaskPromptDescription(): string {
  const hints = listSubagentSelectionHints()
    .map((h) => `  - ${h.name}: ${h.whenToUse}`)
    .join("\n");

  return (
    "Launch a sub-agent to handle complex, multi-step tasks. " +
    "Parameters: description (required, short summary), prompt (required, detailed instructions), " +
    "subagent_name (optional, omit to fork current agent). " +
    "OMIT subagent_name to FORK: inherits conversation context and prompt cache, returns final report only. " +
    "Or pick a typed sub-agent:\n" +
    hints +
    "\n" +
    `Multiple sub-agents run concurrently (max ${MAX_CONCURRENCY}). ` +
    "Only the final report is returned — intermediate tool output is not shown."
  );
}

export const TaskTool: Tool = buildTool({
  name: "task",
  description: "Launch a sub-agent to handle complex, multi-step tasks autonomously",
  promptDescription: buildTaskPromptDescription(),
  schema: TaskSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  searchHint: "task subagent fork parallel agent",
  aliases: ["subagent", "spawn", "agent"],

  async call(input, context): Promise<ToolResult> {
    // --- Setup sub-agent ---

    const requestedName = input.subagent_name?.trim();

    // Fork mode (kernel §6 mechanism A): subagent_name omitted AND the loop
    // exposed the parent's context. The fork inherits the parent's message
    // history and reuses its system prompt verbatim — same prompt + same model
    // so it shares the prompt cache. When fork context is absent (tests, no CLI
    // wiring), we fall back to the default typed sub-agent rather than erroring.
    const canFork = !!context.getParentMessages && !!context.parentSystemPrompt;
    const isFork = !requestedName && canFork;

    // Guard against unbounded fork recursion (fork → fork → …).
    const depth = context.subagentDepth ?? 0;
    if (isFork && depth >= MAX_FORK_DEPTH) {
      return {
        content: "",
        error:
          `Fork nesting limit reached (depth ${depth}). ` +
          `A forked agent cannot fork again — use a typed sub-agent (subagent_name) instead.`,
      };
    }

    const subagentName = isFork ? "fork" : requestedName || "code-explorer";
    const subagentType = isFork ? undefined : getSubagentType(subagentName);
    if (!isFork && !subagentType) {
      return {
        content: "",
        error: `Unknown subagent type: "${subagentName}". Allowed: ${listSubagentNames().join(", ")}`,
      };
    }
    if (!context.modelConfig) {
      return {
        content: "",
        error: "Task tool requires modelConfig in context. The CLI must provide this.",
      };
    }

    // Fork seeds the sub-loop with a copy of the parent's history (inherit
    // context) then appends the fork task; a typed sub-agent starts clean.
    const seed: Message[] = isFork ? context.getParentMessages!() : [];
    const seedLen = seed.length;
    const subMessages: Message[] = [
      ...seed,
      { role: "user", content: [{ type: "text", text: input.prompt }] },
    ];

    const subCaller = createModelCaller(context.modelConfig);
    // Fork reuses the parent prompt verbatim (shared cache); a typed sub-agent
    // gets its own type-specific prompt + env footnote.
    const subSystemPrompt = isFork
      ? context.parentSystemPrompt!
      : buildSubagentSystemPrompt(
          subagentType!,
          [subagentType!.systemPrompt, "", `Your task: ${input.description}`].join("\n"),
          { workspaceRoot: context.workspaceRoot },
        );

    // M35: fork a child cancellation scope from the parent's signal so a parent
    // Ctrl+C / abort cascades into this sub-agent's loop. Previously the loop
    // was spawned with no signal, so an aborted parent left sub-agents running.
    const scope = new CancellationScope(context.abortSignal);

    // --- Run sub-agent loop (under the concurrency cap) ---

    const startTime = Date.now();
    let toolCallCount = 0;
    let errorMessage: string | undefined;

    await acquireSlot();
    try {
      const coreTools = await getCoreToolsForSubagents();
      // Fork inherits the full core tool set (it IS the current agent); a typed
      // sub-agent is restricted to its declared tools.
      const subagentTools = isFork ? coreTools : resolveSubagentTools(subagentType!, coreTools);

      // P0 Security Fix: Create restricted approver for sub-agent
      // Dangerous tools (bash/write/edit) require parent approval
      const subApprover = createSubAgentApprover(context.askUser, true);

      const loop = agentLoop(subMessages, subagentTools, subCaller, context.modelConfig, {
        systemPrompt: subSystemPrompt,
        maxTurns: subagentType?.maxTurns ?? SUBAGENT_MAX_TURNS,
        autoCompactThreshold: SUBAGENT_COMPACT_THRESHOLD,
        abortSignal: scope.signal,
        // Run sub-agent tools in the same workspace/session as the parent.
        toolContext: {
          workspaceRoot: context.workspaceRoot,
          sessionId: context.sessionId,
          permissionMode: context.permissionMode,
          modelConfig: context.modelConfig,
          // Use restricted approver to prevent sub-agents from bypassing permissions
          askUser: subApprover,
          // Thread the nesting depth so a fork-of-a-fork is capped.
          subagentDepth: depth + 1,
        },
        // Also pass restricted askUser at the LoopOptions level
        askUser: subApprover,
      });

      for await (const event of loop) {
        switch (event.type) {
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
      scope.dispose();
    }

    const duration = Date.now() - startTime;
    // Context protection (kernel §4): return ONLY the sub-agent's final
    // assistant text — never its accumulated multi-turn narration or raw tool
    // output. For a fork, the sub-loop's messages start with a copy of the
    // PARENT's history (seedLen messages); we slice past it so extraction can
    // only see the fork's own turns and never echoes a parent assistant message.
    const own = isFork ? subMessages.slice(seedLen) : subMessages;
    const output = extractLastAssistantText(own);

    if (errorMessage && !output) {
      return {
        content: "",
        error: `${isFork ? "Fork" : "Sub-agent"} failed: ${errorMessage}`,
        metadata: { durationMs: duration },
      };
    }

    const header = [
      isFork ? `[Fork of current agent completed]` : `[Sub-agent "${subagentName}" completed]`,
      `Task: ${input.description}`,
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

  async checkPermissions(_input, context) {
    // Plan mode: never spawn sub-agents (they run their own loop).
    if (context.permissionMode === "plan") {
      return {
        allowed: false,
        reason: "Plan mode: task tool is disabled.",
      };
    }
    return { allowed: true };
  },
});
