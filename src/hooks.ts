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
  /**
   * True when the call is a SpeculationCache background prefetch — a read the
   * model has NOT (yet) asked for and may never see. Side-effectful hooks
   * (audit trails, notifications) can skip these phantom calls; block/rewrite
   * policy still applies to them exactly as to real calls (that gate is the
   * whole point of running hooks at prefetch time — Top10 #6 / review M5).
   */
  speculative?: boolean;
}

export interface PreToolUseOutcome {
  permissionDecision?: "allow" | "ask" | "deny";
  additionalContext?: string;
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

/**
 * Payload for a Stop hook (M32, kernel §8). Fired when a turn would naturally
 * end (no tool calls). `messages` is the current window; `stopHookActive` is
 * true when a prior stop hook already injected a blocking error this turn — a
 * guard so a hook that always blocks can't loop forever.
 */
export interface StopPayload {
  messages: unknown[];
  stopHookActive: boolean;
}

export interface StopOutcome {
  /**
   * Inject this text as a meta user message and continue the loop, giving the
   * agent more to do. Ignored when `stopHookActive` is already set (anti-loop).
   */
  blockingError?: string;
  /** Hard-stop: the loop returns `stop_hook_prevented` and does not continue. */
  preventContinuation?: boolean;
  /** Optional human-readable reason, surfaced to the UI. */
  reason?: string;
}

export interface Hook {
  eventName?: string;
  /** Tool name to match, or "*" for every tool. */
  matcher: string;
  pre?: (
    payload: PreToolUsePayload,
  ) => Promise<PreToolUseOutcome | undefined> | PreToolUseOutcome | undefined;
  post?: (
    payload: PostToolUsePayload,
  ) => Promise<PostToolUseOutcome | undefined> | PostToolUseOutcome | undefined;
  /**
   * Stop hook: runs when the turn would end. Returning `blockingError` keeps the
   * agent working; `preventContinuation` hard-stops it. Not matched by tool name
   * — every registered stop hook runs.
   */
  stop?: (payload: StopPayload) => Promise<StopOutcome | undefined> | StopOutcome | undefined;
  event?: (
    payload: Record<string, unknown>,
  ) => Promise<HookEventOutcome | undefined> | Promise<void> | HookEventOutcome | void;
}
export interface HookEventOutcome {
  permissionDecision?: "allow" | "ask" | "deny";
  input?: Record<string, unknown>;
  block?: boolean;
  reason?: string;
  additionalContext?: string;
}

/** Decision strength for merging: deny > ask > allow. */
function decisionRank(decision: HookEventOutcome["permissionDecision"]): number {
  return decision === "deny" ? 3 : decision === "ask" ? 2 : decision === "allow" ? 1 : 0;
}

/** The stronger of two permission decisions (deny > ask > allow). */
export function strongestPermissionDecision(
  a: HookEventOutcome["permissionDecision"],
  b: HookEventOutcome["permissionDecision"],
): HookEventOutcome["permissionDecision"] {
  return decisionRank(a) >= decisionRank(b) ? a : b;
}

/**
 * Merge two event outcomes. The STRONGEST permission decision wins — a later
 * (or outer-layer) "allow" must never paper over an earlier "deny"/"ask".
 */
export function mergeEventOutcomes(
  a: HookEventOutcome | undefined,
  b: HookEventOutcome | undefined,
): HookEventOutcome | undefined {
  if (!a) return b;
  if (!b) return a;
  const merged = { ...a, ...b };
  merged.permissionDecision = strongestPermissionDecision(
    a.permissionDecision,
    b.permissionDecision,
  );
  return merged;
}

export class HookRegistry {
  private hooks: Hook[] = [];

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  private matching(toolName: string): Hook[] {
    return this.hooks.filter((h) => {
      if (h.matcher === "*") return true;
      // Review follow-up (既有问题 C): matching is CASE-INSENSITIVE. Official
      // hook configs write capitalized tool names ("Edit|Write", "Bash") while
      // this registry's tool names are lowercase — the old case-sensitive
      // comparison made the documented examples silently never fire (a
      // security hook that never runs is worse than no hook: it reads as
      // protected).
      if (h.matcher.toLowerCase() === toolName.toLowerCase()) return true;
      // Config-driven hooks may use a regex matcher (e.g. "Edit|Write"). A plain
      // tool name is also a valid (anchored) regex, so this is a safe superset of
      // strict equality. Invalid patterns never match.
      try {
        return new RegExp(`^(?:${h.matcher})$`, "i").test(toolName);
      } catch {
        return false;
      }
    });
  }

  /**
   * Run PreToolUse hooks in registration order. The first hook to block
   * short-circuits; otherwise input rewrites accumulate.
   */
  async runPre(payload: PreToolUsePayload): Promise<PreToolUseOutcome> {
    let input = payload.input;
    let permissionDecision: PreToolUseOutcome["permissionDecision"];
    const context: string[] = [];
    for (const hook of this.matching(payload.toolName)) {
      if (!hook.pre) continue;
      const outcome = await hook.pre({
        toolName: payload.toolName,
        input,
        speculative: payload.speculative,
      });
      if (!outcome) continue;
      if (outcome.block || outcome.permissionDecision === "deny") {
        return { block: true, reason: outcome.reason ?? "blocked by hook" };
      }
      if (outcome.input) input = outcome.input;
      if (
        outcome.permissionDecision &&
        (permissionDecision !== "ask" || outcome.permissionDecision !== "allow")
      )
        permissionDecision = outcome.permissionDecision;
      if (outcome.additionalContext) context.push(outcome.additionalContext);
    }
    // NOTE: `input` is returned even when unchanged (the SAME reference as
    // payload.input) — consumers detecting a REWRITE must compare identity
    // (see SpeculationCache.prefetch), not truthiness.
    return {
      input,
      ...(permissionDecision && { permissionDecision }),
      ...(context.length && { additionalContext: context.join("\n") }),
    };
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
   * Run Stop hooks in registration order (M32, kernel §8). The first hook to
   * request `preventContinuation` short-circuits (hard stop). Otherwise the
   * first non-empty `blockingError` is returned so the loop injects it and
   * continues. When `stopHookActive` is set, blockingErrors are ignored (the
   * anti-loop guard) but a preventContinuation still hard-stops.
   */
  async runStop(payload: StopPayload): Promise<StopOutcome> {
    let blockingError: string | undefined;
    let reason: string | undefined;
    for (const hook of this.hooks) {
      if (!hook.stop) continue;
      const outcome = await hook.stop(payload);
      if (!outcome) continue;
      if (outcome.preventContinuation) {
        return { preventContinuation: true, reason: outcome.reason };
      }
      if (!blockingError && outcome.blockingError && !payload.stopHookActive) {
        blockingError = outcome.blockingError;
        reason = outcome.reason;
      }
    }
    return blockingError ? { blockingError, reason } : {};
  }

  async runEvent(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<HookEventOutcome | undefined> {
    const context: string[] = [];
    let merged: HookEventOutcome | undefined;
    for (const hook of this.hooks) {
      if (!hook.event) continue;
      if (hook.eventName && hook.eventName !== event) continue;
      const matchValue = String(payload.source ?? payload.reason ?? payload.agent_type ?? event);
      if (hook.matcher !== "*" && hook.matcher !== event) {
        try {
          if (!new RegExp(`^(?:${hook.matcher})$`).test(matchValue)) continue;
        } catch {
          continue;
        }
      }
      // event LAST: a payload field of the same name must not shadow the
      // actual event name — config-built lifecycle hooks branch on it.
      const outcome = await hook.event({ ...payload, event });
      if (outcome?.block) return outcome;
      // deny/ask are sticky: mergeEventOutcomes keeps the strongest decision
      // instead of letting a later "allow" overwrite it via plain spread.
      if (outcome) merged = mergeEventOutcomes(merged, outcome);
      if (outcome?.additionalContext) context.push(outcome.additionalContext);
    }
    if (context.length) return { ...merged, additionalContext: context.join("\n") };
    return merged;
  }

  /**
   * Describe registered hooks for inspection (/hooks). Returns one entry per
   * hook with its matcher and which phases it implements.
   */
  list(): Array<{ matcher: string; pre: boolean; post: boolean; stop: boolean; event: boolean }> {
    return this.hooks.map((h) => ({
      matcher: h.matcher,
      pre: Boolean(h.pre),
      post: Boolean(h.post),
      stop: Boolean(h.stop),
      event: Boolean(h.event),
    }));
  }
}
