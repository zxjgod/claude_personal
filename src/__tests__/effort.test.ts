// ============================================================
// Tests: reasoning effort tiers (/effort)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  anthropicEffort,
  DEFAULT_EFFORT,
  EFFORT_GRADIENT,
  EFFORT_LEVELS,
  effortInstruction,
  effortStrategy,
  getEffort,
  getEffortStrategy,
  gradientColorAt,
  hslToHex,
  modelSupportsReasoningEffort,
  openaiReasoningEffort,
  parseEffort,
  rainbowColors,
  renderEffortSlider,
  resolveEffortMaxTokens,
} from "../tui/effort.js";

describe("effort tiers", () => {
  it("exposes the low→max gradient plus ultracode", () => {
    expect(EFFORT_GRADIENT).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(EFFORT_LEVELS).toContain("ultracode");
    expect(DEFAULT_EFFORT).toBe("high");
  });

  it("parseEffort accepts valid tiers case-insensitively and rejects others", () => {
    expect(parseEffort("XHigh")).toBe("xhigh");
    expect(parseEffort(" max ")).toBe("max");
    expect(parseEffort("ultracode")).toBe("ultracode");
    expect(parseEffort("turbo")).toBeNull();
    expect(parseEffort("")).toBeNull();
  });

  it("getEffort falls back to the default for missing/invalid values", () => {
    expect(getEffort(undefined)).toBe("high");
    expect(getEffort({})).toBe("high");
    expect(getEffort({ effort: "low" })).toBe("low");
    expect(getEffort({ effort: "bogus" })).toBe("high");
  });

  it("gives every tier a distinct, progressively deeper runtime strategy", () => {
    const strategies = EFFORT_LEVELS.map((level) => effortStrategy(level));
    expect(new Set(strategies.map((s) => s.maxOutputTokens)).size).toBe(EFFORT_LEVELS.length);
    expect(strategies.map((s) => s.maxOutputTokens)).toEqual([
      4096, 6144, 8192, 12288, 16384, 24576,
    ]);
    expect(strategies.map((s) => s.toolConcurrency)).toEqual([3, 5, 8, 10, 12, 16]);
    expect(strategies[0]?.speculation).toBe(false);
    expect(strategies.slice(1).every((s) => s.speculation)).toBe(true);
    expect(effortInstruction("ultracode")).toContain("workflow tool");
    expect(getEffortStrategy({ effort: "xhigh" }).instruction).toContain(
      "alternative explanations",
    );
    expect(resolveEffortMaxTokens("max")).toBe(16384);
    expect(resolveEffortMaxTokens("max", 4096)).toBe(4096);
  });

  it("anthropicEffort passes the gradient through and maps ultracode→xhigh", () => {
    expect(anthropicEffort("low")).toBe("low");
    expect(anthropicEffort("max")).toBe("max");
    expect(anthropicEffort("ultracode")).toBe("xhigh");
  });

  it("resolveEffortMaxTokens: explicit override may RAISE, capped at the 128K streaming ceiling", () => {
    // Top10 follow-up A6 (user decision 2026-09): LLM_MAX_TOKENS is
    // authoritative — raising it lifts the tier caps (high = 8192) that made
    // long outputs routinely take the slow truncate→continue path.
    expect(resolveEffortMaxTokens("high", 64_000)).toBe(64_000);
    expect(resolveEffortMaxTokens("high", 131_072)).toBe(131_072);
    expect(resolveEffortMaxTokens("high", 500_000)).toBe(131_072); // hard ceiling
    // Lowering still works; no override keeps the tier default; garbage falls
    // back to the tier default.
    expect(resolveEffortMaxTokens("high", 1000)).toBe(1000);
    expect(resolveEffortMaxTokens("high")).toBe(8192);
    expect(resolveEffortMaxTokens("high", Number.NaN)).toBe(8192);
    expect(resolveEffortMaxTokens("high", 0)).toBe(8192);
  });

  it("openaiReasoningEffort clamps at/above high to 'high'", () => {
    expect(openaiReasoningEffort("low")).toBe("low");
    expect(openaiReasoningEffort("medium")).toBe("medium");
    expect(openaiReasoningEffort("high")).toBe("high");
    expect(openaiReasoningEffort("xhigh")).toBe("high");
    expect(openaiReasoningEffort("max")).toBe("high");
    expect(openaiReasoningEffort("ultracode")).toBe("high");
  });

  it("modelSupportsReasoningEffort detects reasoning models only", () => {
    expect(modelSupportsReasoningEffort("openai", "o3")).toBe(true);
    expect(modelSupportsReasoningEffort("openai", "gpt-4o")).toBe(false);
    expect(modelSupportsReasoningEffort("deepseek", "deepseek-reasoner")).toBe(true);
    expect(modelSupportsReasoningEffort("deepseek", "deepseek-chat")).toBe(false);
    expect(modelSupportsReasoningEffort("qwen", "qwq-32b")).toBe(true);
  });

  it("renderEffortSlider marks the active tier", () => {
    const out = renderEffortSlider("xhigh");
    expect(out).toContain("Effort");
    expect(out).toContain("xhigh");
    expect(out).toContain("Faster");
    expect(out).toContain("Smarter");
    expect(out).toContain("Current: ");
  });

  it("hslToHex produces valid 6-digit hex", () => {
    expect(hslToHex(0, 1, 0.5)).toMatch(/^#[0-9a-f]{6}$/);
    expect(hslToHex(190, 0.8, 0.6)).toMatch(/^#[0-9a-f]{6}$/);
    expect(hslToHex(720, 0.5, 0.5)).toMatch(/^#[0-9a-f]{6}$/); // wraps
  });

  it("gradientColorAt clamps and shifts cool→warm", () => {
    const cold = gradientColorAt(0);
    const hot = gradientColorAt(1);
    expect(cold).toMatch(/^#[0-9a-f]{6}$/);
    expect(hot).toMatch(/^#[0-9a-f]{6}$/);
    expect(cold).not.toBe(hot);
    // out-of-range clamps rather than throwing
    expect(gradientColorAt(-5)).toBe(cold);
    expect(gradientColorAt(5)).toBe(hot);
  });

  it("rainbowColors returns N distinct colors that shift with phase", () => {
    const a = rainbowColors(9, 0);
    const b = rainbowColors(9, 40);
    expect(a).toHaveLength(9);
    expect(a.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(a[0]).not.toBe(b[0]); // phase shift changes hue
  });
});
