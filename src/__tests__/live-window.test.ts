// ============================================================
// Tests: live-window — the frame-height invariant guard
// ============================================================
// Regression cover for the "● same line repeated 50×" bug: when the live frame
// grew taller than the terminal, Ink's eraseLines couldn't retract it (cursor
// clamps at the viewport top) and every redraw leaked the frame's top line into
// the scrollback. tailVisualLines windows the stream regions to a tail that
// always fits the viewport.
// ============================================================

import { describe, expect, it } from "vitest";
import { tailVisualLines } from "../tui/live-window.js";

const W = 40; // pretend the body column wraps at 40 columns

describe("tailVisualLines", () => {
  it("returns short text untouched (hiddenLines 0)", () => {
    const r = tailVisualLines("hello world", 5, W);
    expect(r.text).toBe("hello world");
    expect(r.hiddenLines).toBe(0);
  });

  it("returns text that exactly fills the budget untouched", () => {
    const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    const r = tailVisualLines(text, 5, W);
    expect(r.text).toBe(text);
    expect(r.hiddenLines).toBe(0);
  });

  it("windows a long multi-line stream to its tail", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const r = tailVisualLines(text, 5, W);
    expect(r.text).toBe(["line 15", "line 16", "line 17", "line 18", "line 19"].join("\n"));
    expect(r.hiddenLines).toBe(15);
  });

  it("counts wrapped lines, not just logical lines", () => {
    // One logical line of 160 cols wraps to 4 visual lines at width 40.
    const long = "x".repeat(160);
    const r = tailVisualLines(`head\n${long}`, 5, W);
    // head(1) + long(4) = 5 → fits exactly, no truncation.
    expect(r.hiddenLines).toBe(0);
    const r2 = tailVisualLines(`head\n${long}`, 4, W);
    expect(r2.hiddenLines).toBeGreaterThan(0);
    expect(r2.text).not.toContain("head");
  });

  it("cuts the character tail of a single too-long line", () => {
    const long = "0123456789".repeat(20); // 200 cols → 5 visual lines at W=40
    const r = tailVisualLines(long, 2, W);
    // Keeps the last ~2 visual lines worth of characters, re-wrapped at W.
    const wrappedLines = r.text.split("\n");
    expect(wrappedLines.length).toBeLessThanOrEqual(2);
    expect(wrappedLines.every((l) => l.length <= W)).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
    expect(long.endsWith(r.text.replace("\n", ""))).toBe(true);
    expect(r.hiddenLines).toBeGreaterThanOrEqual(3);
  });

  it("treats CJK characters as double-width when cutting", () => {
    const cjk = "汉".repeat(60); // 120 visual cols → 3 lines at W=40
    const r = tailVisualLines(cjk, 1, W);
    // One visual line at width 40 = 20 CJK chars; never splits a character.
    expect(Array.from(r.text).length).toBeLessThanOrEqual(20);
    expect(r.text).toBe("汉".repeat(Array.from(r.text).length));
  });

  it("never returns an empty window while text remains", () => {
    const r = tailVisualLines("a\nb\nc", 1, W);
    expect(r.text).toBe("c");
    expect(r.hiddenLines).toBe(2);
  });

  it("handles empty input", () => {
    const r = tailVisualLines("", 5, W);
    expect(r.text).toBe("");
    expect(r.hiddenLines).toBe(0);
  });
});
