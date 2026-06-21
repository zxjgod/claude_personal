// ============================================================
// Tests: reasoning effort tiers (/effort)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  EFFORT_GRADIENT,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  parseEffort,
  getEffort,
  anthropicEffort,
  openaiReasoningEffort,
  modelSupportsReasoningEffort,
  renderEffortSlider,
  hslToHex,
  gradientColorAt,
  rainbowColors,
} from "../effort.js";

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

  it("anthropicEffort passes the gradient through and maps ultracode→xhigh", () => {
    expect(anthropicEffort("low")).toBe("low");
    expect(anthropicEffort("max")).toBe("max");
    expect(anthropicEffort("ultracode")).toBe("xhigh");
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
