// ============================================================
// Tests: CLI spinner (thinking animation)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  computeGlimmerIndex,
  computeShimmerSegments,
  formatDuration,
  formatTokens,
  SPINNER_VERBS,
  Spinner,
} from "../tui/cli-spinner.js";

describe("SPINNER_VERBS", () => {
  it("includes the canonical gerunds and ends in -ing", () => {
    expect(SPINNER_VERBS).toContain("Whisking");
    expect(SPINNER_VERBS).toContain("Pondering");
    expect(SPINNER_VERBS.length).toBeGreaterThan(20);
    for (const v of SPINNER_VERBS) {
      expect(v).toMatch(/ing$/);
    }
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(16_000)).toBe("16s");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(120_000)).toBe("2m");
  });
});

describe("formatTokens", () => {
  it("formats counts with k suffix", () => {
    expect(formatTokens(144)).toBe("144");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(15_000)).toBe("15k");
  });
});

describe("computeShimmerSegments", () => {
  it("splits the message into before/shimmer/after by column", () => {
    const text = "Whisking…";
    const width = text.length;
    const glimmer = computeGlimmerIndex(0, width);
    const { before, shimmer, after } = computeShimmerSegments(text, glimmer);
    // Concatenation must reconstruct the original text.
    expect(before + shimmer + after).toBe(text);
  });

  it("returns all text as 'before' when shimmer is offscreen", () => {
    const text = "Working…";
    const { before, shimmer, after } = computeShimmerSegments(text, 999);
    expect(before).toBe(text);
    expect(shimmer).toBe("");
    expect(after).toBe("");
  });
});

describe("Spinner", () => {
  it("is inactive on a non-TTY stream and never throws", () => {
    const fake = {
      isTTY: false,
      write: () => true,
    } as unknown as NodeJS.WriteStream;
    const s = new Spinner({ out: fake });
    s.start();
    expect(s.isActive).toBe(false);
    s.update({ tokens: 100 });
    s.stop();
  });

  it("tracks tokens via update (monotonic)", () => {
    const fake = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
    const s = new Spinner({ out: fake });
    s.update({ tokens: 50 });
    s.update({ tokens: 10 }); // lower value ignored
    // No public getter; just assert it doesn't throw and stays stable.
    expect(s.isActive).toBe(false);
  });
});
