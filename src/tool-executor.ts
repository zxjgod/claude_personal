// ============================================================
// Tool Executor — parallel/serial execution with concurrency safety (M29)
// ============================================================
// Handles tool call grouping, early execution, and result formatting.
// ============================================================

import { checkPermission } from "./permissions.js";
import type { SpeculationCache } from "./speculation.js";
import type { StreamingToolExecutor } from "./streaming-tool-executor.js";
import { InputValidationError } from "./tools/registry.js";
import type {
  AskUserFn,
  HookRunner,
  Message,
  Tool,
  ToolCall,
  ToolContext,
  ToolExecutionResult,
} from "./types.js";
import { all, maxToolConcurrency } from "./utils/generators.js";

// Sentinel thrown so a pending Promise.race can be interrupted by an abort
// without relying on every individual tool promise rejecting.
export class AbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

// --- Types for tool execution ---

export interface IndexedResult {
  index: number;
  result: ToolExecutionResult;
}

export type IndexedCall = { call: ToolCall; index: number };
export type Batch = { safe: boolean; calls: IndexedCall[] };

// --- Concurrency Safety ---

/**
 * Decide whether a tool call is safe to run concurrently (kernel §6, M29).
 * Data-driven: parses the call's JSON arguments and asks the tool's
 * `isConcurrencySafe(input)`. CONSERVATIVE — a missing tool, unparseable
 * arguments, or a predicate that throws all resolve to `false` (run serially),
 * since the cost of wrongly parallelizing a mutating call is a race condition.
 */
export function callIsConcurrencySafe(call: ToolCall, tools: Tool[]): boolean {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) return false;
  try {
    const input = JSON.parse(call.function.arguments);
    return tool.isConcurrencySafe(input) === true;
  } catch {
    return false;
  }
}

/**
 * Greedily group calls into ordered batches (kernel §6): a run of consecutive
 * concurrency-safe calls forms one parallel batch; any unsafe call forms its
 * own serial batch. Order is preserved across batches, so `[read, write, read]`
 * becomes three batches `[read] [write] [read]` — the second read does NOT jump
 * ahead of the write.
 */
export function partitionToolCalls(toolCalls: ToolCall[], tools: Tool[]): Batch[] {
  const batches: Batch[] = [];
  toolCalls.forEach((call, index) => {
    const safe = callIsConcurrencySafe(call, tools);
    const last = batches.at(-1);
    if (safe && last?.safe) {
      last.calls.push({ call, index });
    } else {
      batches.push({ safe, calls: [{ call, index }] });
    }
  });
  return batches;
}

/** Synthesize an "aborted" result for a call that never ran. */
export function abortedResult(call: ToolCall): ToolExecutionResult {
  return {
    toolName: call.function.name,
    error: "Aborted",
    formatted: `Aborted before executing ${call.function.name}.`,
    isError: true,
  };
}

// --- Single Tool Execution ---

/**
 * Execute a single tool call with full permission checks, input validation,
 * and result formatting.
 */
export async function executeSingleTool(
  toolCall: ToolCall,
  tools: Tool[],
  context: ToolContext,
  askUser: AskUserFn,
  hooks?: HookRunner,
  specCache?: SpeculationCache,
  readFiles?: Set<string>,
  abortSignal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const tool = tools.find((t) => t.name === toolCall.function.name);

  if (!tool) {
    return {
      toolName: toolCall.function.name,
      error: `Unknown tool: ${toolCall.function.name}`,
      formatted: `Error: Tool "${toolCall.function.name}" is not available.`,
      isError: true,
    };
  }

  // Honor an abort that arrived while we were queued behind other calls.
  if (abortSignal?.aborted) {
    return {
      toolName: tool.name,
      error: "Aborted",
      formatted: `Aborted before executing ${tool.name}.`,
    };
  }

  try {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(toolCall.function.arguments);
    } catch {
      return {
        toolName: tool.name,
        error: "Invalid JSON arguments",
        formatted: `Error: Failed to parse arguments for ${tool.name}`,
        isError: true,
      };
    }

    // === Input validation (M28) — semantic layer, before any side effect ===
    if (tool.validateInput) {
      try {
        input = tool.validateInput(input) as Record<string, unknown>;
      } catch (err) {
        const message =
          err instanceof InputValidationError
            ? err.message
            : `Invalid arguments: ${err instanceof Error ? err.message : String(err)}`;
        return {
          toolName: tool.name,
          error: message,
          formatted: message,
          isError: true,
        };
      }
    }

    // === PreToolUse hook (before permission + side effects) ===
    if (hooks) {
      const pre = await hooks.runPre({ toolName: tool.name, input });
      if (pre.block) {
        const reason = pre.reason ?? "blocked by hook";
        return {
          toolName: tool.name,
          error: reason,
          formatted: `Tool blocked by hook: ${reason}`,
          isError: true,
        };
      }
      if (pre.input) input = pre.input;
    }

    // === Permission check (before any side effect) ===
    // Two layers:
    //   (a) tool-level checkPermissions() — the tool's own hard policy.
    //   (b) system-level checkPermission() — mode + dangerous-pattern +
    //       interactive askUser flow.
    context.permissionMode = context.getPermissionMode?.() ?? context.permissionMode;
    const toolLevel = await tool.checkPermissions(input, context);
    if (!toolLevel.allowed) {
      const reason = toolLevel.reason ?? `denied by ${tool.name} policy`;
      return {
        toolName: tool.name,
        error: reason,
        formatted: `Permission denied: ${reason}`,
        isError: true,
      };
    }
    const permission = await checkPermission(tool, input, context, {
      askUser,
      classifier: context.permissionClassifier,
    });
    if (!permission.allowed) {
      const reason = permission.reason ?? "denied by permission policy";
      return {
        toolName: tool.name,
        error: reason,
        formatted: `Permission denied: ${reason}`,
        isError: true,
      };
    }

    const startTime = Date.now();
    // 12.2: Serve from the speculation cache if we prefetched this exact call.
    let result = (await specCache?.take(tool.name, input)) ?? (await tool.call(input, context));
    const duration = Date.now() - startTime;

    // M15.2: Record this path as read so predictReads won't re-prefetch it.
    if (readFiles && tool.name.toLowerCase() === "read" && typeof input.filePath === "string") {
      readFiles.add(input.filePath);
    }

    // === PostToolUse hook (may rewrite the result) ===
    if (hooks) {
      const post = await hooks.runPost({ toolName: tool.name, input, result });
      if (post.result) result = post.result;
    }

    const formatted = tool.formatResult({
      ...result,
      metadata: { ...result.metadata, durationMs: duration },
    });
    // P0-1 Fix: do NOT truncate or spill here. The full formatted result is stored
    // in message history. Truncation for the API call is handled by the adapters.
    return {
      toolName: tool.name,
      result,
      isError: result.error != null,
      formatted,
      durationMs: duration,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      toolName: tool.name,
      error: message,
      formatted: `Error executing ${tool.name}: ${message}`,
      isError: true,
    };
  }
}

// --- Batched Tool Execution ---

/**
 * Execute tool calls in ordered batches (kernel §6, M29). Concurrency-safe runs
 * parallelize (bounded by maxToolConcurrency, default 10) and surface in
 * completion order; everything else runs serially.
 */
export async function* executeToolCalls(
  toolCalls: ToolCall[],
  tools: Tool[],
  context: ToolContext,
  askUser: AskUserFn,
  abortSignal?: AbortSignal,
  hooks?: HookRunner,
  specCache?: SpeculationCache,
  readFiles?: Set<string>,
  streamExecutor?: StreamingToolExecutor,
): AsyncGenerator<IndexedResult> {
  const batches = partitionToolCalls(toolCalls, tools);

  const runOne = async (call: ToolCall): Promise<ToolExecutionResult> => {
    // M36: if this exact call was early-started during streaming, serve the
    // finished result instead of running it again.
    const early = await streamExecutor?.take(call.id);
    if (early) return early;
    return executeSingleTool(
      call,
      tools,
      context,
      askUser,
      hooks,
      specCache,
      readFiles,
      abortSignal,
    );
  };

  for (const batch of batches) {
    // If we've already been aborted, surface aborted results for the whole batch.
    if (abortSignal?.aborted) {
      for (const { call, index } of batch.calls) {
        yield { index, result: abortedResult(call) };
      }
      continue;
    }

    if (!batch.safe || batch.calls.length === 1) {
      // Serial batch: one at a time, in order.
      for (const { call, index } of batch.calls) {
        if (abortSignal?.aborted) {
          yield { index, result: abortedResult(call) };
          continue;
        }
        yield { index, result: await runOne(call) };
      }
      continue;
    }

    // Parallel batch: merge per-call one-shot generators with bounded concurrency.
    const gens = batch.calls.map(({ call, index }) =>
      (async function* (): AsyncGenerator<IndexedResult> {
        yield { index, result: await runOne(call) };
      })(),
    );
    const merged = all(gens, maxToolConcurrency());

    const emitted = new Set<number>();
    let wasAborted = false;

    // A single abort promise + listener for the whole batch (P2 Fix). The
    // previous code created one abortPromise + abort listener per race
    // iteration and never removed them, leaking a listener per tool call.
    let abortPromise: Promise<never> | null = null;
    let rejectAbort: ((e: Error) => void) | null = null;
    const onAbort = () => rejectAbort?.(new AbortError("Aborted"));
    if (abortSignal) {
      abortPromise = new Promise<never>((_, reject) => {
        rejectAbort = reject;
        if (abortSignal.aborted) reject(new AbortError("Aborted"));
        else abortSignal.addEventListener("abort", onAbort, { once: true });
      });
    }

    try {
      while (true) {
        // Race the merged batch against the abort signal.
        let step: IteratorResult<IndexedResult>;
        if (abortPromise) {
          try {
            step = await Promise.race([merged.next(), abortPromise]);
          } catch {
            wasAborted = true;
            break;
          }
        } else {
          step = await merged.next();
        }
        if (step.done) break;
        emitted.add(step.value.index);
        yield step.value;
        if (abortSignal?.aborted) {
          wasAborted = true;
          break;
        }
      }
    } finally {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    }
    if (wasAborted) {
      // Surface aborted results for any call in this batch that never emitted.
      for (const { call, index } of batch.calls) {
        if (!emitted.has(index)) yield { index, result: abortedResult(call) };
      }
    }
  }
}

// --- Helper Utilities ---

/**
 * Synthesize a paired tool_result for any tool_use that never produced one
 * (kernel §7: every tool_use MUST have a matching tool_result). Called
 * on the throw/crash path where executeToolCalls bailed mid-batch.
 */
export function backfillMissingToolResults(messages: Message[], toolCalls: ToolCall[]): void {
  const satisfied = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") satisfied.add(m.tool_call_id);
  }
  for (const call of toolCalls) {
    if (!satisfied.has(call.id)) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: `Error: ${call.function.name} did not complete (interrupted before producing a result).`,
      });
    }
  }
}
