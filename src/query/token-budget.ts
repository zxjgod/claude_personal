// ============================================================
// Turn Output Budget — auto-continuation (M32, kernel §7)
// ============================================================
// The SECOND of the two budgets (do not confuse it with the context-window
// budget in context-pipeline.ts, which prevents the prompt from exceeding the
// model limit). This one drives "auto-continue": when a turn would naturally
// end (the model emitted no tool calls), but it has produced far less output
// than the turn was allowed, the loop injects a `nudge` user message and keeps
// going — so the agent can work a long task to completion in one turn instead
// of stopping prematurely.
//
// Two guards keep it from running away:
//   1. A budget ceiling: stop once cumulative output reaches `maxOutputTokens`.
//   2. Diminishing-returns detection: if the last `maxLowGainStreak` (default 3)
//      continuations each produced fewer than `minMarginalTokens` (default 500)
//      tokens, further nudging is unlikely to help — stop.
// Disabled by default (maxOutputTokens = 0): the loop behaves exactly as before
// unless a caller opts in.
// ============================================================

export interface TokenBudgetConfig {
  /** Output-token ceiling for the whole turn. 0 disables auto-continuation. */
  maxOutputTokens: number;
  /** Continue only while cumulative output is below this fraction of the ceiling. */
  continueBelowFraction: number;
  /** A continuation producing fewer than this many tokens counts as "low gain". */
  minMarginalTokens: number;
  /** Stop after this many consecutive low-gain continuations. */
  maxLowGainStreak: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudgetConfig = {
  maxOutputTokens: 0, // opt-in
  continueBelowFraction: 0.9,
  minMarginalTokens: 500,
  maxLowGainStreak: 3,
};

/**
 * Mutable accounting carried across turns. `totalOutput` accumulates the output
 * tokens reported by every model call this turn-sequence; `lowGainStreak`
 * counts consecutive continuations that produced little. `continuations` is how
 * many nudges we've injected (for diagnostics / the nudge message).
 */
export interface TokenBudgetState {
  totalOutput: number;
  lowGainStreak: number;
  continuations: number;
}

export function createTokenBudgetState(): TokenBudgetState {
  return { totalOutput: 0, lowGainStreak: 0, continuations: 0 };
}

/** Fold one model call's reported output tokens into the budget state. */
export function recordOutput(state: TokenBudgetState, outputTokens: number): TokenBudgetState {
  return { ...state, totalOutput: state.totalOutput + Math.max(0, outputTokens) };
}

export interface BudgetDecision {
  /** Inject a nudge and continue the loop. */
  shouldContinue: boolean;
  /** Why we stopped (for diagnostics); undefined when continuing. */
  stopReason?: "disabled" | "budget_reached" | "diminishing_returns";
  /** The updated state to carry forward (streak bookkeeping). */
  state: TokenBudgetState;
}

/**
 * Decide whether a turn that produced no tool calls should auto-continue
 * (kernel §7). `lastTurnOutput` is the output of the model call that just
 * ended; it determines whether this would-be continuation is "low gain".
 *
 * Pure: returns the decision plus the next state, never mutates the input.
 */
export function checkTokenBudget(
  state: TokenBudgetState,
  lastTurnOutput: number,
  config: TokenBudgetConfig,
): BudgetDecision {
  // Disabled → behave exactly as before (no auto-continuation).
  if (config.maxOutputTokens <= 0) {
    return { shouldContinue: false, stopReason: "disabled", state };
  }

  // Update the diminishing-returns streak: a continuation that produced fewer
  // than minMarginalTokens is "low gain". A productive turn resets the streak.
  const lowGain = lastTurnOutput < config.minMarginalTokens;
  const lowGainStreak = lowGain ? state.lowGainStreak + 1 : 0;
  const next: TokenBudgetState = { ...state, lowGainStreak };

  if (lowGainStreak >= config.maxLowGainStreak) {
    return { shouldContinue: false, stopReason: "diminishing_returns", state: next };
  }

  // Stop once we've used (continueBelowFraction) of the output ceiling.
  if (next.totalOutput >= config.maxOutputTokens * config.continueBelowFraction) {
    return { shouldContinue: false, stopReason: "budget_reached", state: next };
  }

  return {
    shouldContinue: true,
    state: { ...next, continuations: next.continuations + 1 },
  };
}

/** The user-role nudge injected to make the agent continue working. */
export function buildContinuationNudge(state: TokenBudgetState): string {
  void state;
  return (
    "Continue working toward completing the task. If it is genuinely finished, " +
    "say so explicitly; otherwise proceed with the next step without waiting."
  );
}
