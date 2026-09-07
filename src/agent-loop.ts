// ============================================================
// Agent Loop — The heart of the system (refactored)
// ============================================================
// Core loop orchestration, delegating to specialized modules:
//   - tool-executor.ts: tool call grouping and execution
//   - auto-compact.ts: context summarization
//   - error-recovery.ts: model error handling and retry strategies
// ============================================================

import { autoCompact, latestUserText } from "./auto-compact.js";
import { beginUserTurn } from "./checkpoint.js";
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
import { getEffortStrategy, withEffortInstruction } from "./tui/effort.js";
import type {
  AskUserFn,
  AssistantMessage,
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
 * M41: consecutive turn extensions driven only by background completion
 * notifications. 10 completions in a row without any user input is already
 * pathological (each costs a full model call); beyond that the notifications
 * stay queued and are delivered with the next user turn instead.
 */
const MAX_NOTIFICATION_CONTINUATIONS = 10;

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
  /**
   * M41: consecutive turn continuations driven solely by background
   * completion notifications. Capped so a background job that (directly or
   * transitively) restarts itself cannot bounce the loop forever.
   */
  notificationContinuations: number;
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
    // A main task must not be silently cut short by an arbitrary loop count.
    // Callers that need a safety ceiling can still pass a finite maxTurns.
    maxTurns = Number.POSITIVE_INFINITY,
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
    drainNotifications,
    applyEffortInstruction = true,
  } = options;
  const effort = getEffortStrategy(modelConfig.options);
  const effectiveSystemPrompt = applyEffortInstruction
    ? withEffortInstruction(systemPrompt, modelConfig.options)
    : systemPrompt;
  const effectiveSpeculation = speculation && effort.speculation;

  // Keep the caller-owned array identity stable. The CLI autosaves this array
  // while the loop runs; replacing it after compaction would leave persistence
  // pointing at the pre-compaction history forever.
  const replaceMessages = (next: Message[]): void => {
    if (next !== messages) messages.splice(0, messages.length, ...next);
  };

  // Provider SDKs can throw before yielding their first event (HTTP 429/5xx,
  // stream setup failures). Normalize those throws into the same error event
  // path used by adapters that report failures mid-stream.
  const safeCallModel: ModelCaller = async function* (...args) {
    try {
      yield* callModel(...args);
    } catch (error) {
      yield {
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  // P0-3: every SYNTHETIC user-turn injection below (stop-hook errors, length
  // continuations, tool-result images, queued input, notifications) opens a
  // checkpoint boundary and tags its message, so rewind maps message →
  // boundary 1:1. No-op when the caller passed no sessionId (tests).
  const openTurnBoundary = (msg: Message): void => {
    const sid = toolContext?.sessionId;
    if (sid) beginUserTurn(sid, msg);
  };

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
    parentSystemPrompt: effectiveSystemPrompt,
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
    notificationContinuations: 0,
    fallbackIndex: 0,
  };

  const budgetConfig = { ...DEFAULT_TOKEN_BUDGET, maxOutputTokens: turnOutputBudget };
  const specCache = new SpeculationCache(effectiveSpeculation);
  const readFiles = new Set<string>();
  const collapseStore = new CollapseStore();

  const streamExecutor = new StreamingToolExecutor(effectiveSpeculation, tools, (toolName, input) =>
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
      replaceMessages(prepared.messages);
      state = { ...state, usageBaseline: undefined };
    }
    for (const note of prepared.notes) {
      yield { type: "compacted", summary: note };
    }

    if (prepared.needsAutoCompact) {
      yield { type: "compacting" };
      try {
        const messagesBefore = messages.length;
        replaceMessages(await autoCompact(messages, safeCallModel, modelConfig, abortSignal));
        yield {
          type: "compacted",
          summary: "Context compressed",
          messages: Math.max(0, messagesBefore - messages.length),
        };
        // (fallthrough keeps the original state/baseline logic below)
        const newPromptTokens = estimateTokens(messages);
        state = {
          ...state,
          usageBaseline: { promptTokens: newPromptTokens, messageCount: messages.length },
        };
      } catch (e) {
        // Compaction failure must NOT kill the session or proceed with a
        // half-destroyed history. Keep the original messages and continue: the
        // next model call either still fits (the threshold is conservative) or
        // fails with a context-length error, which routes through the
        // compact_and_retry recovery path below.
        yield { type: "error", error: e };
      }
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
    // Signed thinking blocks from the model, captured at `done` and stored on
    // the assistant message for verbatim passback (see anthropic-adapter.ts).
    let thinkingBlocks: AssistantMessage["thinking"];
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | null = null;
    const windowAtCall = messages.length;
    let nextAction: "proceed" | "retry" | "abort" = "proceed";
    let abortError: unknown = null;
    let streamEnded = false;
    let modelFinishReason = "stop";

    try {
      for await (const event of safeCallModel(
        messages,
        tools,
        effectiveSystemPrompt,
        modelConfig,
        abortSignal,
      )) {
        switch (event.type) {
          case "text_delta":
            textBuffer += event.delta;
            yield { type: "text_delta", delta: event.delta };
            break;

          case "thinking":
            // Live reasoning content → UI display only. The signed blocks for
            // history arrive on `done` (signature is final-only).
            if (event.delta) yield { type: "thinking_delta", delta: event.delta };
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
            modelFinishReason = event.finish_reason;
            thinkingBlocks = event.thinking;
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
            const recovery = await handleModelError(
              event.error,
              {
                rateLimitRetries: state.rateLimitRetries,
                contextLengthRetries: state.contextLengthRetries,
                transientRetries: state.transientRetries,
                maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
                maxContextLengthRetries: MAX_CONTEXT_LENGTH_RETRIES,
                maxTransientRetries: MAX_TRANSIENT_RETRIES,
              },
              (notice) => {
                // P0-4: surface the pending backoff to the UI before sleeping.
                options.onModelRetry?.({
                  kind: notice.kind,
                  delayMs: notice.delayMs,
                  attempt:
                    notice.kind === "rate_limit"
                      ? state.rateLimitRetries + 1
                      : state.transientRetries + 1,
                  max:
                    notice.kind === "rate_limit" ? MAX_RATE_LIMIT_RETRIES : MAX_TRANSIENT_RETRIES,
                });
              },
            );
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
                const messagesBefore = messages.length;
                replaceMessages(
                  await autoCompact(messages, safeCallModel, modelConfig, abortSignal),
                );
                yield {
                  type: "compacted",
                  summary: "Context compressed after context_length error",
                  messages: Math.max(0, messagesBefore - messages.length),
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
      // A thinking-only turn (no text, no tools) must still persist its signed
      // thinking blocks — the history would otherwise silently drop them.
      if (textBuffer || thinkingBlocks?.length) {
        messages.push({
          role: "assistant",
          content: textBuffer,
          ...(thinkingBlocks?.length ? { thinking: thinkingBlocks } : {}),
        });
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
          const stopMsg: Message = {
            role: "user",
            content: [{ type: "text", text: stop.blockingError }],
          };
          openTurnBoundary(stopMsg);
          messages.push(stopMsg);
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

      // M40: truncation recovery — the provider cut the output off
      // (finish_reason === "length"). The turn isn't genuinely complete; take
      // the accumulated text as valid progress and nudge the loop to continue,
      // rather than silently ending on a half answer.
      //
      // Deliberately INDEPENDENT of `decision.shouldContinue` (which is
      // "disabled" by default — maxOutputTokens is 0 unless the caller opts
      // into a turn-output budget). There is NO separate continuation cap: a
      // long task that needs many continuations to finish must be allowed to
      // run them all. The `maxTurns` loop bound is the backstop that guarantees
      // a provider which never stops truncating still cannot loop forever —
      // truncation continuations consume `turnCount` like any other turn, so the
      // loop always exits and reports `max_turns` (not "completed").
      if (modelFinishReason === "length") {
        const nudgeMsg: Message = {
          role: "user",
          content: [{ type: "text", text: buildContinuationNudge(state.budget) }],
        };
        openTurnBoundary(nudgeMsg);
        messages.push(nudgeMsg);
        state = {
          ...state,
          turnCount: turnCount + 1,
          transition: { reason: "model_retry" },
        };
        continue;
      }

      // M41: deliver pending background completion notifications before the
      // turn ends. A notification-driven continuation extends the turn (the
      // model can act on the completion right away) but is budgeted — a
      // background job that keeps restarting itself must not bounce the loop
      // indefinitely. A real queued user message resets the budget.
      if (
        injectNotifications(
          messages,
          drainNotifications,
          state,
          MAX_NOTIFICATION_CONTINUATIONS,
          openTurnBoundary,
        )
      ) {
        state = {
          ...state,
          notificationContinuations: state.notificationContinuations + 1,
          turnCount: turnCount + 1,
          transition: { reason: "model_retry" },
        };
        continue;
      }

      if (await injectQueuedInput(messages, drainQueuedInput, openTurnBoundary)) {
        state = {
          ...state,
          notificationContinuations: 0,
          turnCount: turnCount + 1,
          transition: { reason: "model_retry" },
        };
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
    // The thinking blocks MUST ride along here: with interleaved thinking the
    // API 400s the next request if the tool_use turn lost its thinking block.
    messages.push({
      role: "assistant",
      content: textBuffer || null,
      tool_calls: toolCalls,
      ...(thinkingBlocks?.length ? { thinking: thinkingBlocks } : {}),
    });

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
        effort.toolConcurrency,
      )) {
        toolResults[done.index] = done.result;
        yield { type: "tool_result", id: toolCalls[done.index]!.id, result: done.result };
      }
    } catch (error) {
      // Normalize executor/stream failures into tool results so one rejected
      // batch cannot tear down the async generator or strand tool_use entries.
      const message = error instanceof Error ? error.message : String(error);
      for (let i = 0; i < toolCalls.length; i++) {
        if (!toolResults[i]) {
          toolResults[i] = {
            toolName: toolCalls[i]!.function.name,
            error: message,
            formatted: `Error executing ${toolCalls[i]!.function.name}: ${message}`,
            isError: true,
          };
        }
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
      const imageMsg: Message = {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from the tool result above:" },
          ...images,
        ],
      };
      openTurnBoundary(imageMsg);
      messages.push(imageMsg);
    }

    yield { type: "tool_results", results: toolResults };
    await injectQueuedInput(messages, drainQueuedInput, openTurnBoundary);
    // M41: merge any background completions that landed while the tools ran
    // into history now — the next model call sees them alongside the tool
    // results (mirrors the reference: notification rides the next user-side
    // message, so the model never polls for what already finished).
    injectNotifications(messages, drainNotifications, state, Number.POSITIVE_INFINITY);

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
 * Each message opens a checkpoint boundary (P0-3) via the optional tag hook.
 * Async because the TUI's drain executes queued `!cmd` shell lines at the
 * injection point; items may be pre-built ContentBlock[] (expanded chips).
 */
async function injectQueuedInput(
  messages: Message[],
  drain?: LoopOptions["drainQueuedInput"],
  openBoundary?: (msg: Message) => void,
): Promise<boolean> {
  if (!drain) return false;
  const queued = await drain();
  if (queued.length === 0) return false;
  for (const item of queued) {
    const msg: Message = {
      role: "user",
      content: typeof item === "string" ? [{ type: "text", text: item }] : item,
    };
    openBoundary?.(msg);
    messages.push(msg);
  }
  return true;
}

/**
 * Inject pending background completion notifications as one user message
 * (M41). Returns true when a notification was injected (the caller should
 * continue the turn); false when nothing is pending or the continuation
 * budget `maxContinuations` is exhausted (notifications stay queued and are
 * delivered with the next user turn instead).
 */
function injectNotifications(
  messages: Message[],
  drain: (() => string[]) | undefined,
  state: LoopState,
  maxContinuations: number,
  openBoundary?: (msg: Message) => void,
): boolean {
  if (!drain) return false;
  if (state.notificationContinuations >= maxContinuations) return false;
  const notifications = drain();
  if (notifications.length === 0) return false;
  const msg: Message = {
    role: "user",
    content: notifications.map((text) => ({ type: "text", text }) as const),
  };
  openBoundary?.(msg);
  messages.push(msg);
  return true;
}
