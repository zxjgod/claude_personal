// ============================================================
// Tests: session stats (token accumulation + cost estimation)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  estimateCost,
  formatDuration,
  formatUsd,
  lookupPricing,
  SessionStats,
} from "../tui/session-stats.js";

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

  // 16.5: cache hit rate uses input + cacheRead as the denominator so the
  // same accounting works for both providers (Anthropic input excludes cache
  // tokens; OpenAI prompt_tokens includes them but we surface cached_tokens
  // separately and do not double-count).
  it("cacheHitRate = cacheRead / (input + cacheRead)", () => {
    const s = new SessionStats();
    // Anthropic-style: non-cached input 100, cache read 400.
    s.addUsage(100, 0, { read: 400 });
    expect(s.cacheHitRate).toBeCloseTo(400 / 500);
  });

  it("cacheHitRate is null when nothing billed", () => {
    const s = new SessionStats();
    expect(s.cacheHitRate).toBeNull();
  });

  it("does not double-count cache creation into the hit-rate denominator", () => {
    const s = new SessionStats();
    // 100 fresh input + 300 cache creation + 200 cache read on a later call.
    s.addUsage(100, 0, { creation: 300 });
    s.addUsage(50, 0, { read: 200 });
    // denominator = input(150) + cacheRead(200) = 350; creation is not added.
    expect(s.cacheHitRate).toBeCloseTo(200 / 350);
  });
});
