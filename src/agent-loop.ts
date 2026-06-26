// ============================================================
// Agent Loop — The heart of the system
// ============================================================

import type {
  AskUserFn,
  HookRunner,
  LoopEvent,
  LoopOptions,
  Message,
  ModelCaller,
  ModelConfig,
  Tool,
  ToolCall,
  ToolContext,
  ToolExecutionResult,
} from "./types.js";
import { checkPermission } from "./permissions.js";
import { snipContext } from "./context-snip.js";
import { SpeculationCache, predictReads } from "./speculation.js";

// Default approver used when the caller (CLI) does not supply one — e.g.
// sub-agents and tests. Preserves backward-compatible "allow" behavior;
// plan-mode blocking is still enforced inside checkPermission().
const defaultAskUser: AskUserFn = async () => true;

// Sentinel thrown so a pending Promise.race can be interrupted by an abort
// without relying on every individual tool promise rejecting. Caught locally
// in the parallel-tool path; never surfaces to callers.
class AbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

// --- Agent Loop (Async Generator) ---

export async function* agentLoop(
  messages: Message[],
  tools: Tool[],
  callModel: ModelCaller,
  modelConfig: ModelConfig,
  options: LoopOptions,
): AsyncGenerator<LoopEvent> {
  const {
    maxTurns = 50,
    autoCompactThreshold = 150_000,
    systemPrompt,
    abortSignal,
    toolContext,
    askUser = defaultAskUser,
    hooks,
    // M15.2: speculation is ON by default. Safety profile — prefetch only runs
    // read-only + concurrency-safe tools, cache entries are single-use, a miss
    // is free (the real tool just runs), and it runs in the background. Disable
    // via the CLI/TUI caller (--no-speculation / CCR_SPECULATION=0).
    speculation = true,
  } = options;

  // Build the full ToolContext from caller-provided values, falling back to
  // sensible defaults. This replaces the previously hardcoded context.
  const baseContext: ToolContext = {
    workspaceRoot: toolContext?.workspaceRoot ?? process.cwd(),
    sessionId: toolContext?.sessionId ?? "default",
    permissionMode: toolContext?.permissionMode ?? "default",
    modelConfig: toolContext?.modelConfig ?? modelConfig,
    onSubAgentProgress: toolContext?.onSubAgentProgress,
    askUserQuestion: toolContext?.askUserQuestion,
    // M15.3: thread the LLM permission classifier (if the CLI enabled it) so
    // flagged dangerous tool calls get a model-assessed risk hint / block.
    permissionClassifier: toolContext?.permissionClassifier,
    // Thread the parent's approver into the tool context so sub-agent tools
    // (Task/Team) can forward it into their own sub-loops. Otherwise sub-agents
    // would auto-approve everything via defaultAskUser — a safety gap.
    askUser: toolContext?.askUser ?? askUser,
    // Thread the turn's AbortSignal so tools (Bash/Grep/LSP) can cancel their
    // subprocesses on Ctrl+C, not just the LLM stream.
    abortSignal,
  };

  let turnCount = 0;
  let totalTokens = 0;

  // Per-loop retry counters for recoverable model errors. Without a cap, a
  // sustained 429 or an un-fixable context_length error loops forever
  // (re-calling the model with the same oversized messages each turn).
  let rateLimitRetries = 0;
  let contextLengthRetries = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;
  const MAX_CONTEXT_LENGTH_RETRIES = 3;

  // Speculative prefetch cache (12.2). Lives for this loop run; serves at most
  // one cached result per tool+input. No-op unless `speculation` is enabled.
  const specCache = new SpeculationCache(speculation);

  // M15.2: Paths already Read this session. predictReads drops these before
  // ranking, since the model won't re-Read a file it has already opened — so
  // prefetching them is pure waste. Populated below as real Reads resolve
  // (hit or miss), and threaded into predictReads.
  const readFiles = new Set<string>();

  while (turnCount < maxTurns) {
    // Check for abort
    if (abortSignal?.aborted) {
      yield { type: "aborted", reason: abortSignal.reason };
      return;
    }

    // === STEP 1: Check if compaction is needed ===
    // 12.1: First try a cheap importance-aware snip of bulky old tool results.
    // This often reclaims enough headroom to skip full LLM summarization.
    if (estimateTokens(messages) > autoCompactThreshold) {
      const snip = snipContext(messages);
      if (snip.snippedCount > 0) {
        messages = snip.messages;
        yield {
          type: "compacted",
          summary: `Snipped ${snip.snippedCount} large tool result(s) (~${Math.ceil(snip.charsSaved / 4)} tokens)`,
        };
      }
      // If still over threshold after snipping, fall back to full compaction.
      if (estimateTokens(messages) > autoCompactThreshold) {
        yield { type: "compacting" };
        messages = await autoCompact(messages, callModel, modelConfig, abortSignal);
        yield { type: "compacted", summary: "Context compressed" };
      }
    }

    // === STEP 2: Call the LLM ===
    yield { type: "thinking" };

    let textBuffer = "";
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | null = null;
    // What to do after the model stream ends. "retry" re-runs the while loop
    // with the same (or compacted) messages; "abort" terminates the generator.
    // Set by the error branch below; defaults to "proceed" to run tool calls.
    let nextAction: "proceed" | "retry" | "abort" = "proceed";
    let abortError: unknown = null;
    let streamEnded = false;

    try {
      for await (const event of callModel(
        messages,
        tools,
        systemPrompt,
        modelConfig,
        abortSignal,
      )) {
        switch (event.type) {
          case "text_delta":
            textBuffer += event.delta;
            yield { type: "text_delta", delta: event.delta };
            break;

          case "tool_use":
            toolCalls.push({
              id: event.id,
              type: "function",
              function: {
                name: event.name,
                arguments: JSON.stringify(event.input),
              },
            });
            yield {
              type: "tool_use",
              id: event.id,
              name: event.name,
              input: event.input,
            };
            break;

          case "done":
            usage = event.usage;
            totalTokens += usage.input_tokens + usage.output_tokens;
            yield { type: "usage", usage: event.usage };
            streamEnded = true;
            break;

          case "error":
            // Handle recoverable errors
            const recovery = await handleModelError(
              event.error,
              {
                rateLimitRetries,
                contextLengthRetries,
                maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
                maxContextLengthRetries: MAX_CONTEXT_LENGTH_RETRIES,
              },
            );
            if (recovery === "retry") {
              rateLimitRetries++;
              nextAction = "retry";
              streamEnded = true;
              break;
            }
            if (recovery === "compact_and_retry") {
              contextLengthRetries++;
              // Context too long: compress once before retrying, otherwise the
              // next turn re-sends the same oversized messages and re-triggers
              // the same error forever.
              try {
                messages = await autoCompact(messages, callModel, modelConfig, abortSignal);
                yield {
                  type: "compacted",
                  summary: "Context compressed after context_length error",
                };
                nextAction = "retry";
                streamEnded = true;
              } catch {
                nextAction = "abort";
                abortError = event.error;
                streamEnded = true;
              }
              break;
            }
            // "abort"
            nextAction = "abort";
            abortError = event.error;
            streamEnded = true;
            break;
        }
        // Once the stream has reached a terminal event (done / error), stop
        // consuming further events — the error-recovery decision is final for
        // this turn and must drive the loop's next action.
        if (streamEnded) break;
      }
    } catch (error) {
      yield { type: "error", error };
      return;
    }

    if (nextAction === "abort") {
      yield { type: "error", error: abortError };
      return;
    }
    if (nextAction === "retry") {
      continue; // restart the while loop: re-call the model
    }

    // === STEP 3: If no tool calls, we're done ===
    if (toolCalls.length === 0) {
      // Save the assistant's text response to message history
      if (textBuffer) {
        messages.push({
          role: "assistant",
          content: textBuffer,
        });
      }
      yield {
        type: "done",
        finishReason: "end_turn",
        turns: turnCount,
        speculation: specCache.isEnabled ? specCache.getStats() : undefined,
      };
      return;
    }

    // === STEP 4: Add assistant message to history ===
    messages.push({
      role: "assistant",
      content: textBuffer || null,
      tool_calls: toolCalls,
    });

    // === STEP 5: Execute tool calls (parallel for safe ones) ===
    // Stream each result the moment it finishes (so the UI shows reads as
    // they happen, not all at once after the whole batch completes), while
    // still collecting them in call order for the history + batch event.
    const toolResults: ToolExecutionResult[] = new Array(toolCalls.length);
    for await (const done of executeToolCalls(
      toolCalls,
      tools,
      baseContext,
      askUser,
      abortSignal,
      hooks,
      specCache,
      readFiles,
    )) {
      toolResults[done.index] = done.result;
      yield {
        type: "tool_result",
        id: toolCalls[done.index]!.id,
        result: done.result,
      };
    }

    // 12.2: Speculatively prefetch likely follow-up Reads from any search
    // (grep/glob) results, so they're warm if the model asks next turn.
    if (specCache.isEnabled) {
      for (const r of toolResults) {
        if (r.result) {
          specCache.prefetch(
            predictReads(r.toolName, r.result, {}, readFiles),
            tools,
            baseContext,
          );
        }
      }
    }

    // === STEP 6: Add tool results to history ===
    for (let i = 0; i < toolCalls.length; i++) {
      messages.push({
        role: "tool",
        tool_call_id: toolCalls[i].id,
        name: toolCalls[i].function.name,
        content: toolResults[i].formatted,
      });
    }

    // Tool results may carry images (e.g. Read on a PNG/PDF). Both providers
    // accept images only in user content, so inject them as a follow-up user
    // message right after the tool results that produced them.
    const images = toolResults.flatMap((r) => r.result?.images ?? []);
    if (images.length > 0) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from the tool result above:" },
          ...images,
        ],
      });
    }

    yield { type: "tool_results", results: toolResults };

    turnCount++;
  }

  // Max turns reached
  yield {
    type: "done",
    finishReason: "max_turns",
    turns: turnCount,
    message: "Maximum turns reached. Continue?",
    speculation: specCache.isEnabled ? specCache.getStats() : undefined,
  };
}

// --- Tool Call Execution ---

interface IndexedResult {
  index: number;
  result: ToolExecutionResult;
}

/**
 * Execute tool calls, yielding each {index, result} the instant it finishes.
 * Parallel-safe calls all start at once and surface in completion order;
 * non-safe calls run serially afterwards. The caller reassembles call order
 * from `index`, so streaming early results never scrambles the history.
 */
async function* executeToolCalls(
  toolCalls: ToolCall[],
  tools: Tool[],
  context: ToolContext,
  askUser: AskUserFn,
  abortSignal?: AbortSignal,
  hooks?: HookRunner,
  specCache?: SpeculationCache,
  readFiles?: Set<string>,
): AsyncGenerator<IndexedResult> {
  // Separate into parallel-safe and serial groups, preserving each call's
  // original index so the caller can restore call order.
  const parallelCalls: Array<{ call: ToolCall; index: number }> = [];
  const serialCalls: Array<{ call: ToolCall; index: number }> = [];

  toolCalls.forEach((call, index) => {
    const tool = tools.find((t) => t.name === call.function.name);
    if (tool && tool.isConcurrencySafe()) {
      parallelCalls.push({ call, index });
    } else {
      serialCalls.push({ call, index });
    }
  });

  // Run all parallel-safe calls at once; yield each as it settles (not in
  // launch order) so fast reads appear immediately.
  if (parallelCalls.length > 0) {
    const pending = new Map<number, Promise<IndexedResult>>();
    for (const { call, index } of parallelCalls) {
      pending.set(
        index,
        executeSingleTool(call, tools, context, askUser, hooks, specCache, readFiles, abortSignal).then(
          (result) => ({ index, result }),
        ),
      );
    }
    while (pending.size > 0) {
      // Race the pending tools against the abort signal. Without this, a
      // single tool whose promise never settles (e.g. a hung subprocess
      // holding a pipe open) would block Promise.race forever — the abort
      // check below could never run, Ctrl+C would be ignored, and the whole
      // batch (plus the agent loop) would deadlock.
      let settled: IndexedResult;
      if (abortSignal) {
        const abortPromise = new Promise<IndexedResult>((_, reject) => {
          if (abortSignal.aborted) {
            reject(new AbortError("Aborted"));
          } else {
            abortSignal.addEventListener(
              "abort",
              () => reject(new AbortError("Aborted")),
              { once: true },
            );
          }
        });
        try {
          settled = await Promise.race([
            Promise.race(pending.values()),
            abortPromise,
          ]);
        } catch {
          // Aborted: surface aborted results for every still-pending call so
          // the caller gets a complete result array and can move on.
          for (const { call, index } of parallelCalls) {
            if (pending.has(index)) {
              pending.delete(index);
              yield {
                index,
                result: {
                  toolName: call.function.name,
                  error: "Aborted",
                  formatted: `Aborted before executing ${call.function.name}.`,
                },
              };
            }
          }
          return;
        }
      } else {
        settled = await Promise.race(pending.values());
      }
      pending.delete(settled.index);
      yield settled;
      // If the user aborted, short-circuit remaining parallel calls so we
      // don't keep launching subprocesses / LSP work after Ctrl+C.
      if (abortSignal?.aborted) {
        for (const { call, index } of parallelCalls) {
          if (pending.has(index)) {
            pending.delete(index);
            yield {
              index,
              result: {
                toolName: call.function.name,
                error: "Aborted",
                formatted: `Aborted before executing ${call.function.name}.`,
              },
            };
          }
        }
      }
    }
  }

  // Execute serial calls one at a time, in order.
  for (const { call, index } of serialCalls) {
    if (abortSignal?.aborted) {
      yield {
        index,
        result: {
          toolName: call.function.name,
          error: "Aborted",
          formatted: `Aborted before executing ${call.function.name}.`,
        },
      };
      continue;
    }
    const result = await executeSingleTool(call, tools, context, askUser, hooks, specCache, readFiles, abortSignal);
    yield { index, result };
  }
}

async function executeSingleTool(
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
      };
    }

    // === PreToolUse hook (before permission + side effects) ===
    if (hooks) {
      const pre = await hooks.runPre({ toolName: tool.name, input });
      if (pre.block) {
        const reason = pre.reason ?? "blocked by hook";
        return {
          toolName: tool.name,
          error: reason,
          formatted: `工具被 hook 拦截: ${reason}`,
        };
      }
      if (pre.input) input = pre.input;
    }

    // === Permission check (before any side effect) ===
    // Two layers:
    //   (a) tool-level checkPermissions() — the tool's own hard policy. If it
    //       returns {allowed:false} the call is refused outright (no prompt),
    //       e.g. BashTool/WriteTool refuse dangerous patterns before the user
    //       is even asked. Previously this method was dead code — tools
    //       declared it but executeSingleTool never called it.
    //   (b) system-level checkPermission() — mode + dangerous-pattern +
    //       interactive askUser flow.
    const toolLevel = await tool.checkPermissions(input, context);
    if (!toolLevel.allowed) {
      const reason = toolLevel.reason ?? `denied by ${tool.name} policy`;
      return {
        toolName: tool.name,
        error: reason,
        formatted: `权限被拒绝: ${reason}`,
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
        formatted: `权限被拒绝: ${reason}`,
      };
    }

    const startTime = Date.now();
    // 12.2: Serve from the speculation cache if we prefetched this exact call.
    // The prefetch already ran the (read-only) tool, so this is a pure hit.
    let result =
      (await specCache?.take(tool.name, input)) ??
      (await tool.call(input, context));
    const duration = Date.now() - startTime;

    // M15.2: Record this path as read so predictReads won't re-prefetch it.
    // Tracked whether or not it was a spec hit — the model has the content now.
    if (readFiles && tool.name.toLowerCase() === "read" && typeof input.filePath === "string") {
      readFiles.add(input.filePath);
    }

    // === PostToolUse hook (may rewrite the result) ===
    if (hooks) {
      const post = await hooks.runPost({ toolName: tool.name, input, result });
      if (post.result) result = post.result;
    }

    return {
      toolName: tool.name,
      result,
      formatted: tool.formatResult({
        ...result,
        metadata: { ...result.metadata, durationMs: duration },
      }),
      durationMs: duration,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      toolName: tool.name,
      error: message,
      formatted: `Error executing ${tool.name}: ${message}`,
    };
  }
}

// --- Token Estimation (Simple Heuristic) ---

function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        for (const block of msg.content) {
          if (block.type === "text") total += block.text.length;
        }
        break;
      case "assistant":
        if (msg.content) total += msg.content.length;
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            total += tc.function.arguments.length + tc.function.name.length;
          }
        }
        break;
      case "tool":
        total += msg.content.length;
        break;
      case "system":
        total += msg.content.length;
        break;
    }
  }
  // Rough estimate: ~1 token per 4 characters
  return Math.ceil(total / 4);
}

// --- Auto-Compaction ---

/**
 * Choose a split point so the retained tail never begins with an orphan tool
 * result. Starts at `messages.length - tailSize` and walks the boundary
 * earlier while the first tail message is a tool result (whose originating
 * assistant message would otherwise be stranded in the summarized half).
 * Returns an index into `messages` (the start of the tail).
 */
function findSafeSplitIndex(messages: Message[], tailSize: number): number {
  let split = Math.max(0, messages.length - tailSize);
  while (split > 0 && messages[split]?.role === "tool") {
    split--;
  }
  return split;
}

export async function autoCompact(
  messages: Message[],
  callModel: ModelCaller,
  modelConfig: ModelConfig,
  abortSignal?: AbortSignal,
): Promise<Message[]> {
  const TAIL_SIZE = 20;
  // Find a safe split point. Slicing at a fixed offset can leave the tail
  // starting with an orphan tool result whose assistant (with tool_calls)
  // landed in oldMessages — the provider rejects that ("tool message must
  // follow tool_calls"). Move the boundary earlier until the tail no longer
  // begins with a tool message.
  const splitIndex = findSafeSplitIndex(messages, TAIL_SIZE);

  const oldMessages = messages.slice(0, splitIndex);
  const tailMessages = messages.slice(splitIndex);

  if (oldMessages.length === 0) return messages;

  // Summarize old messages
  const summaryPrompt = `Summarize the conversation so far. Include:
1. What the user asked for (the main task)
2. Key decisions made
3. Files that were modified (with paths)
4. What still needs to be done
5. Any important context for continuing the work

Be concise but complete. This summary will replace the old messages
so the conversation can continue with a fresh context window.`;

  const summaryMessages: Message[] = [
    ...oldMessages,
    { role: "user", content: [{ type: "text", text: summaryPrompt }] },
  ];

  // Call model without tools for summarization
  const chunks: string[] = [];
  for await (const event of callModel(
    summaryMessages,
    [],
    "You are a helpful assistant that summarizes conversations.",
    modelConfig,
    abortSignal,
  )) {
    if (event.type === "text_delta") {
      chunks.push(event.delta);
    }
  }
  const summary = chunks.join("");

  // Rebuild: system summary + tail
  return [
    {
      role: "system",
      content: `[CONVERSATION SUMMARY]\n${summary}`,
    },
    ...tailMessages,
  ];
}

// --- Error Recovery ---

/**
 * Decision returned by handleModelError.
 * - "retry": wait then re-call the model with the same messages (429).
 * - "compact_and_retry": compress context once, then re-call the model
 *   (context_length exceeded). The loop performs the actual compression so it
 *   can stream a `compacted` event and fall back to `abort` on failure.
 * - "abort": unrecoverable (auth, unknown, or retry budget exhausted).
 */
type ModelErrorRecovery = "retry" | "compact_and_retry" | "abort";

interface RecoveryState {
  rateLimitRetries: number;
  contextLengthRetries: number;
  maxRateLimitRetries: number;
  maxContextLengthRetries: number;
}

async function handleModelError(
  error: unknown,
  state: RecoveryState,
): Promise<ModelErrorRecovery> {
  const err = error as any;

  // Rate limit → wait and retry (bounded). A sustained 429 without a cap
  // would loop forever; once the budget is exhausted we abort so the user
  // sees the error instead of an infinite spinner.
  if (err?.status === 429) {
    if (state.rateLimitRetries >= state.maxRateLimitRetries) {
      return "abort";
    }
    const delay = err?.retryAfter || 5000;
    await sleep(delay);
    return "retry";
  }

  // Context too long → compact once and retry (bounded). Returning plain
  // "retry" here (as it did before) re-sends identical oversized messages and
  // re-triggers the same error every turn → infinite loop.
  if (
    err?.status === 400 &&
    (err?.message?.includes("context_length") ||
      err?.message?.includes("maximum context"))
  ) {
    if (state.contextLengthRetries >= state.maxContextLengthRetries) {
      return "abort";
    }
    return "compact_and_retry";
  }

  // Auth error → abort
  if (err?.status === 401 || err?.status === 403) {
    return "abort";
  }

  // User-initiated abort (Ctrl+C / turn abort) → never retry. The adapters
  // surface an "Aborted" error; retrying would silently ignore the user's
  // intent to stop the turn.
  const name = err?.name as string | undefined;
  const msg = (err?.message as string | undefined) ?? "";
  if (name === "AbortError" || msg === "Aborted" || msg.includes("aborted")) {
    return "abort";
  }

  // Transient timeout / connection error → retry once (bounded by the
  // rate-limit budget, since timeouts behave like rate limits from the
  // loop's perspective: transient, worth one more attempt).
  if (
    name === "TimeoutError" ||
    name === "ETIMEDOUT" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNRESET" ||
    err?.code === "ECONNREFUSED" ||
    msg.includes("timeout") ||
    msg.includes("socket hang up")
  ) {
    if (state.rateLimitRetries >= state.maxRateLimitRetries) {
      return "abort";
    }
    await sleep(2000);
    return "retry";
  }

  // Unknown error → abort
  return "abort";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
