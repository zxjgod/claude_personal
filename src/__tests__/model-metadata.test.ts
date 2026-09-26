// ============================================================
// Tests: model metadata table (Top10 follow-up #23)
// ============================================================
// The single source of truth for context windows, output caps, capability
// flags and pricing. These rows drive: effort gating (A5 — a wrong "true" is
// a hard 400 on Sonnet/Haiku 4.5), reasoning request shaping (A12), the
// model-derived compaction thresholds (#24) and /cost + /context gauges.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  isOpenAIReasoningModel,
  lookupModelMetadata,
  modelContextWindow,
  modelMaxOutput,
  modelPricing,
  modelSupportsAdaptiveThinking,
  modelSupportsEffort,
} from "../model-metadata.js";

describe("model metadata lookups", () => {
  it("knows the current Anthropic flagship rows (1M window, 128K output)", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-5", "claude-fable-5"]) {
      expect(modelContextWindow(id), id).toBe(1_000_000);
      expect(modelMaxOutput(id), id).toBe(128_000);
      expect(modelSupportsEffort(id), id).toBe(true);
      expect(modelSupportsAdaptiveThinking(id), id).toBe(true);
    }
  });

  it("gates effort OFF for the models where it is a documented 400", () => {
    expect(modelSupportsEffort("claude-sonnet-4-5")).toBe(false);
    expect(modelSupportsEffort("claude-haiku-4-5")).toBe(false);
    expect(modelSupportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(modelSupportsAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
  });

  it("resolves dated snapshots through the family substring", () => {
    expect(modelContextWindow("claude-opus-4-8-20260101")).toBe(1_000_000);
    expect(modelSupportsEffort("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("keeps legacy families on conservative values", () => {
    expect(modelContextWindow("claude-opus-4-1")).toBe(200_000);
    expect(modelSupportsEffort("claude-opus-4-1")).toBe(false);
    expect(modelPricing("claude-opus-4-1")).toEqual({ input: 15, output: 75 });
    expect(modelPricing("claude-opus-4-8")).toEqual({ input: 5, output: 25 });
  });

  it("matches gpt-4o-mini before gpt-4o before gpt-4 (specificity order)", () => {
    expect(modelContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(modelPricing("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
    expect(modelPricing("gpt-4o")).toEqual({ input: 2.5, output: 10 });
    expect(modelContextWindow("gpt-4")).toBe(8_192);
  });

  it("prefix-anchors the o-series so unrelated ids don't match", () => {
    expect(isOpenAIReasoningModel("o3-mini")).toBe(true);
    expect(isOpenAIReasoningModel("o4-mini")).toBe(true);
    expect(isOpenAIReasoningModel("o1")).toBe(true);
    // substring "o1"/"o3" inside other ids must NOT flag them as reasoning
    expect(isOpenAIReasoningModel("moonshot-v1-o1x")).toBe(false);
    expect(isOpenAIReasoningModel("gpt-4o")).toBe(false);
  });

  it("marks third-party reasoners for reasoning_effort but keeps windows", () => {
    expect(isOpenAIReasoningModel("deepseek-reasoner")).toBe(true);
    expect(isOpenAIReasoningModel("deepseek-chat")).toBe(false);
    expect(modelContextWindow("deepseek-chat")).toBe(64_000);
    expect(modelContextWindow("qwen-plus")).toBe(131_072);
  });

  it("returns null/false for unknown models (fail-closed consumers)", () => {
    expect(lookupModelMetadata("totally-unknown-model")).toBeNull();
    expect(lookupModelMetadata(undefined)).toBeNull();
    expect(modelContextWindow("llama3")).toBeNull();
    expect(modelSupportsEffort("llama3")).toBe(false);
    expect(modelPricing("llama3")).toBeNull();
  });

  it("the default Anthropic model itself is a known effort+thinking model", () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-opus-4-8");
    expect(modelSupportsEffort(DEFAULT_ANTHROPIC_MODEL)).toBe(true);
    expect(modelSupportsAdaptiveThinking(DEFAULT_ANTHROPIC_MODEL)).toBe(true);
  });

  // --- review follow-ups #1/#2: substring-match coverage gaps ---

  it("long-context gpt-4.x variants are NOT swallowed by the 8K gpt-4 row (#1)", () => {
    // The bare gpt-4 row is a substring match — without the more-specific
    // rows ahead of it, turbo/4.1/4.5 were judged 8K windows and the derived
    // compaction threshold fired every ~7K tokens.
    expect(modelContextWindow("gpt-4-turbo")).toBe(128_000);
    expect(modelContextWindow("gpt-4-turbo-2024-04-09")).toBe(128_000);
    expect(modelContextWindow("gpt-4.1")).toBe(1_047_576);
    expect(modelContextWindow("gpt-4.1-mini")).toBe(1_047_576);
    expect(modelContextWindow("gpt-4.5-preview")).toBe(128_000);
    expect(modelContextWindow("gpt-4-32k")).toBe(32_768);
    // The plain 8K row still serves the actual legacy ids.
    expect(modelContextWindow("gpt-4")).toBe(8_192);
    expect(modelContextWindow("gpt-4-0613")).toBe(8_192);
  });

  it("dated legacy claude ids resolve instead of falling through to null (#2)", () => {
    // These ids do NOT contain the "claude-sonnet"/"claude-haiku"/"claude-opus"
    // substrings — without dedicated rows the lookup returned null and the
    // adapters' maxOutput clamp silently no-oped (LLM_MAX_TOKENS=32000 would
    // go out raw and 400 on an 8K-output model).
    expect(lookupModelMetadata("claude-3-5-sonnet-20241022")).not.toBeNull();
    expect(modelMaxOutput("claude-3-5-sonnet-20241022")).toBe(8_192);
    expect(modelContextWindow("claude-3-7-sonnet-20250219")).toBe(200_000);
    expect(modelMaxOutput("claude-3-7-sonnet-20250219")).toBe(64_000);
    expect(modelMaxOutput("claude-3-5-haiku-20241022")).toBe(8_192);
    expect(modelMaxOutput("claude-3-opus-20240229")).toBe(4_096);
    expect(modelMaxOutput("claude-3-haiku-20240307")).toBe(4_096);
    // Effort stays gated OFF for every legacy row (it is a 4.5+/4.6+ feature).
    expect(modelSupportsEffort("claude-3-7-sonnet-20250219")).toBe(false);
    expect(modelSupportsAdaptiveThinking("claude-3-5-sonnet-20241022")).toBe(false);
  });
});
