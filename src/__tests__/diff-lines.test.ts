// ============================================================
// Tests: diff display lines — absolute line numbers for the TUI gutter
// ============================================================
// The model-facing diff (generateSimpleDiff) must stay byte-identical: it is
// the tool result the model reads. diffDisplayLines is the display-only
// companion that adds positions, so most of these cases assert that the two
// agree on the CHANGES while only the latter carries numbers.
// ============================================================

import { describe, expect, it } from "vitest";
import { diffDisplayLines, generateSimpleDiff } from "../tools/utils/diff.js";

describe("generateSimpleDiff (model-facing format is unchanged)", () => {
  it("emits `- old` / `+ new` with no line numbers or hunk headers", () => {
    expect(generateSimpleDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma")).toBe("- beta\n+ BETA");
  });

  it("reports a whitespace-only change", () => {
    expect(generateSimpleDiff("same", "same")).toBe("(whitespace-only change)");
  });
});

describe("diffDisplayLines", () => {
  it("numbers a one-line replacement in both files", () => {
    // "beta" is line 2 of the old fragment and "BETA" is line 2 of the new one;
    // with the region starting at file line 10 that is line 11 either way.
    const lines = diffDisplayLines("alpha\nbeta\ngamma", "alpha\nBETA\ngamma", 10);
    expect(lines).toEqual([
      { sign: "-", text: "beta", line: 11 },
      { sign: "+", text: "BETA", line: 11 },
    ]);
  });

  it("numbers an insertion against the EDITED file", () => {
    const lines = diffDisplayLines("a\nb", "a\nNEW\nb", 1);
    expect(lines).toEqual([{ sign: "+", text: "NEW", line: 2 }]);
  });

  it("keeps positions accurate across the unchanged lines the diff SKIPS", () => {
    // a/b/c are common and never rendered, but the walk still advances through
    // them — counting only the rendered lines would report line 1 here.
    const lines = diffDisplayLines("a\nb\nc\nd", "a\nb\nc\nD", 1);
    expect(lines).toEqual([
      { sign: "-", text: "d", line: 4 },
      { sign: "+", text: "D", line: 4 },
    ]);
  });

  it("carries the same changes as the model-facing diff", () => {
    const oldStr = "one\ntwo\nthree\nfour";
    const newStr = "one\nTWO\nthree\nFOUR";
    const display = diffDisplayLines(oldStr, newStr, 1).map((d) => `${d.sign} ${d.text}`);
    expect(display.join("\n")).toBe(generateSimpleDiff(oldStr, newStr));
  });

  it("defaults the region to line 1", () => {
    expect(diffDisplayLines("x", "y")[0]!.line).toBe(1);
  });

  it("returns nothing when there is no change", () => {
    expect(diffDisplayLines("same", "same")).toEqual([]);
  });
});
