// ============================================================
// Tests: Turn Output Budget (M32, kernel §7)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  buildContinuationNudge,
  checkTokenBudget,
  createTokenBudgetState,
  DEFAULT_TOKEN_BUDGET,
  recordOutput,
  type TokenBudgetConfig,
} from "../query/token-budget.js";

const enabled: TokenBudgetConfig = {
  ...DEFAULT_TOKEN_BUDGET,
  maxOutputTokens: 10_000,
};

describe("checkTokenBudget", () => {
  it("never continues when the budget is disabled (maxOutputTokens = 0)", () => {
    const d = checkTokenBudget(createTokenBudgetState(), 9999, DEFAULT_TOKEN_BUDGET);
    expect(d.shouldContinue).toBe(false);
    expect(d.stopReason).toBe("disabled");
  });

  it("continues when under budget and the turn was productive", () => {
    let state = createTokenBudgetState();
    state = recordOutput(state, 1000);
    const d = checkTokenBudget(state, 1000, enabled);
    expect(d.shouldContinue).toBe(true);
    expect(d.state.continuations).toBe(1);
  });

  it("stops once cumulative output crosses the continue fraction", () => {
    let state = createTokenBudgetState();
    // 90% of 10_000 = 9000. Push total to 9000 → at/over the threshold.
    state = recordOutput(state, 9000);
    const d = checkTokenBudget(state, 1000, enabled);
    expect(d.shouldContinue).toBe(false);
    expect(d.stopReason).toBe("budget_reached");
  });

  it("stops after maxLowGainStreak consecutive low-gain continuations", () => {
    let state = createTokenBudgetState();
    // Each turn produced < minMarginalTokens (500). Streak builds to 3.
    let d = checkTokenBudget(state, 100, enabled);
    expect(d.shouldContinue).toBe(true);
    expect(d.state.lowGainStreak).toBe(1);
    state = d.state;

    d = checkTokenBudget(recordOutput(state, 100), 100, enabled);
    expect(d.shouldContinue).toBe(true);
    expect(d.state.lowGainStreak).toBe(2);
    state = d.state;

    d = checkTokenBudget(recordOutput(state, 100), 100, enabled);
    expect(d.shouldContinue).toBe(false);
    expect(d.stopReason).toBe("diminishing_returns");
    expect(d.state.lowGainStreak).toBe(3);
  });

  it("resets the low-gain streak after a productive turn", () => {
    let state = createTokenBudgetState();
    state = checkTokenBudget(state, 100, enabled).state; // streak 1
    state = checkTokenBudget(state, 100, enabled).state; // streak 2
    const d = checkTokenBudget(state, 900, enabled); // productive → reset
    expect(d.state.lowGainStreak).toBe(0);
    expect(d.shouldContinue).toBe(true);
  });
});

describe("recordOutput", () => {
  it("accumulates output and clamps negatives to zero", () => {
    let state = createTokenBudgetState();
    state = recordOutput(state, 500);
    state = recordOutput(state, -10);
    expect(state.totalOutput).toBe(500);
  });
});

describe("buildContinuationNudge", () => {
  it("produces a non-empty user nudge", () => {
    expect(buildContinuationNudge(createTokenBudgetState())).toContain("Continue");
  });
});
