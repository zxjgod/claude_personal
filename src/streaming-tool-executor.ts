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
// the given input are started early. Such calls are auto-approved by the
// permission system anyway, so starting them before STEP 5's permission check
// changes nothing observable. A write/destructive call is never early-started.
// ============================================================

import type { Tool, ToolExecutionResult } from "./types.js";

/** The loop's single-tool runner, injected to avoid duplicating STEP 5 logic. */
export type SingleToolRunner = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>;

export class StreamingToolExecutor {
  private readonly enabled: boolean;
  private readonly tools: Tool[];
  private readonly run: SingleToolRunner;
  private readonly inflight = new Map<string, Promise<ToolExecutionResult>>();
  started = 0;
  hits = 0;

  constructor(enabled: boolean, tools: Tool[], run: SingleToolRunner) {
    this.enabled = enabled;
    this.tools = tools;
    this.run = run;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** True when `input` names a tool that is read-only AND concurrency-safe. */
  private isSafeToStart(toolName: string, input: Record<string, unknown>): boolean {
    const tool = this.tools.find((t) => t.name === toolName);
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
   * call in the background only when it is safe and not already started. A
   * no-op when disabled or unsafe — STEP 5 will run it normally then.
   */
  add(id: string, toolName: string, input: Record<string, unknown>): void {
    if (!this.enabled) return;
    if (this.inflight.has(id)) return;
    if (!this.isSafeToStart(toolName, input)) return;
    this.started++;
    // Swallow rejections into the promise; STEP 5's runner already returns a
    // typed error result, so this should not reject, but guard anyway.
    const p = Promise.resolve()
      .then(() => this.run(toolName, input))
      .catch(
        (e): ToolExecutionResult => ({
          toolName,
          error: e instanceof Error ? e.message : String(e),
          formatted: `Error executing ${toolName}: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        }),
      );
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
}
