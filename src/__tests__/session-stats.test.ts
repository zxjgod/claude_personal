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

  it("reset clears token, cache, and historical cost buckets", () => {
    const s = new SessionStats();
    s.addUsage(1_000_000, 50, { read: 100, creation: 200 }, "claude-sonnet-4-6", "anthropic");
    s.addUsage(2_000_000, 60, { read: 300 }, "gpt-4o-mini", "openai");
    s.addToolCalls(4);

    s.reset();

    expect(s).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      apiCalls: 0,
      toolCalls: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(s.totalTokens).toBe(0);
    expect(s.cacheHitRate).toBeNull();
    expect(s.cost("claude-opus-4-8")).toBe(0);

    s.addUsage(1_000_000, 0, undefined, "gpt-4o-mini", "openai");
    expect(s.cost("claude-opus-4-8")).toBeCloseTo(0.15);
    expect(s.totalTokens).toBe(1_000_000);
  });

  it("looks up known model pricing by substring", () => {
    // Opus 4.8 pricing per the WS3 model-metadata table (verified against the
    // claude-api skill's model list: $5 in / $25 out per 1M).
    expect(lookupPricing("claude-opus-4-8")).toEqual({ input: 5, output: 25 });
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
    // 1M input @ $5 + 1M output @ $25 = $30 (Opus 4.8 metadata-table pricing)
    expect(estimateCost("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(30);
  });

  it("returns null cost for unknown models", () => {
    expect(estimateCost("mystery-model", 1000, 1000)).toBeNull();
  });

  it("SessionStats.cost prices legacy usage with the supplied model", () => {
    const s = new SessionStats();
    s.addUsage(1_000_000, 0);
    expect(s.cost("claude-sonnet-4-6")).toBeCloseTo(3);
    expect(s.cost("unknown")).toBeNull();
  });

  it("keeps historical costs in the model bucket that produced each usage", () => {
    const s = new SessionStats();
    s.addUsage(1_000_000, 0, undefined, "claude-sonnet-4-6", "anthropic");
    s.addUsage(1_000_000, 0, undefined, "gpt-4o-mini", "openai");

    // The argument is only a fallback for legacy, model-less usage. It must
    // not reprice either recorded bucket after a switch to a more expensive model.
    expect(s.cost("claude-opus-4-8")).toBeCloseTo(3.15);
    expect(s.cost("gpt-4o")).toBeCloseTo(3.15);
  });

  it("does not reprice an unknown historical model under a known current model", () => {
    const s = new SessionStats();
    s.addUsage(1_000, 0, undefined, "mystery-model", "custom");
    expect(s.cost("gpt-4o")).toBeNull();
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

  // Cache metrics use each call's provider-normalized prompt size. Legacy
  // calls without a provider retain the Anthropic split-cache interpretation.
  it("cacheHitRate = cacheRead / prompt input for legacy Anthropic usage", () => {
    const s = new SessionStats();
    s.addUsage(100, 0, { read: 400 });
    expect(s.cacheHitRate).toBeCloseTo(400 / 500);
    expect(s.totalTokens).toBe(500);
  });

  it("cacheHitRate is null when nothing billed", () => {
    const s = new SessionStats();
    expect(s.cacheHitRate).toBeNull();
  });

  it("includes Anthropic cache creation in the denominator but not as a hit", () => {
    const s = new SessionStats();
    s.addUsage(100, 0, { creation: 300 });
    s.addUsage(50, 0, { read: 200 });
    expect(s.cacheHitRate).toBeCloseTo(200 / 650);
    expect(s.totalTokens).toBe(650);
  });

  it("does not add OpenAI cached tokens to input or total tokens again", () => {
    const s = new SessionStats();
    s.addUsage(1_000, 200, { read: 600 }, "gpt-4o", "openai");

    expect(s.inputTokens).toBe(1_000);
    expect(s.totalTokens).toBe(1_200);
    expect(s.cacheHitRate).toBeCloseTo(0.6);
  });

  it("adds Anthropic cache read and creation to total prompt tokens", () => {
    const s = new SessionStats();
    s.addUsage(100, 20, { read: 400, creation: 300 }, "claude-sonnet-4-6", "anthropic");

    expect(s.inputTokens).toBe(100);
    expect(s.totalTokens).toBe(820);
    expect(s.cacheHitRate).toBeCloseTo(0.5);
  });

  it("combines mixed-provider prompt totals and cache hits without double counting", () => {
    const s = new SessionStats();
    s.addUsage(1_000, 200, { read: 600 }, "gpt-4o", "openai");
    s.addUsage(100, 20, { read: 400, creation: 300 }, "claude-sonnet-4-6", "anthropic");

    expect(s.inputTokens).toBe(1_100);
    expect(s.outputTokens).toBe(220);
    expect(s.cacheReadTokens).toBe(1_000);
    expect(s.cacheCreationTokens).toBe(300);
    expect(s.totalTokens).toBe(2_020);
    expect(s.cacheHitRate).toBeCloseTo(1_000 / 1_800);
  });
});
