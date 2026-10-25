// ============================================================
// Tool Executor — parallel/serial execution with concurrency safety (M29)
// ============================================================
// Handles tool call grouping, early execution, and result formatting.
// ============================================================

import * as path from "node:path";
import type { OperationOutcome } from "./audit-log.js";
import { logBashOperation, logFileOperation, logToolExecution } from "./audit-log.js";
import { languageServerFor } from "./language-servers.js";
import { loopExecution } from "./loop-execution-context.js";
import { mergePermissionPolicies, policyDecision } from "./permission-policy.js";
import { checkPermission } from "./permissions.js";
import { instructionAttachment } from "./project-instructions.js";
import { markRead } from "./read-tracker.js";
import type { SpeculationCache } from "./speculation.js";
import type { StreamingToolExecutor } from "./streaming-tool-executor.js";
import { InputValidationError } from "./tools/registry.js";
import { resolveTool } from "./tools/utils/official-names.js";
import type {
  AskUserFn,
  HookRunner,
  Message,
  Tool,
  ToolCall,
  ToolContext,
  ToolExecutionResult,
  ToolResult,
} from "./types.js";
import { combineAbortSignals } from "./utils/cancellation.js";
import { all, maxToolConcurrency } from "./utils/generators.js";
import { activeWorkspace } from "./worktrees.js";

// Sentinel thrown so a pending Promise.race can be interrupted by an abort
// without relying on every individual tool promise rejecting.
export class AbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * A watchdog protects one tool call only. It must never be treated as a
 * cancellation of the parent agent loop.
 */
export class ToolWatchdogTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Tool call timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        "The tool was asked to stop; its final state may be unknown. Check its status before retrying.",
    );
    this.name = "ToolWatchdogTimeoutError";
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
  const tool = resolveTool(call.function.name, tools);
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

/**
 * Synthesize an "interrupted" result for a call that HAD started when the
 * abort arrived. This must read differently from abortedResult (review
 * finding "并行批次 abort 假结果"): telling the model the tool "did not run"
 * when it may have completed side effects (a finished Write, a sent request)
 * invites duplicate retries. State the uncertainty instead.
 */
export function interruptedResult(call: ToolCall): ToolExecutionResult {
  return {
    toolName: call.function.name,
    error: "Interrupted",
    formatted:
      `${call.function.name} was interrupted while running — it may have PARTIALLY or FULLY ` +
      `completed its side effects. Verify the current state before retrying it.`,
    isError: true,
  };
}

const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOOL_TIMEOUT_MS = 30 * 60 * 1000;

function toolTimeoutMs(defaultMs = DEFAULT_TOOL_TIMEOUT_MS): number {
  const raw = Number(process.env.CLAUDE_CODE_TOOL_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, MAX_TOOL_TIMEOUT_MS);
  return defaultMs;
}

async function withToolWatchdog<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  abortSignal?: AbortSignal,
  timeoutOverrideMs?: number,
): Promise<T> {
  const timeoutMs = toolTimeoutMs(
    timeoutOverrideMs && Number.isFinite(timeoutOverrideMs) && timeoutOverrideMs > 0
      ? Math.min(timeoutOverrideMs, MAX_TOOL_TIMEOUT_MS)
      : DEFAULT_TOOL_TIMEOUT_MS,
  );
  const combined = combineAbortSignals(abortSignal, timeoutMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        // A parent abort is an explicit cancellation of the agent turn. A
        // watchdog expiry is only a failed tool result, so the next LLM turn
        // can inspect it and decide how to recover.
        reject(
          abortSignal?.aborted
            ? new AbortError("Tool execution aborted")
            : new ToolWatchdogTimeoutError(timeoutMs),
        );
      };
      if (combined.signal.aborted) {
        onAbort();
        return;
      }
      combined.signal.addEventListener("abort", onAbort, { once: true });
      operation(combined.signal)
        .then(resolve, reject)
        .finally(() => {
          combined.signal.removeEventListener("abort", onAbort);
        });
    });
  } finally {
    combined.cleanup();
  }
}

/**
 * Promote a speculatively prefetched Read into the read-before-edit tracker
 * (Top10 #6). The prefetch itself skips markRead — a read the model never saw
 * must not open the Edit gate. Call this when the cached result is (or is
 * about to be) committed to model history:
 *   - executeSingleTool does it inline on a cache hit (STEP 5 path — the
 *     result is committed by the STEP 6 finally no matter what);
 *   - runOne does it when COLLECTING an early-started result (review
 *     follow-up M4: an early start can still be discarded by a stream-error
 *     retry, so its promotion must wait until the stream completed and
 *     STEP 5 collects the result into the committed batch).
 * The promoted mtime is the one captured at PREFETCH time — the version the
 * model is about to see; a later mutation fails the staleness check.
 */
export function promoteSpeculativeRead(
  r: { toolName: string; result?: ToolResult },
  sessionId: string,
): void {
  if (r.toolName.toLowerCase() !== "read") return;
  const md = r.result?.metadata;
  if (typeof md?.readPath === "string" && typeof md.readMtimeMs === "number") {
    markRead(sessionId, md.readPath, md.readMtimeMs);
  }
}

/**
 * Top10 #6: a mutating tool that COMPLETED — or threw/timed out mid-flight —
 * may have touched files; invalidate any speculative entry for the path it
 * names, or the whole cache when no path is derivable (bash can mutate
 * anything). Over-invalidation costs one re-prefetch; a stale hit costs the
 * model's correctness.
 */
function invalidateSpeculativeFor(
  specCache: SpeculationCache | undefined,
  tool: Tool,
  input: Record<string, unknown>,
  workspaceRoot: string,
): void {
  if (!specCache?.isEnabled) return;
  try {
    if (tool.isReadOnly(input) === true) return;
    const mutated = tool.getPath?.(input);
    if (mutated) specCache.invalidatePath(path.resolve(workspaceRoot, mutated));
    else specCache.clear();
  } catch {
    // A throwing predicate must not skip invalidation — clear conservatively.
    try {
      specCache.clear();
    } catch {}
  }
}

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
  opts?: {
    /**
     * Skip the inline speculative-read promotion on a cache hit (the caller
     * promotes when it COMMITS the result). Set by the streaming early-start
     * runner — see promoteSpeculativeRead / review follow-up M4.
     */
    deferSpecPromotion?: boolean;
  },
): Promise<ToolExecutionResult> {
  context = {
    ...context,
    workspaceRoot: activeWorkspace(context.sessionId, context.workspaceRoot),
  };
  hooks = context.hooks ?? hooks;
  const tool = resolveTool(toolCall.function.name, tools);
  if (
    (loopExecution() || context.modelConfig?.options?.ccrLoopExecution) &&
    ["croncreate", "schedule_cron", "sleep"].includes(tool?.name.toLowerCase() ?? "")
  ) {
    return {
      toolName: tool?.name ?? toolCall.function.name,
      error:
        "Managed loops own their schedule. Use the Loop menu or ScheduleWakeup instead of creating independent timers.",
      formatted: "Independent scheduling is disabled inside a managed loop.",
      isError: true,
    };
  }
  // Captured once the call is cleared to execute, so the outer catch can
  // invalidate speculative entries even when the tool THREW or timed out
  // (review follow-up: the invalidation below only ran on returned results).
  let executedMutating: { tool: Tool; input: Record<string, unknown> } | undefined;
  let hookContext = "";
  let hookPermission: "allow" | "ask" | "deny" | undefined;

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
      isError: true,
    };
  }

  try {
    let input: Record<string, unknown>;
    try {
      // Review fix: third-party OpenAI-compatible endpoints OMIT the
      // arguments field (or stream zero deltas) for zero-parameter tools,
      // leaving "" — JSON.parse("") throws and the call was misreported as
      // "Invalid JSON arguments" instead of running with {}.
      const rawArgs = toolCall.function.arguments;
      input = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
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

    // === Audit plumbing (review fix: hoisted above the hook blocks) ===
    // Audit EVERY non-read-only call in EVERY mode — approvals, denials and
    // execution failures are all security-relevant. (Previously only auto-mode
    // decisions were logged, so default/bypass sessions left no trail at all.)
    // This used to live below the PreToolUse/PermissionRequest blocks, which
    // left BOTH hook-driven denial paths (pre.block, PermissionRequest deny)
    // with no audit trail. Hoisted so every return below can record.
    // Fire-and-forget: a log write failure never blocks the turn, and the
    // auditRecorded guard keeps the several call sites below from emitting
    // duplicate entries for one call.
    let isMutating = !tool.isReadOnly(input);
    let auditRecorded = false;
    const recordAudit = (
      outcome: OperationOutcome,
      opts: { userConfirmed?: boolean; reason?: string } = {},
    ): void => {
      if (!isMutating || auditRecorded) return;
      auditRecorded = true;
      const base = {
        workspaceRoot: context.workspaceRoot,
        userConfirmed: opts.userConfirmed ?? false,
        outcome,
        sessionId: context.sessionId,
        errorMessage: opts.reason,
      };
      const name = tool.name;
      if ((name === "bash" || name === "powershell") && typeof input.command === "string") {
        void logBashOperation({ ...base, command: input.command }).catch(() => {});
      } else if (
        (name === "edit" || name === "multi_edit" || name === "write") &&
        typeof input.filePath === "string"
      ) {
        void logFileOperation({
          ...base,
          operation: name === "write" ? "write" : "edit",
          filePath: input.filePath,
        }).catch(() => {});
      } else {
        void logToolExecution({
          ...base,
          toolName: name,
          metadata: { mode: context.permissionMode, reason: opts.reason },
        }).catch(() => {});
      }
    };

    // === PreToolUse hook (before permission + side effects) ===
    if (hooks) {
      const pre = await withToolWatchdog(
        () => hooks.runPre({ toolName: tool.name, input }),
        abortSignal,
      );
      if (pre.block) {
        const reason = pre.reason ?? "blocked by hook";
        recordAudit("denied", { reason });
        return {
          toolName: tool.name,
          error: reason,
          formatted: `Tool blocked by hook: ${reason}`,
          isError: true,
        };
      }
      if (pre.input) {
        // Hooks may rewrite inputs, but the final value must satisfy the same
        // schema and semantic constraints as the model-provided value.
        if (tool.validateInput) {
          try {
            input = tool.validateInput(pre.input) as Record<string, unknown>;
          } catch (err) {
            const message =
              err instanceof InputValidationError
                ? err.message
                : `Invalid hook arguments: ${err instanceof Error ? err.message : String(err)}`;
            return {
              toolName: tool.name,
              error: message,
              formatted: message,
              isError: true,
            };
          }
        } else {
          input = pre.input;
        }
      }
      hookContext = pre.additionalContext ?? "";
      hookPermission = pre.permissionDecision;
      // A rewritten input may change mutability — keep the audit classification
      // in sync with what will actually execute.
      if (pre.input) isMutating = !tool.isReadOnly(input);
    }

    // === Permission check (before any side effect) ===
    // Two layers:
    //   (a) tool-level checkPermissions() — the tool's own hard policy.
    //   (b) system-level checkPermission() — mode + dangerous-pattern +
    //       interactive askUser flow.
    context.permissionMode = context.getPermissionMode?.() ?? context.permissionMode;
    if (hookPermission)
      context.permissionPolicy = mergePermissionPolicies(context.permissionPolicy, {
        allow: hookPermission === "allow" ? [tool.name] : [],
        ask: hookPermission === "ask" ? [tool.name] : [],
        deny: hookPermission === "deny" ? [tool.name] : [],
      });
    const toolLevel = await tool.checkPermissions(input, context);
    if (!toolLevel.allowed) {
      const reason = toolLevel.reason ?? `denied by ${tool.name} policy`;
      recordAudit("denied", { reason });
      return {
        toolName: tool.name,
        error: reason,
        formatted: `Permission denied: ${reason}`,
        isError: true,
      };
    }
    const rule = policyDecision(context.permissionPolicy, tool.name, input, context.workspaceRoot);
    if (hooks?.runEvent && (rule === "ask" || (tool.requiresApproval?.() && rule !== "allow"))) {
      const outcome = await hooks.runEvent("PermissionRequest", {
        tool_name: tool.name,
        tool_input: input,
      });
      if (outcome?.block || outcome?.permissionDecision === "deny") {
        recordAudit("denied", {
          reason: outcome.reason ?? "Permission hook denied tool",
        });
        return {
          toolName: tool.name,
          isError: true,
          error: outcome.reason ?? "Permission hook denied tool",
          formatted: outcome.reason ?? "Permission hook denied tool",
        };
      }
      if (outcome?.input)
        input = tool.validateInput
          ? (tool.validateInput(outcome.input) as Record<string, unknown>)
          : outcome.input;
      // The hook may have rewritten the input AFTER isMutating was computed
      // (review fix: "isMutating 在 hook rewrite 之前判定") — recompute so the
      // audit below reflects what will actually run.
      if (outcome?.input) isMutating = !tool.isReadOnly(input);
      if (outcome?.input) {
        const rewrittenPolicy = await tool.checkPermissions(input, context);
        if (!rewrittenPolicy.allowed)
          return {
            toolName: tool.name,
            isError: true,
            error: rewrittenPolicy.reason ?? "Rewritten hook input violates tool policy",
            formatted: rewrittenPolicy.reason ?? "Rewritten hook input violates tool policy",
          };
      }
      if (outcome?.permissionDecision === "allow")
        context.permissionPolicy = mergePermissionPolicies(context.permissionPolicy, {
          allow: [tool.name],
        });
    }
    const permission = await checkPermission(tool, input, context, {
      askUser,
      classifier: context.permissionClassifier,
    });

    if (!permission.allowed) {
      await hooks?.runEvent?.("PermissionDenied", {
        tool_name: tool.name,
        tool_input: input,
        reason: permission.reason,
      });
      const reason = permission.reason ?? "denied by permission policy";
      recordAudit("denied", { userConfirmed: permission.userConfirmed, reason });
      return {
        toolName: tool.name,
        error: reason,
        formatted: `Permission denied: ${reason}`,
        isError: true,
      };
    }

    const startTime = Date.now();
    // 12.2: Serve from the speculation cache if we prefetched this exact call.
    let result: ToolResult;
    const cached = specCache
      ? await withToolWatchdog(() => specCache.take(tool.name, input), abortSignal)
      : null;
    if (cached) {
      result = cached;
      // Speculative-read promotion (Top10 #6): the prefetch itself skipped
      // markRead; NOW the cached content is going to the model as this Read's
      // result, so promote it — unless the caller asked to defer (streaming
      // early-start: the result is only promoted when STEP 5 collects it,
      // since a stream-error retry would discard it — review follow-up M4).
      if (!opts?.deferSpecPromotion) {
        promoteSpeculativeRead({ toolName: tool.name, result: cached }, context.sessionId);
      }
    } else {
      const toolContext = { ...context, abortSignal };
      executedMutating = { tool, input };
      // Top10 follow-up T6: an explicit per-call timeout (bash/powershell
      // take `timeout` in ms) overrides the 5-min default watchdog — the two
      // used to be unaware of each other, so a legitimate `timeout: 600000`
      // command was watchdog-killed at 5 min with a confusing error while the
      // tool's own timer never fired. withToolWatchdog still caps at its
      // 30-min hard ceiling.
      const inputTimeout =
        typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
          ? input.timeout
          : undefined;
      result = await withToolWatchdog(
        (signal) => tool.call(input, { ...toolContext, abortSignal: signal }),
        abortSignal,
        inputTimeout ?? tool.timeoutMs,
      );
    }
    const duration = Date.now() - startTime;
    if (result.error)
      await hooks?.runEvent?.("PostToolUseFailure", {
        tool_name: tool.name,
        tool_input: input,
        error: result.error,
      });

    // Top10 #6: a mutating tool that just COMPLETED (success OR failure — a
    // failed `sed -i` may still have half-written the file) invalidates any
    // speculative entry for the path it touched; without derivable path info
    // (bash/powershell can mutate anything) drop the whole cache.
    invalidateSpeculativeFor(specCache, tool, input, context.workspaceRoot);

    // Audit the executed outcome (success / tool-reported error). Decisions
    // were already recorded above; this closes the loop for approved calls.
    recordAudit(result.error != null ? "error" : "success", {
      userConfirmed: permission.userConfirmed,
      reason: typeof result.error === "string" ? result.error : undefined,
    });

    // M15.2: Record this path as read so predictReads won't re-prefetch it.
    if (readFiles && tool.name.toLowerCase() === "read" && typeof input.filePath === "string") {
      readFiles.add(input.filePath);
    }

    // === PostToolUse hook (may rewrite the result) ===
    if (hooks) {
      const post = await withToolWatchdog(
        () => hooks.runPost({ toolName: tool.name, input, result }),
        abortSignal,
      );
      if (post.result) result = post.result;
    }

    let formatted = tool.formatResult({
      ...result,
      metadata: { ...result.metadata, durationMs: duration },
    });
    if (hookContext) formatted += `\n\n${hookContext}`;
    if (
      !result.error &&
      ["edit", "write", "multi_edit"].includes(tool.name) &&
      typeof input.filePath === "string"
    ) {
      try {
        const connection = await languageServerFor(context.workspaceRoot, input.filePath);
        if (connection) {
          const diagnostics = await connection.server.waitForDiagnostics(connection.file);
          if (diagnostics.length)
            formatted += `\n\n[LANGUAGE DIAGNOSTICS]\n${JSON.stringify(diagnostics).slice(0, 6000)}`;
        }
      } catch (error) {
        console.warn(`Language server update failed: ${String(error)}`);
      }
    }
    if (
      !result.error &&
      !context.speculative &&
      ["read", "grep", "glob", "edit", "write"].includes(tool.name)
    ) {
      const file = tool.getPath?.(input) ?? input.filePath;
      if (typeof file === "string") {
        const attachment = instructionAttachment(context.sessionId, context.workspaceRoot, file);
        formatted += attachment;
        if (attachment)
          await hooks?.runEvent?.("InstructionsLoaded", {
            file_path: file,
            cwd: context.workspaceRoot,
          });
      }
    }
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
    // A tool that THREW or was killed by the watchdog may still have modified
    // files before dying — run the same speculative invalidation as the
    // success path (review follow-up; the TTL alone would leave a window).
    if (executedMutating) {
      invalidateSpeculativeFor(
        specCache,
        executedMutating.tool,
        executedMutating.input,
        context.workspaceRoot,
      );
    }
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
  concurrency?: number,
): AsyncGenerator<IndexedResult> {
  const batches = partitionToolCalls(toolCalls, tools);

  const runOne = async (call: ToolCall): Promise<ToolExecutionResult> => {
    // M36: if this exact call was early-started during streaming, serve the
    // finished result instead of running it again.
    const early = await streamExecutor?.take(call.id);
    if (early) {
      // Review follow-up M4: the stream completed successfully (we are in
      // STEP 5), so this result WILL be committed to history — NOW promote
      // any speculative read it consumed (the early-start execution itself
      // deferred promotion: a mid-stream error would have discarded it).
      promoteSpeculativeRead(early, context.sessionId);
      return early;
    }
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
    const started = new Set<number>();
    const gens = batch.calls.map(({ call, index }) =>
      (async function* (): AsyncGenerator<IndexedResult> {
        started.add(index);
        yield { index, result: await runOne(call) };
      })(),
    );
    const merged = all(
      gens,
      Math.max(1, Math.min(concurrency ?? maxToolConcurrency(), maxToolConcurrency())),
    );

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
      // Surface results for any call in this batch that never emitted. Calls
      // that had STARTED get the honest "interrupted, side effects unknown"
      // wording; only never-started calls are "aborted before executing".
      for (const { call, index } of batch.calls) {
        if (emitted.has(index)) continue;
        yield { index, result: started.has(index) ? interruptedResult(call) : abortedResult(call) };
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
