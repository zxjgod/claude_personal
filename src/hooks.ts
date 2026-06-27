// ============================================================
// Hooks — PreToolUse / PostToolUse interception
// ============================================================
// Hooks let callers observe, block, or rewrite tool calls without
// touching the agent loop. A PreToolUse hook runs before permission
// checks and may deny the call or replace its input. A PostToolUse
// hook runs after execution and may replace the result shown to the
// model. Hooks are matched by tool name (or "*" for all tools).
// ============================================================

import type { ToolResult } from "./types.js";

export interface PreToolUsePayload {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PreToolUseOutcome {
  /** Block the call entirely; `reason` is surfaced to the model. */
  block?: boolean;
  reason?: string;
  /** Replace the tool input before it runs. */
  input?: Record<string, unknown>;
}

export interface PostToolUsePayload {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
}

export interface PostToolUseOutcome {
  /** Replace the result shown to the model. */
  result?: ToolResult;
}

export interface Hook {
  /** Tool name to match, or "*" for every tool. */
  matcher: string;
  pre?: (payload: PreToolUsePayload) => Promise<PreToolUseOutcome | void> | PreToolUseOutcome | void;
  post?: (payload: PostToolUsePayload) => Promise<PostToolUseOutcome | void> | PostToolUseOutcome | void;
}

export class HookRegistry {
  private hooks: Hook[] = [];

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  private matching(toolName: string): Hook[] {
    return this.hooks.filter((h) => h.matcher === "*" || h.matcher === toolName);
  }

  /**
   * Run PreToolUse hooks in registration order. The first hook to block
   * short-circuits; otherwise input rewrites accumulate.
   */
  async runPre(payload: PreToolUsePayload): Promise<PreToolUseOutcome> {
    let input = payload.input;
    for (const hook of this.matching(payload.toolName)) {
      if (!hook.pre) continue;
      const outcome = await hook.pre({ toolName: payload.toolName, input });
      if (!outcome) continue;
      if (outcome.block) {
        return { block: true, reason: outcome.reason ?? "blocked by hook" };
      }
      if (outcome.input) input = outcome.input;
    }
    return { input };
  }

  /**
   * Run PostToolUse hooks in registration order. Result rewrites chain:
   * each hook sees the previous hook's output.
   */
  async runPost(payload: PostToolUsePayload): Promise<PostToolUseOutcome> {
    let result = payload.result;
    for (const hook of this.matching(payload.toolName)) {
      if (!hook.post) continue;
      const outcome = await hook.post({
        toolName: payload.toolName,
        input: payload.input,
        result,
      });
      if (outcome?.result) result = outcome.result;
    }
    return { result };
  }

  get size(): number {
    return this.hooks.length;
  }

  /**
   * Describe registered hooks for inspection (/hooks). Returns one entry per
   * hook with its matcher and which phases it implements.
   */
  list(): Array<{ matcher: string; pre: boolean; post: boolean }> {
    return this.hooks.map((h) => ({
      matcher: h.matcher,
      pre: Boolean(h.pre),
      post: Boolean(h.post),
    }));
  }
}
