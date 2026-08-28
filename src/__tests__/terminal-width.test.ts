// ============================================================
// Tests: terminal-width — visual measurement + column-aware truncation
// ============================================================

import { describe, expect, it } from "vitest";
import { truncateVisual, visualWidth } from "../tui/terminal-width.js";

describe("visualWidth", () => {
  it("counts CJK and fullwidth glyphs as two columns", () => {
    expect(visualWidth("ab")).toBe(2);
    expect(visualWidth("中文")).toBe(4);
    expect(visualWidth("a中b")).toBe(4);
  });

  it("ignores ANSI color sequences", () => {
    expect(visualWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });
});

describe("truncateVisual (P3-15)", () => {
  it("returns short strings unchanged (no ellipsis)", () => {
    expect(truncateVisual("hello", 10)).toBe("hello");
    expect(truncateVisual("", 10)).toBe("");
  });

  it("truncates ASCII to max-1 chars plus the ellipsis", () => {
    expect(truncateVisual("abcdefghij", 8)).toBe("abcdefg…");
  });

  it("measures CJK by display columns, never splitting a wide glyph", () => {
    // 4 CJK chars = 8 columns; budget 6 → keep 2 chars (4 cols) + ellipsis.
    expect(truncateVisual("中文中文", 6)).toBe("中文…");
    // Budget 5 → still only 2 chars fit (3 chars would need 7 columns incl. …).
    expect(truncateVisual("中文中文", 5)).toBe("中文…");
  });

  it("never exceeds the requested column budget", () => {
    const cases = ["中文中文中文", "abcdefabcdef", "混合mixed文本text"];
    for (const s of cases) {
      for (const max of [3, 5, 7, 9]) {
        expect(visualWidth(truncateVisual(s, max))).toBeLessThanOrEqual(max);
      }
    }
  });

  it("returns empty for degenerate budgets (matching the old helpers)", () => {
    expect(truncateVisual("anything", 0)).toBe("");
    expect(truncateVisual("anything", 1)).toBe("");
  });

  it("keeps surrogate pairs and emoji whole", () => {
    expect(truncateVisual("🎉🎉🎉", 5)).toBe("🎉🎉…"); // emoji are 2 cols each
  });
});
