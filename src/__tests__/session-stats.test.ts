// ============================================================
// Tests: session stats (token accumulation + cost estimation)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  SessionStats,
  estimateCost,
  lookupPricing,
  formatUsd,
  formatDuration,
} from "../session-stats.js";

describe("session-stats", () => {
  it("accumulates token usage and api calls", () => {
    const s = new SessionStats();
    s.addUsage(100, 50);
    s.addUsage(200, 30);
    expect(s.inputTokens).toBe(300);
    expect(s.outputTokens).toBe(80);
    expect(s.totalTokens).toBe(380);
    expect(s.apiCalls).toBe(2);
  });

  it("counts tool calls", () => {
    const s = new SessionStats();
    s.addToolCalls();
    s.addToolCalls(3);
    expect(s.toolCalls).toBe(4);
  });

  it("looks up known model pricing by substring", () => {
    expect(lookupPricing("claude-opus-4-8")).toEqual({ input: 15, output: 75 });
    expect(lookupPricing("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
    expect(lookupPricing("deepseek-chat")).toEqual({ input: 0.27, output: 1.1 });
  });

  it("returns null pricing for unknown models", () => {
    expect(lookupPricing("some-unknown-model")).toBeNull();
  });

  it("prefers more specific gpt-4o-mini over gpt-4o", () => {
    // gpt-4o-mini entry is listed before gpt-4o, so it wins.
    expect(lookupPricing("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
    expect(lookupPricing("gpt-4o")).toEqual({ input: 2.5, output: 10 });
  });

  it("estimates cost for a known model", () => {
    // 1M input @ $15 + 1M output @ $75 = $90
    expect(estimateCost("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(90);
  });

  it("returns null cost for unknown models", () => {
    expect(estimateCost("mystery-model", 1000, 1000)).toBeNull();
  });

  it("SessionStats.cost delegates to estimateCost", () => {
    const s = new SessionStats();
    s.addUsage(1_000_000, 0);
    expect(s.cost("claude-sonnet-4-6")).toBeCloseTo(3);
    expect(s.cost("unknown")).toBeNull();
  });

  it("formats USD with adaptive precision", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0005)).toBe("$0.0005");
    expect(formatUsd(1.234)).toBe("$1.23");
  });

  it("formats durations", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(83_000)).toBe("1m 23s");
  });
});
