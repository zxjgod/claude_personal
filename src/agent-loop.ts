// ============================================================
// Agent Loop — The heart of the system (refactored)
// ============================================================
// Core loop orchestration, delegating to specialized modules:
//   - tool-executor.ts: tool call grouping and execution
//   - auto-compact.ts: context summarization
//   - error-recovery.ts: model error handling and retry strategies
// ============================================================

import { autoCompact, latestUserText } from "./auto-compact.js";
import { CollapseStore, prepareCheapLayers } from "./context-pipeline.js";
import {
  handleModelError,
  isContextLengthError,
  isFallbackableModelError,
} from "./error-recovery.js";
import {
  buildContinuationNudge,
  checkTokenBudget,
  createTokenBudgetState,
  DEFAULT_TOKEN_BUDGET,
  recordOutput,
  type TokenBudgetState,
} from "./query/token-budget.js";
import { predictReads, SpeculationCache } from "./speculation.js";
import { StreamingToolExecutor } from "./streaming-tool-executor.js";
import { estimateTokens } from "./token-estimator.js";
import {
  backfillMissingToolResults,
  executeSingleTool,
  executeToolCalls,
} from "./tool-executor.js";
import { startToolSummary } from "./tools/summary.js";
import type {
  AskUserFn,
  LoopEvent,
  LoopOptions,
  Message,
  ModelCaller,
  ModelConfig,
  Terminal,
  TerminalReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolExecutionResult,
} from "./types.js";
import { isInterrupt } from "./utils/cancellation.js";

// Default approver used when the caller (CLI) does not supply one.
const defaultAskUser: AskUserFn = async () => true;

/**
 * Loop-carried state (kernel §3/§9). A single struct rewritten as a whole at
 * each "continue" point rather than nine scattered mutable locals.
 */
interface LoopState {
  turnCount: number;
  totalTokens: number;
  rateLimitRetries: number;
  contextLengthRetries: number;
  transientRetries: number;
  /** Why the previous step handed control back to the loop top. */
  transition: { reason: "start" | "model_retry" | "compact_retry" | "tools_done" };
  /**
   * Token accounting baseline from the last model call (M31, kernel §6).
   */
  usageBaseline?: { promptTokens: number; messageCount: number };
  /**
   * Index into modelConfig.fallbackModels. Monotonically advances as the loop
   * degrades through the fallback chain; 0 = still on the primary model.
   */
  fallbackIndex: number;
  /**
   * Output-token accounting for the turn-output budget (M32, kernel §7).
   */
  budget: TokenBudgetState;
  /**
   * True once a stop hook has injected a blocking error this turn-sequence.
   */
  stopHookActive: boolean;
}

// --- Agent Loop (Async Generator) ---

export async function* agentLoop(
  messages: Message[],
  tools: Tool[],
  callModel: ModelCaller,
  modelConfig: ModelConfig,
  options: LoopOptions,
): AsyncGenerator<LoopEvent, Terminal> {
  const {
    maxTurns = 50,
    autoCompactThreshold = 150_000,
    contextHardLimit = 200_000,
    systemPrompt,
    abortSignal,
    toolContext,
    askUser = defaultAskUser,
    hooks,
    speculation = true,
    turnOutputBudget = 0,
    drainQueuedInput,
  } = options;

  // Build the full ToolContext from caller-provided values.
  const baseContext: ToolContext = {
    workspaceRoot: toolContext?.workspaceRoot ?? process.cwd(),
    sessionId: toolContext?.sessionId ?? "default",
    permissionMode: toolContext?.getPermissionMode?.() ?? toolContext?.permissionMode ?? "default",
    getPermissionMode: toolContext?.getPermissionMode,
    setPermissionMode: toolContext?.setPermissionMode,
    modelConfig: toolContext?.modelConfig ?? modelConfig,
    onSubAgentProgress: toolContext?.onSubAgentProgress,
    askUserQuestion: toolContext?.askUserQuestion,
    permissionClassifier: toolContext?.permissionClassifier,
    askUser: toolContext?.askUser ?? askUser,
    abortSignal,
    getParentMessages: () => messages.slice(),
    parentSystemPrompt: systemPrompt,
    subagentDepth: toolContext?.subagentDepth,
  };

  const MAX_RATE_LIMIT_RETRIES = 3;
  const MAX_CONTEXT_LENGTH_RETRIES = 3;
  const MAX_TRANSIENT_RETRIES = 3;

  let state: LoopState = {
    turnCount: 0,
    totalTokens: 0,
    rateLimitRetries: 0,
    contextLengthRetries: 0,
    transientRetries: 0,
    transition: { reason: "start" },
    budget: createTokenBudgetState(),
    stopHookActive: false,
    fallbackIndex: 0,
  };

  const budgetConfig = { ...DEFAULT_TOKEN_BUDGET, maxOutputTokens: turnOutputBudget };
  const specCache = new SpeculationCache(speculation);
  const readFiles = new Set<string>();
  const collapseStore = new CollapseStore();

  const streamExecutor = new StreamingToolExecutor(speculation, tools, (toolName, input) =>
    executeSingleTool(
      {
        id: `stream-${toolName}-${Date.now()}`,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(input) },
      },
      tools,
      baseContext,
      askUser,
      hooks,
      specCache,
      readFiles,
      abortSignal,
    ),
  );

  const terminal = (reason: TerminalReason, error?: unknown): Terminal => ({
    reason,
    turns: state.turnCount,
    error,
  });

  const prefetchPromise = options.prefetch
    ? options.prefetch(latestUserText(messages)).catch(() => null)
    : null;
  let prefetchInjected = false;
  let readyToolSummary: string | null = null;

  while (state.turnCount < maxTurns) {
    const { turnCount } = state;
    if (abortSignal?.aborted) {
      yield { type: "aborted", reason: abortSignal.reason };
      return terminal(isInterrupt(abortSignal) ? "aborted_interrupt" : "aborted_streaming");
    }

    // === STEP 1: Context preparation pipeline (M31, kernel §6) ===
    const estTokens = (msgs: Message[]): number => estimateContextTokens(msgs, state.usageBaseline);
    const prepared = prepareCheapLayers(messages, {
      estimateTokens: estTokens,
      threshold: autoCompactThreshold,
      store: collapseStore,
    });
    if (prepared.messages !== messages) {
      messages = prepared.messages;
      state = { ...state, usageBaseline: undefined };
    }
    for (const note of prepared.notes) {
      yield { type: "compacted", summary: note };
    }

    if (prepared.needsAutoCompact) {
      yield { type: "compacting" };
      messages = await autoCompact(messages, callModel, modelConfig, abortSignal);
      const newPromptTokens = estimateTokens(messages);
      state = {
        ...state,
        usageBaseline: { promptTokens: newPromptTokens, messageCount: messages.length },
      };
      yield { type: "compacted", summary: "Context compressed" };
    } else if (
      autoCompactThreshold === Number.POSITIVE_INFINITY &&
      estTokens(messages) >= contextHardLimit
    ) {
      const err = new Error(
        `Context exceeds the hard limit (${contextHardLimit} tokens) and auto-compaction is disabled. Run /compact.`,
      );
      yield { type: "error", error: err };
      return terminal("blocking_limit", err);
    }

    // === STEP 2: Call the LLM ===
    yield { type: "thinking" };

    if (prefetchPromise && !prefetchInjected) {
      prefetchInjected = true;
      const attachment = await prefetchPromise;
      if (attachment) {
        messages.push({ role: "system", content: attachment });
        state = { ...state, usageBaseline: undefined };
      }
    }

    if (readyToolSummary) {
      messages.push({ role: "system", content: readyToolSummary });
      readyToolSummary = null;
      state = { ...state, usageBaseline: undefined };
    }

    let textBuffer = "";
    let lastTurnOutput = 0;
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | null = null;
    const windowAtCall = messages.length;
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
              function: { name: event.name, arguments: JSON.stringify(event.input) },
            });
            streamExecutor.add(event.id, event.name, event.input);
            yield { type: "tool_use", id: event.id, name: event.name, input: event.input };
            break;

          case "done": {
            usage = event.usage;
            lastTurnOutput = event.usage.output_tokens;
            const promptTokens = event.usage.input_tokens;
            state = {
              ...state,
              totalTokens: state.totalTokens + usage.input_tokens + usage.output_tokens,
              usageBaseline: { promptTokens, messageCount: windowAtCall },
              budget: recordOutput(state.budget, usage.output_tokens),
            };
            yield { type: "usage", usage: event.usage };
            streamEnded = true;
            break;
          }

          case "error": {
            const recovery = await handleModelError(event.error, {
              rateLimitRetries: state.rateLimitRetries,
              contextLengthRetries: state.contextLengthRetries,
              transientRetries: state.transientRetries,
              maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
              maxContextLengthRetries: MAX_CONTEXT_LENGTH_RETRIES,
              maxTransientRetries: MAX_TRANSIENT_RETRIES,
            });
            if (recovery === "retry") {
              state = { ...state, rateLimitRetries: state.rateLimitRetries + 1 };
              nextAction = "retry";
              streamEnded = true;
              break;
            }
            if (recovery === "retry_transient") {
              state = { ...state, transientRetries: state.transientRetries + 1 };
              nextAction = "retry";
              streamEnded = true;
              break;
            }
            if (recovery === "compact_and_retry") {
              state = { ...state, contextLengthRetries: state.contextLengthRetries + 1 };
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

            // Fallback model chain (Phase 1.2): when the primary model fails with
            // a model-specific error (5xx / 404 / unknown — NOT auth/rate-limit/
            // abort), degrade to the next configured fallback model and retry.
            // Monotonic: each fallback is tried at most once per session.
            const fallbacks = modelConfig.fallbackModels ?? [];
            if (
              recovery === "abort" &&
              state.fallbackIndex < fallbacks.length &&
              isFallbackableModelError(event.error)
            ) {
              const next = fallbacks[state.fallbackIndex]!;
              state = { ...state, fallbackIndex: state.fallbackIndex + 1 };
              modelConfig = { ...modelConfig, model: next };
              yield { type: "compacted", summary: `Switched to fallback model: ${next}` };
              nextAction = "retry";
              streamEnded = true;
              break;
            }

            nextAction = "abort";
            abortError = event.error;
            streamEnded = true;
            break;
          }
        }
        if (streamEnded) break;
      }
    } catch (error) {
      yield { type: "error", error };
      return terminal("model_error", error);
    }

    if (nextAction === "abort") {
      yield { type: "error", error: abortError };
      const reason: TerminalReason = isContextLengthError(abortError)
        ? "prompt_too_long"
        : "model_error";
      return terminal(reason, abortError);
    }
    if (nextAction === "retry") {
      state = { ...state, transition: { reason: "model_retry" } };
      continue;
    }

    // === STEP 3: No tool calls — turn would end here (kernel §8) ===
    if (toolCalls.length === 0) {
      if (textBuffer) {
        messages.push({ role: "assistant", content: textBuffer });
      }

      if (hooks?.runStop) {
        const stop = await hooks.runStop({ messages, stopHookActive: state.stopHookActive });
        if (stop.preventContinuation) {
          yield {
            type: "done",
            finishReason: "end_turn",
            turns: turnCount,
            message: stop.reason ?? "Stop hook prevented continuation.",
            speculation: specCache.isEnabled ? specCache.getStats() : undefined,
          };
          return terminal("stop_hook_prevented");
        }
        if (stop.blockingError) {
          messages.push({ role: "user", content: [{ type: "text", text: stop.blockingError }] });
          state = {
            ...state,
            stopHookActive: true,
            turnCount: turnCount + 1,
            transition: { reason: "model_retry" },
          };
          continue;
        }
      }

      const decision = checkTokenBudget(state.budget, lastTurnOutput, budgetConfig);
      if (decision.shouldContinue) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: buildContinuationNudge(decision.state) }],
        });
        state = {
          ...state,
          budget: decision.state,
          turnCount: turnCount + 1,
          transition: { reason: "model_retry" },
        };
        continue;
      }
      state = { ...state, budget: decision.state };

      if (injectQueuedInput(messages, drainQueuedInput)) {
        state = { ...state, turnCount: turnCount + 1, transition: { reason: "model_retry" } };
        continue;
      }

      yield {
        type: "done",
        finishReason: "end_turn",
        turns: turnCount,
        speculation: specCache.isEnabled ? specCache.getStats() : undefined,
      };
      return terminal("completed");
    }

    // === STEP 4: Add assistant message to history ===
    messages.push({ role: "assistant", content: textBuffer || null, tool_calls: toolCalls });

    // === STEP 5: Execute tool calls ===
    const toolResults: ToolExecutionResult[] = new Array(toolCalls.length);
    try {
      for await (const done of executeToolCalls(
        toolCalls,
        tools,
        baseContext,
        askUser,
        abortSignal,
        hooks,
        specCache,
        readFiles,
        streamExecutor,
      )) {
        toolResults[done.index] = done.result;
        yield { type: "tool_result", id: toolCalls[done.index]!.id, result: done.result };
      }
    } finally {
      // === STEP 6: Add tool results to history ===
      for (let i = 0; i < toolCalls.length; i++) {
        if (!toolResults[i]) {
          toolResults[i] = {
            toolName: toolCalls[i]!.function.name,
            error: "Did not complete",
            formatted: `Error: ${toolCalls[i]!.function.name} did not complete (interrupted before producing a result).`,
            isError: true,
          };
        }
        const r = toolResults[i]!;
        messages.push({
          role: "tool",
          tool_call_id: toolCalls[i]!.id,
          name: toolCalls[i]!.function.name,
          content: r.isError ? `<tool_use_error>${r.formatted}</tool_use_error>` : r.formatted,
        });
      }
      backfillMissingToolResults(messages, toolCalls);
    }

    // 12.2: Speculatively prefetch likely follow-up Reads.
    if (specCache.isEnabled) {
      for (const r of toolResults) {
        if (r.result) {
          specCache.prefetch(predictReads(r.toolName, r.result, {}, readFiles), tools, baseContext);
        }
      }
    }

    // M36: start a fast-model summary of this tool batch.
    if (options.summarizeToolBatch) {
      const summaryPromise = startToolSummary({
        results: toolResults,
        summarize: options.summarizeToolBatch,
      });
      if (summaryPromise) {
        summaryPromise.then((attachment) => {
          if (attachment) readyToolSummary = attachment;
        });
      }
    }

    if (abortSignal?.aborted) {
      yield { type: "tool_results", results: toolResults };
      yield { type: "aborted", reason: abortSignal.reason };
      return terminal(isInterrupt(abortSignal) ? "aborted_interrupt" : "aborted_tools");
    }

    // Tool results may carry images.
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
    injectQueuedInput(messages, drainQueuedInput);

    state = { ...state, turnCount: turnCount + 1, transition: { reason: "tools_done" } };
  }

  // Max turns reached
  yield {
    type: "done",
    finishReason: "max_turns",
    turns: state.turnCount,
    message: "Maximum turns reached. Continue?",
    speculation: specCache.isEnabled ? specCache.getStats() : undefined,
  };
  return terminal("max_turns");
}

// --- Context Token Estimation ---

/**
 * Estimate the prepared context's token count (M31).
 */
function estimateContextTokens(messages: Message[], baseline: LoopState["usageBaseline"]): number {
  if (baseline && messages.length >= baseline.messageCount) {
    const appended = messages.slice(baseline.messageCount);
    return baseline.promptTokens + estimateTokens(appended);
  }
  return estimateTokens(messages);
}

// --- Helper Utilities ---

/**
 * Inject queued type-ahead input as follow-up user messages (M36, kernel §9).
 */
function injectQueuedInput(messages: Message[], drain?: () => string[]): boolean {
  if (!drain) return false;
  const queued = drain();
  if (queued.length === 0) return false;
  for (const text of queued) {
    messages.push({ role: "user", content: [{ type: "text", text }] });
  }
  return true;
}
