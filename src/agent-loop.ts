// ============================================================
// Agent Loop — The heart of the system
// ============================================================

import { COMPACT_BOUNDARY_MARKER, CollapseStore, prepareCheapLayers } from "./context-pipeline.js";
import { checkPermission } from "./permissions.js";
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
import { InputValidationError, toolUseError } from "./tool-registry.js";
import { spillIfLarge } from "./tool-result-spill.js";
import { startToolSummary } from "./tool-summary.js";
import type {
  AskUserFn,
  HookRunner,
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
import { all, maxToolConcurrency } from "./utils/generators.js";

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

/**
 * Loop-carried state (kernel §3/§9). A single struct rewritten as a whole at
 * each "continue" point rather than nine scattered mutable locals — so a
 * `transition` tag records why we re-entered the top of the loop, and recovery
 * paths are testable without inspecting message contents. `messages` is still
 * mutated in place (callers — cli.ts/team.ts — rely on that accumulation
 * contract), but the scalars travel together here.
 */
interface LoopState {
  turnCount: number;
  totalTokens: number;
  rateLimitRetries: number;
  contextLengthRetries: number;
  /** Why the previous step handed control back to the loop top. */
  transition: { reason: "start" | "model_retry" | "compact_retry" | "tools_done" };
  /**
   * Token accounting baseline from the last model call (M31, kernel §6): the
   * provider-reported prompt token count and how many messages were in the
   * window when it was reported. The next turn estimates context as
   * `promptTokens + estimate(messages appended since)` instead of re-tokenizing
   * the whole history. Invalidated (set undefined) whenever messages are
   * rewritten (compaction), forcing a full re-estimate that turn.
   */
  usageBaseline?: { promptTokens: number; messageCount: number };
  /**
   * Output-token accounting for the turn-output budget (M32, kernel §7).
   * Accumulates output across model calls so the loop can decide whether to
   * auto-continue when a turn ends with no tool calls.
   */
  budget: TokenBudgetState;
  /**
   * True once a stop hook has injected a blocking error this turn-sequence
   * (M32, kernel §8). The anti-loop guard: a hook that always blocks is honored
   * once, then ignored so it can't spin forever.
   */
  stopHookActive: boolean;
}

/**
 * Synthesize a paired tool_result for any tool_use that never produced one
 * (kernel §7 / 02-tool-system §7: every tool_use MUST have a matching
 * tool_result, or the next API call 400s). Mutates `messages` in place,
 * appending a synthetic error result for each unmatched tool_call id. Called
 * on the throw/crash path where executeToolCalls bailed mid-batch.
 */
function backfillMissingToolResults(messages: Message[], toolCalls: ToolCall[]): void {
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
    // M31: hard ceiling. When autoCompact is disabled (threshold = Infinity) and
    // the context still exceeds this, the loop refuses the call with a typed
    // `blocking_limit` terminal rather than 400ing the provider — leaving room
    // for a manual /compact.
    contextHardLimit = 200_000,
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
    // M32: turn output budget for auto-continuation (kernel §7). 0 disables it.
    turnOutputBudget = 0,
    // M36: type-ahead input provider (kernel §9). Drained at turn boundaries.
    drainQueuedInput,
  } = options;

  // Build the full ToolContext from caller-provided values, falling back to
  // sensible defaults. This replaces the previously hardcoded context.
  const baseContext: ToolContext = {
    workspaceRoot: toolContext?.workspaceRoot ?? process.cwd(),
    sessionId: toolContext?.sessionId ?? "default",
    permissionMode: toolContext?.getPermissionMode?.() ?? toolContext?.permissionMode ?? "default",
    getPermissionMode: toolContext?.getPermissionMode,
    setPermissionMode: toolContext?.setPermissionMode,
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
    // M35 fork support (kernel §6 mechanism A): expose the parent's current
    // message history + system prompt so the Task tool can fork the current
    // agent. getParentMessages closes over the loop's `messages` local (which is
    // reassigned on compaction), so it always reflects the live history; we hand
    // out a shallow copy so a fork can't mutate the parent's array.
    getParentMessages: () => messages.slice(),
    parentSystemPrompt: systemPrompt,
  };

  // Per-loop retry counters for recoverable model errors. Without a cap, a
  // sustained 429 or an un-fixable context_length error loops forever
  // (re-calling the model with the same oversized messages each turn).
  const MAX_RATE_LIMIT_RETRIES = 3;
  const MAX_CONTEXT_LENGTH_RETRIES = 3;

  let state: LoopState = {
    turnCount: 0,
    totalTokens: 0,
    rateLimitRetries: 0,
    contextLengthRetries: 0,
    transition: { reason: "start" },
    budget: createTokenBudgetState(),
    stopHookActive: false,
  };

  // M32: per-call output for the budget decision. Reset each model call, folded
  // into state.budget on `done`, and consulted when a turn ends with no tools.
  const budgetConfig = { ...DEFAULT_TOKEN_BUDGET, maxOutputTokens: turnOutputBudget };

  // Speculative prefetch cache (12.2). Lives for this loop run; serves at most
  // one cached result per tool+input. No-op unless `speculation` is enabled.
  const specCache = new SpeculationCache(speculation);

  // M15.2: Paths already Read this session. predictReads drops these before
  // ranking, since the model won't re-Read a file it has already opened — so
  // prefetching them is pure waste. Populated below as real Reads resolve
  // (hit or miss), and threaded into predictReads.
  const readFiles = new Set<string>();

  // M31: recoverable stash for content the cheap compaction layers trim/evict.
  // Lives for this loop run; layers 2/3 collapse originals into it.
  const collapseStore = new CollapseStore();

  // M36: early-start read-only/concurrency-safe tool calls the moment their
  // tool_use block arrives mid-stream (kernel §9), hiding their latency inside
  // the model's remaining streaming time. The runner is executeSingleTool — the
  // SAME full path STEP 5 uses (permission + format + spill) — so a hit serves a
  // finished result. Gated by the speculation flag (same safety family: only
  // read-only + concurrency-safe, which are auto-approved anyway).
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
      // Pass specCache so the two prefetch mechanisms COMPOSE: speculation
      // predicts likely reads across turns; the streaming executor consumes that
      // prediction when the model actually emits the call mid-stream (a spec
      // hit). A non-predicted early-start is a legitimate spec miss.
      specCache,
      readFiles,
      abortSignal,
    ),
  );

  /** Build the typed terminal exit code (kernel §8). */
  const terminal = (reason: TerminalReason, error?: unknown): Terminal => ({
    reason,
    turns: state.turnCount,
    error,
  });

  // M36: fire the background prefetch ONCE, now, concurrently with the first
  // model stream (kernel §9). Its result is injected before STEP 2 the first
  // time around. Best-effort: a rejecting provider injects nothing.
  const prefetchPromise = options.prefetch
    ? options.prefetch(latestUserText(messages)).catch(() => null)
    : null;
  let prefetchInjected = false;

  // M36: fast-model tool-batch summary (kernel §9). After a tool batch runs we
  // start a summary that runs during the NEXT stream's latency, then consume it
  // NON-BLOCKINGLY at the next turn boundary: the summarizer resolves into
  // `readyToolSummary` via a `.then`, and STEP 2 injects whatever is ready
  // without ever awaiting. If a summary isn't ready in time it's injected a turn
  // later (or dropped when superseded) — latency hiding never adds latency.
  let readyToolSummary: string | null = null;

  while (state.turnCount < maxTurns) {
    const { turnCount } = state;
    // Check for abort. A SOFT interrupt (user typed mid-turn) returns a distinct
    // terminal so the caller resumes with the queued input, rather than treating
    // it as a hard cancel (kernel §9).
    if (abortSignal?.aborted) {
      yield { type: "aborted", reason: abortSignal.reason };
      return terminal(isInterrupt(abortSignal) ? "aborted_interrupt" : "aborted_streaming");
    }

    // === STEP 1: Context preparation pipeline (M31, kernel §6) ===
    // Run the cheap, cache-friendly layers first (boundary-drop → byte budget →
    // microcompact). Each may reclaim enough headroom that the heavy LLM
    // summarization (layer 5) never runs. Token accounting uses the last
    // reported usage + an estimate of what was appended since, not a full
    // re-tokenize (estTokens below).
    const estTokens = (msgs: Message[]): number => estimateContextTokens(msgs, state.usageBaseline);
    const prepared = prepareCheapLayers(messages, {
      estimateTokens: estTokens,
      threshold: autoCompactThreshold,
      store: collapseStore,
    });
    if (prepared.messages !== messages) {
      messages = prepared.messages;
      // The window changed shape — the byte baseline no longer maps to it.
      state = { ...state, usageBaseline: undefined };
    }
    for (const note of prepared.notes) {
      yield { type: "compacted", summary: note };
    }

    if (prepared.needsAutoCompact) {
      // needsAutoCompact can only be true when the threshold is finite (an
      // estimate is never > Infinity), so this branch is the autoCompact-enabled
      // path. Layer 5: LLM summary. Resets the window, so drop the baseline.
      yield { type: "compacting" };
      messages = await autoCompact(messages, callModel, modelConfig, abortSignal);
      state = { ...state, usageBaseline: undefined };
      yield { type: "compacted", summary: "Context compressed" };
    } else if (
      autoCompactThreshold === Number.POSITIVE_INFINITY &&
      estTokens(messages) >= contextHardLimit
    ) {
      // autoCompact disabled and over the hard ceiling — refuse rather than send
      // an oversized request. Leaves room for a manual /compact.
      const err = new Error(
        `Context exceeds the hard limit (${contextHardLimit} tokens) and auto-compaction is disabled. Run /compact.`,
      );
      yield { type: "error", error: err };
      return terminal("blocking_limit", err);
    }

    // === STEP 2: Call the LLM ===
    yield { type: "thinking" };

    // M36: inject the background prefetch (started at loop start, ran during the
    // first stream's latency) once, before the first model call consumes it.
    if (prefetchPromise && !prefetchInjected) {
      prefetchInjected = true;
      const attachment = await prefetchPromise;
      if (attachment) {
        messages.push({ role: "system", content: attachment });
        // The window grew before the call — the byte baseline no longer maps.
        state = { ...state, usageBaseline: undefined };
      }
    }

    // M36: inject the fast-model tool-batch summary if it finished during the
    // previous stream (kernel §9). Non-blocking — we consume only what's already
    // resolved into readyToolSummary; if it's not ready we move on (it may land
    // a turn later, or be superseded). Never await here.
    if (readyToolSummary) {
      messages.push({ role: "system", content: readyToolSummary });
      readyToolSummary = null;
      state = { ...state, usageBaseline: undefined };
    }

    let textBuffer = "";
    // M32: output tokens this call, for the turn-output budget decision below.
    let lastTurnOutput = 0;
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | null = null;
    // Window size at the moment we call the model — the baseline's messageCount
    // (M31). The `done` usage reports tokens for exactly this prefix; everything
    // appended afterward (assistant + tool results) is estimated as a delta.
    const windowAtCall = messages.length;
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
            // M36: offer this call for early execution. Safe (read-only +
            // concurrency-safe) calls start now, in the background, while the
            // stream keeps flowing; STEP 5 serves the finished result via take().
            streamExecutor.add(event.id, event.name, event.input);
            yield {
              type: "tool_use",
              id: event.id,
              name: event.name,
              input: event.input,
            };
            break;

          case "done": {
            usage = event.usage;
            lastTurnOutput = event.usage.output_tokens;
            // M31: record the usage baseline. promptTokens = everything the
            // provider counted as input for this call (fresh + cached). The
            // next turn estimates context as this + delta(messages since), so
            // we stop re-tokenizing the whole history every turn.
            const promptTokens =
              event.usage.input_tokens +
              (event.usage.cache_read_input_tokens ?? 0) +
              (event.usage.cache_creation_input_tokens ?? 0);
            state = {
              ...state,
              totalTokens: state.totalTokens + usage.input_tokens + usage.output_tokens,
              usageBaseline: { promptTokens, messageCount: windowAtCall },
              // M32: fold this call's output into the turn-output budget.
              budget: recordOutput(state.budget, usage.output_tokens),
            };
            yield { type: "usage", usage: event.usage };
            streamEnded = true;
            break;
          }

          case "error": {
            // Handle recoverable errors
            const recovery = await handleModelError(event.error, {
              rateLimitRetries: state.rateLimitRetries,
              contextLengthRetries: state.contextLengthRetries,
              maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
              maxContextLengthRetries: MAX_CONTEXT_LENGTH_RETRIES,
            });
            if (recovery === "retry") {
              state = { ...state, rateLimitRetries: state.rateLimitRetries + 1 };
              nextAction = "retry";
              streamEnded = true;
              break;
            }
            if (recovery === "compact_and_retry") {
              state = { ...state, contextLengthRetries: state.contextLengthRetries + 1 };
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
        }
        // Once the stream has reached a terminal event (done / error), stop
        // consuming further events — the error-recovery decision is final for
        // this turn and must drive the loop's next action.
        if (streamEnded) break;
      }
    } catch (error) {
      yield { type: "error", error };
      return terminal("model_error", error);
    }

    if (nextAction === "abort") {
      yield { type: "error", error: abortError };
      // Distinguish "context too long, compaction failed" from a generic model
      // error so callers can branch (kernel §8).
      const reason: TerminalReason = isContextLengthError(abortError)
        ? "prompt_too_long"
        : "model_error";
      return terminal(reason, abortError);
    }
    if (nextAction === "retry") {
      state = { ...state, transition: { reason: "model_retry" } };
      continue; // restart the while loop: re-call the model
    }

    // === STEP 3: No tool calls — the turn would end here (kernel §8) ===
    // Before returning `completed`, run two gates: a pluggable stop-hook gate
    // (a hook may inject more work or hard-stop), then the turn-output budget
    // (auto-continue while the agent still has budget and is making progress).
    if (toolCalls.length === 0) {
      // Save the assistant's text response to message history.
      if (textBuffer) {
        messages.push({ role: "assistant", content: textBuffer });
      }

      // Reaching here means the model stream ended cleanly via `done` (the
      // error/retry/abort paths above all return or `continue` first). So the
      // kernel's "skip stop hooks when the last message is an API error" guard
      // is satisfied structurally — but we keep the stop gate itself optional.
      if (hooks?.runStop) {
        const stop = await hooks.runStop({
          messages,
          stopHookActive: state.stopHookActive,
        });
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
        // A blockingError injects a meta user message and continues — but only
        // the first time (stopHookActive guards against an always-blocking hook
        // looping forever; runStop already ignores blockingError when set).
        if (stop.blockingError) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: stop.blockingError }],
          });
          state = {
            ...state,
            stopHookActive: true,
            turnCount: turnCount + 1,
            transition: { reason: "model_retry" },
          };
          continue;
        }
      }

      // Turn-output budget: auto-continue if under budget and still productive.
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

      // M36: before ending the turn, pick up any type-ahead the user queued
      // while the model was working. If present, inject it and keep going —
      // the user's follow-up is handled in this same run, not after a round-trip
      // (kernel §9). Checked AFTER the budget nudge so explicit input wins.
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
    messages.push({
      role: "assistant",
      content: textBuffer || null,
      tool_calls: toolCalls,
    });

    // === STEP 5: Execute tool calls (parallel for safe ones) ===
    // Stream each result the moment it finishes (so the UI shows reads as
    // they happen, not all at once after the whole batch completes), while
    // still collecting them in call order for the history + batch event.
    //
    // The whole batch is wrapped so that — no matter how it exits (normal,
    // abort, or an unexpected throw inside executeToolCalls) — STEP 6 still
    // pushes a tool_result for every tool_use. The assistant message above
    // already carries the tool_calls; leaving any unpaired would 400 the next
    // API call (kernel §7: every tool_use MUST have a matching tool_result).
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
        yield {
          type: "tool_result",
          id: toolCalls[done.index]!.id,
          result: done.result,
        };
      }
    } finally {
      // === STEP 6: Add tool results to history ===
      // Fill any gap (crash/abort left a hole) with a synthetic error result so
      // the assistant's tool_calls are never left unpaired.
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
        // The model sees `modelContent` (size-bounded, possibly spilled to disk
        // — M30); absent, it falls back to `formatted`. Failures are then
        // wrapped in the kernel's <tool_use_error> envelope (kernel §2). The UI
        // already rendered the full `formatted` via the tool_result events
        // above, so terminal output stays complete.
        const modelText = r.modelContent ?? r.formatted;
        messages.push({
          role: "tool",
          tool_call_id: toolCalls[i]!.id,
          name: toolCalls[i]!.function.name,
          content: r.isError ? toolUseError(modelText) : modelText,
        });
      }
      // Defense in depth: if the in-place push above somehow diverged from the
      // tool_calls (e.g. a tool result was appended elsewhere), backfill any
      // still-unmatched ids before the loop hands control back.
      backfillMissingToolResults(messages, toolCalls);
    }

    // 12.2: Speculatively prefetch likely follow-up Reads from any search
    // (grep/glob) results, so they're warm if the model asks next turn.
    if (specCache.isEnabled) {
      for (const r of toolResults) {
        if (r.result) {
          specCache.prefetch(predictReads(r.toolName, r.result, {}, readFiles), tools, baseContext);
        }
      }
    }

    // M36: start a fast-model summary of this tool batch (kernel §9). It runs
    // during the next stream's latency; when it resolves it drops into
    // readyToolSummary for STEP 2 to inject non-blockingly. startToolSummary
    // returns null (no work) for batches below the size gate. A newer batch
    // supersedes an unconsumed older summary — only the latest matters.
    if (options.summarizeToolBatch) {
      const summaryPromise = startToolSummary({
        results: toolResults,
        summarize: options.summarizeToolBatch,
      });
      if (summaryPromise) {
        // Last-writer-wins: when it resolves it overwrites readyToolSummary; a
        // newer batch's summary simply replaces an older unconsumed one once it
        // lands. We don't pre-null here — that would drop an older summary that
        // resolved but hasn't been injected yet.
        summaryPromise.then((attachment) => {
          if (attachment) readyToolSummary = attachment;
        });
      }
    }

    // If the user aborted during tool execution, stop here with a typed reason
    // (the synthetic results above already kept the history well-formed). A soft
    // interrupt is distinguished so the caller can resume with queued input.
    if (abortSignal?.aborted) {
      yield { type: "tool_results", results: toolResults };
      yield { type: "aborted", reason: abortSignal.reason };
      return terminal(isInterrupt(abortSignal) ? "aborted_interrupt" : "aborted_tools");
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

    // M36: pick up any type-ahead the user queued while tools ran, so a
    // mid-task instruction is seen on the next model call rather than at turn
    // end (kernel §9). Injected as user messages after the tool results.
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

// --- Tool Call Execution ---

interface IndexedResult {
  index: number;
  result: ToolExecutionResult;
}

type IndexedCall = { call: ToolCall; index: number };
type Batch = { safe: boolean; calls: IndexedCall[] };

/**
 * Decide whether a tool call is safe to run concurrently (kernel §6, M29).
 * Data-driven: parses the call's JSON arguments and asks the tool's
 * `isConcurrencySafe(input)`. CONSERVATIVE — a missing tool, unparseable
 * arguments, or a predicate that throws all resolve to `false` (run serially),
 * since the cost of wrongly parallelizing a mutating call is a race condition.
 */
function callIsConcurrencySafe(call: ToolCall, tools: Tool[]): boolean {
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
 * ahead of the write. This replaces the old "all parallel, then all serial"
 * split, which could reorder a read past a write that should precede it.
 */
function partitionToolCalls(toolCalls: ToolCall[], tools: Tool[]): Batch[] {
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
function abortedResult(call: ToolCall): ToolExecutionResult {
  return {
    toolName: call.function.name,
    error: "Aborted",
    formatted: `Aborted before executing ${call.function.name}.`,
    isError: true,
  };
}

/**
 * Execute tool calls in ordered batches (kernel §6, M29). Concurrency-safe runs
 * parallelize (bounded by maxToolConcurrency, default 10) and surface in
 * completion order; everything else runs serially. The caller reassembles call
 * order from `index`, so streaming early results never scrambles history.
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
  streamExecutor?: StreamingToolExecutor,
): AsyncGenerator<IndexedResult> {
  const batches = partitionToolCalls(toolCalls, tools);

  const runOne = async (call: ToolCall): Promise<ToolExecutionResult> => {
    // M36: if this exact call was early-started during streaming, serve the
    // finished result instead of running it again. Miss → run normally.
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
    // If we've already been aborted, surface aborted results for the whole
    // remaining batch (keeps every tool_use paired — kernel §7).
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

    // Parallel batch: merge per-call one-shot generators with bounded
    // concurrency. Each generator yields exactly one IndexedResult.
    const gens = batch.calls.map(({ call, index }) =>
      (async function* (): AsyncGenerator<IndexedResult> {
        yield { index, result: await runOne(call) };
      })(),
    );
    const merged = all(gens, maxToolConcurrency());

    const emitted = new Set<number>();
    let wasAborted = false;
    while (true) {
      // Race the merged batch against the abort signal so a hung tool can't
      // wedge the loop and ignore Ctrl+C.
      let step: IteratorResult<IndexedResult>;
      if (abortSignal) {
        const abortPromise = new Promise<never>((_, reject) => {
          if (abortSignal.aborted) reject(new AbortError("Aborted"));
          else
            abortSignal.addEventListener("abort", () => reject(new AbortError("Aborted")), {
              once: true,
            });
        });
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
    if (wasAborted) {
      // Surface aborted results for any call in this batch that never emitted,
      // so the assistant's tool_calls are never left unpaired.
      for (const { call, index } of batch.calls) {
        if (!emitted.has(index)) yield { index, result: abortedResult(call) };
      }
    }
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
    // Strict Zod schemas (via buildTool) reject unknown keys the model may
    // inject and coerce the input to the tool's typed shape. A validation
    // failure is recoverable: surface a <tool_use_error> so the model can fix
    // its arguments next turn, rather than letting a malformed call reach the
    // tool body. Tools without a schema (legacy createTool) skip this.
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
          formatted: `工具被 hook 拦截: ${reason}`,
          isError: true,
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
    context.permissionMode = context.getPermissionMode?.() ?? context.permissionMode;
    const toolLevel = await tool.checkPermissions(input, context);
    if (!toolLevel.allowed) {
      const reason = toolLevel.reason ?? `denied by ${tool.name} policy`;
      return {
        toolName: tool.name,
        error: reason,
        formatted: `权限被拒绝: ${reason}`,
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
        formatted: `权限被拒绝: ${reason}`,
        isError: true,
      };
    }

    const startTime = Date.now();
    // 12.2: Serve from the speculation cache if we prefetched this exact call.
    // The prefetch already ran the (read-only) tool, so this is a pure hit.
    let result = (await specCache?.take(tool.name, input)) ?? (await tool.call(input, context));
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

    const formatted = tool.formatResult({
      ...result,
      metadata: { ...result.metadata, durationMs: duration },
    });
    // M30: bound the model-facing copy. Oversized results spill to a workspace
    // file and the model gets a preview + path; the UI still renders `formatted`
    // in full. Read opts out (Infinity) so a Read result never spills.
    const modelContent = spillIfLarge(formatted, {
      maxChars: tool.maxResultSizeChars,
      toolName: tool.name,
      workspaceRoot: context.workspaceRoot,
      sessionId: context.sessionId,
    });

    return {
      toolName: tool.name,
      result,
      // A tool that returns {error} inside its result is a recoverable failure
      // too (e.g. file not found) — flag it so the model boundary wraps it.
      isError: result.error != null,
      formatted,
      modelContent,
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

/**
 * Estimate the prepared context's token count (M31, kernel §6). When a usage
 * baseline is available and still maps to the current window (no compaction
 * happened, and the window only grew), this is the provider-reported prompt
 * token count plus a cheap estimate of just the messages appended since — so we
 * avoid re-tokenizing the entire history every turn. Falls back to a full
 * estimate when there is no baseline or the window was rewritten/shrank
 * (compaction invalidates the baseline by setting it undefined, but we
 * double-check the length here as defense in depth).
 */
function estimateContextTokens(messages: Message[], baseline: LoopState["usageBaseline"]): number {
  if (baseline && messages.length >= baseline.messageCount) {
    const appended = messages.slice(baseline.messageCount);
    return baseline.promptTokens + estimateTokens(appended);
  }
  return estimateTokens(messages);
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

  // Rebuild: system summary + tail. The summary is tagged with
  // COMPACT_BOUNDARY_MARKER so the pipeline's layer 1
  // (getMessagesAfterCompactBoundary) can physically drop everything before it
  // on subsequent turns (kernel §6).
  return [
    {
      role: "system",
      content: `${COMPACT_BOUNDARY_MARKER}\n${summary}`,
    },
    ...tailMessages,
  ];
}

// --- Error Recovery ---

/** True when an error looks like the model rejecting an over-long context. */
function isContextLengthError(error: unknown): boolean {
  const err = error as { status?: number; message?: string } | null;
  const msg = err?.message ?? "";
  return err?.status === 400 && (msg.includes("context_length") || msg.includes("maximum context"));
}

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

async function handleModelError(error: unknown, state: RecoveryState): Promise<ModelErrorRecovery> {
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
    (err?.message?.includes("context_length") || err?.message?.includes("maximum context"))
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

/**
 * Inject queued type-ahead input as follow-up user messages (M36, kernel §9).
 * Returns true when anything was injected. Called at turn boundaries so input
 * the user typed while the agent was working is picked up rather than discarded.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The text of the most recent user message (M36) — the query the background
 * prefetch ranks memories/skills against. Concatenates the message's text
 * blocks; returns "" when there is no user message or it carries only images.
 */
function latestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      return m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}
