// ============================================================
// Streaming Tool Executor — start tools mid-stream (M36, kernel §9 / §3)
// ============================================================
// The agent loop normally collects every tool_use block, waits for the model
// stream to fully drain (the `done` event), THEN runs the tools (STEP 5). But a
// read-only, concurrency-safe call (Read/Glob/Grep, a read-only Bash) is safe
// to start the instant its tool_use block arrives — there is no ordering or
// permission reason to wait. Starting it during the stream hides its latency
// inside the model's remaining streaming time.
//
// Design: this is a thin "early-start cache", deliberately mirroring
// SpeculationCache (M15.2). It does NOT reimplement the loop's ordered-batch /
// abort / pairing machinery — that stays the single source of truth in STEP 5.
// Instead, when a safe tool_use arrives, `add()` kicks off the real call (via
// the loop's own runner) keyed by call id; STEP 5 then serves the in-flight
// result with `take(id)` instead of starting fresh. A miss (unsafe call, or
// disabled) simply means STEP 5 runs it normally — no behavior change.
//
// Safety: only calls a tool reports as BOTH read-only AND concurrency-safe for
// the given input are started early. Read-only alone is NOT enough (review
// fix, "streaming 早启动假设"): an `ask` policy rule or a tool-level
// requiresApproval makes even a read prompt the user — and a permission
// prompt popping mid-stream, concurrently with other calls, is an ordering
// and UX hazard. So the loop additionally injects `canAutoApprove`; a call
// that would prompt loses early-start eligibility (and trips the barrier).
// A write/destructive call is never early-started.
//
// Ordering barrier (Top10 #5): per-call safety is NOT enough. Within one
// assistant message, `Write(f); Read(f)` early-started the Read during the
// stream — strictly BEFORE STEP 5 ran the Write — and the loop then served the
// stale pre-write content to the model in "correct order", silently defeating
// partitionToolCalls' ordering guarantee. So once ANY call in the current
// message is not early-start-safe, every LATER call in that message also loses
// early-start eligibility (read or not). clear() — called by the loop at every
// message/attempt boundary (STEP 5 finally, retry, abort) — resets the barrier.
// ============================================================

import { resolveTool } from "./tools/utils/official-names.js";
import type { Tool, ToolExecutionResult } from "./types.js";
import { CancellationScope } from "./utils/cancellation.js";

/** The loop's single-tool runner, injected to avoid duplicating STEP 5 logic. */
export type SingleToolRunner = (
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolExecutionResult>;

export class StreamingToolExecutor {
  private readonly enabled: boolean;
  private readonly tools: Tool[];
  private readonly run: SingleToolRunner;
  private readonly inflight = new Map<string, Promise<ToolExecutionResult>>();
  private readonly scopes = new Set<CancellationScope>();
  /** Per-message ordering barrier — see the file header (Top10 #5). */
  private sawUnsafeCall = false;
  started = 0;
  hits = 0;

  constructor(
    enabled: boolean,
    tools: Tool[],
    run: SingleToolRunner,
    private readonly parentSignal?: AbortSignal,
    /**
     * Optional veto from the loop: returns false when the call would NOT be
     * auto-approved (ask rule / tool-level requiresApproval), in which case
     * early-starting it would pop a permission prompt mid-stream.
     */
    private readonly canAutoApprove?: (toolName: string, input: Record<string, unknown>) => boolean,
  ) {
    this.enabled = enabled;
    this.tools = tools;
    this.run = run;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** True when `input` names a tool that is read-only AND concurrency-safe. */
  private isSafeToStart(toolName: string, input: Record<string, unknown>): boolean {
    const tool = resolveTool(toolName, this.tools);
    if (!tool) return false;
    try {
      return tool.isReadOnly(input) === true && tool.isConcurrencySafe(input) === true;
    } catch {
      // A predicate that throws → treat as unsafe (never early-start).
      return false;
    }
  }

  /**
   * Offer a tool_use block (arrived mid-stream) for early execution. Starts the
   * call in the background only when it is safe, no earlier call in this
   * message was unsafe (ordering barrier), and it was not already started. A
   * no-op otherwise — STEP 5 will run it normally then.
   */
  add(id: string, toolName: string, input: Record<string, unknown>): void {
    if (!this.enabled) return;
    if (this.inflight.has(id)) return;
    // Barrier: an earlier mutating/unsafe call in THIS message invalidates
    // early-start for everything after it — ordering semantics beat latency
    // hiding (a later Read may depend on the earlier Write).
    if (this.sawUnsafeCall) return;
    if (!this.isSafeToStart(toolName, input)) {
      this.sawUnsafeCall = true;
      return;
    }
    // Review fix: read-only+concurrency-safe does NOT imply auto-approved —
    // an ask rule or requiresApproval tool would prompt mid-stream.
    if (this.canAutoApprove && !this.canAutoApprove(toolName, input)) {
      this.sawUnsafeCall = true;
      return;
    }
    const scope = new CancellationScope(this.parentSignal);
    this.scopes.add(scope);
    this.started++;
    // Swallow rejections into the promise; STEP 5's runner already returns a
    // typed error result, so this should not reject, but guard anyway.
    const p = Promise.resolve()
      .then(() => this.run(toolName, input, scope.signal))
      .catch(
        (e): ToolExecutionResult => ({
          toolName,
          error: e instanceof Error ? e.message : String(e),
          formatted: `Error executing ${toolName}: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        }),
      )
      .finally(() => {
        scope.dispose();
        this.scopes.delete(scope);
      });
    this.inflight.set(id, p);
  }

  /**
   * Serve the early-started result for a call id, or null on a miss (not
   * started early → STEP 5 runs it normally). Each id is served at most once.
   */
  async take(id: string): Promise<ToolExecutionResult | null> {
    const p = this.inflight.get(id);
    if (!p) return null;
    this.inflight.delete(id);
    this.hits++;
    return await p;
  }

  /** How many early starts are still in flight (diagnostics/tests). */
  get pending(): number {
    return this.inflight.size;
  }

  /** Drop early-started results when a model turn is retried or aborted, and
   *  at every message boundary (STEP 5 finally) — which also resets the
   *  ordering barrier for the next assistant message. */
  clear(): void {
    for (const scope of this.scopes) {
      scope.cancel("hard", "Discarded model attempt");
      scope.dispose();
    }
    this.scopes.clear();
    this.inflight.clear();
    this.sawUnsafeCall = false;
  }
}
