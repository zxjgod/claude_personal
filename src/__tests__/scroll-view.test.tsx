// ============================================================
// Tests: ScrollView windowing + full-screen layout (M25.2)
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { bottomScrollTop, clampScrollTop, ScrollView, visibleWindow } from "../tui/ScrollView.js";
import type { TranscriptItem } from "../tui/store.js";
import { transcriptToLines } from "../tui/transcript-lines.js";

describe("ScrollView windowing math", () => {
  it("visibleWindow returns the slice for a given scrollTop", () => {
    // 100 lines, viewport 10, scrolled to 30 → rows [30, 40).
    expect(visibleWindow(100, 10, 30)).toEqual({ start: 30, end: 40 });
  });

  it("visibleWindow clamps scrollTop past the bottom", () => {
    // 100 lines, viewport 10 → max top is 90. Asking for 200 clamps to 90.
    expect(visibleWindow(100, 10, 200)).toEqual({ start: 90, end: 100 });
  });

  it("visibleWindow handles content shorter than the viewport", () => {
    expect(visibleWindow(3, 10, 0)).toEqual({ start: 0, end: 3 });
  });

  it("clampScrollTop bounds into [0, maxTop]", () => {
    expect(clampScrollTop(100, 10, -5)).toBe(0);
    expect(clampScrollTop(100, 10, 50)).toBe(50);
    expect(clampScrollTop(100, 10, 999)).toBe(90);
  });

  it("bottomScrollTop pins to the last viewport-height of content", () => {
    expect(bottomScrollTop(100, 10)).toBe(90);
    expect(bottomScrollTop(5, 10)).toBe(0); // fits → no scroll
  });
});

describe("ScrollView rendering", () => {
  it("renders only the visible window of lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<ScrollView lines={lines} height={5} scrollTop={10} />);
    const frame = lastFrame()!;
    expect(frame).toContain("line-10");
    expect(frame).toContain("line-14");
    expect(frame).not.toContain("line-9");
    expect(frame).not.toContain("line-15");
  });

  it("pads short content to the fixed viewport height", () => {
    const { lastFrame } = render(<ScrollView lines={["only"]} height={5} scrollTop={0} />);
    // 5 rows tall even with one line of content (4 padding rows).
    expect(lastFrame()!.split("\n").length).toBe(5);
  });
});

describe("transcriptToLines", () => {
  it("flattens user / assistant / tool items to text rows", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: 1, text: "hello" },
      { kind: "assistant", id: 2, text: "hi there" },
      {
        kind: "tool",
        id: 3,
        name: "read",
        detail: "a.ts",
        result: { toolName: "read", formatted: "file body", error: undefined } as never,
      },
    ];
    const lines = transcriptToLines(items, "");
    expect(lines[0]).toBe("> hello");
    expect(lines.some((l) => l.startsWith("● hi there") || l.includes("hi there"))).toBe(true);
    expect(lines.some((l) => l.includes("Read") && l.includes("a.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("file body"))).toBe(true);
  });

  it("appends the in-flight streaming text as an assistant block", () => {
    const lines = transcriptToLines([], "streaming now");
    expect(lines.some((l) => l.includes("streaming now"))).toBe(true);
  });
});
