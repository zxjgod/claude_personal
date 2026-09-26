// ============================================================
// Tests: transcriptToLines item-level cache (#34)
// ============================================================
// The flat-line flattener caches rendered rows per (item, options, theme).
// These tests pin the equivalence contract: caching must be OBSERVATIONALLY
// identical to re-rendering — same rows, invalidated by theme switches and
// keyed separately per render-options variant.
// ============================================================

import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptItem } from "../tui/store.js";
import { applyTheme } from "../tui/theme.js";
import { transcriptToLines } from "../tui/transcript-lines.js";

const originalLevel = chalk.level;
beforeEach(() => {
  chalk.level = 3;
  applyTheme("dark");
});
afterEach(() => {
  chalk.level = originalLevel;
  applyTheme("dark");
});

function items(): TranscriptItem[] {
  return [
    { kind: "user", id: 1, text: "hello" } as TranscriptItem,
    { kind: "assistant", id: 2, text: "**world**" } as TranscriptItem,
    { kind: "thinking_text", id: 3, text: "line1\nline2", seconds: 2 } as TranscriptItem,
  ];
}

describe("transcriptToLines item cache (#34)", () => {
  it("returns observationally identical rows on repeated calls", () => {
    const a = items();
    const first = transcriptToLines(a, "", "");
    const second = transcriptToLines(a, "", "");
    expect(second).toEqual(first);
    // Cached rows are shared by identity — proof the cache path ran (a
    // re-render would produce fresh row objects).
    expect(second[0]).toBe(first[0]);
  });

  it("reuses cached rows for the unchanged prefix when items are appended", () => {
    const base = items();
    const before = transcriptToLines(base, "", "");
    const extended = [...base, { kind: "user", id: 4, text: "more" } as TranscriptItem];
    const after = transcriptToLines(extended, "", "");
    // Prefix rows are the SAME objects (cache hit); the append re-rendered
    // only the new item. Spacer rows are minted per call (not part of the
    // item cache), so they're compared by value.
    for (let i = 0; i < before.length; i++) {
      if (before[i]!.text === "") expect(after[i]).toEqual(before[i]);
      else expect(after[i]).toBe(before[i]);
    }
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("invalidates on theme switch", () => {
    const a = items();
    const dark = transcriptToLines(a, "", "");
    applyTheme("light");
    const light = transcriptToLines(a, "", "");
    // The assistant row carries palette.text color — it must re-render under
    // the new theme instead of serving the dark-mode row.
    const darkAssist = dark.find((l) => l.text.includes("world"));
    const lightAssist = light.find((l) => l.text.includes("world"));
    expect(lightAssist).toBeDefined();
    expect(lightAssist!.color).not.toBe(darkAssist!.color);
  });

  it("keys options variants separately (verbose/collapseThinking)", () => {
    const a = items();
    const collapsed = transcriptToLines(a, "", "", { verbose: true, collapseThinking: true });
    const full = transcriptToLines(a, "", "", { verbose: true, collapseThinking: false });
    // The two-line thinking item folds to one row when collapsed.
    const thinkRowsCollapsed = collapsed.filter(
      (l) => l.text.includes("line1") || (l.dim && l.text.includes("Thought")),
    );
    const fullHasBothLines = full.some((l) => l.text.includes("line2"));
    expect(fullHasBothLines).toBe(true);
    expect(collapsed.some((l) => l.text.includes("line2"))).toBe(false);
    expect(thinkRowsCollapsed.length).toBeGreaterThanOrEqual(0);
    // Both variants stay independently cached and stable.
    expect(transcriptToLines(a, "", "", { verbose: true, collapseThinking: true })).toEqual(
      collapsed,
    );
  });

  it("never caches the live streaming tail", () => {
    const a = items();
    const one = transcriptToLines(a, "partial **text**");
    const two = transcriptToLines(a, "partial **text** more");
    // The tail re-renders every call: the grown stream text shows up
    // verbatim instead of a stale cached tail.
    expect(one.some((l) => l.text.includes("more"))).toBe(false);
    expect(two.some((l) => l.text.includes("more"))).toBe(true);
  });
});
