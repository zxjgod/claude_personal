// ============================================================
// Tests: live-window — the frame-height invariant guard
// ============================================================
// Regression cover for the "● same line repeated 50×" bug: when the live frame
// grew taller than the terminal, Ink's eraseLines couldn't retract it (cursor
// clamps at the viewport top) and every redraw leaked the frame's top line into
// the scrollback. tailVisualLines windows the stream regions to a tail that
// always fits the viewport.
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import { __clearLiveWindowCacheForTests, tailVisualLines } from "../tui/live-window.js";
import { visualWidth } from "../tui/terminal-width.js";

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

  it("never emits an empty line when breaking at a leading space", () => {
    // A space at the wrap boundary with no preceding content would emit an
    // empty segment if the space-break path fired at index 0.
    const r = tailVisualLines(" " + "x".repeat(90), 5, W); // 91 cols at W=40
    for (const line of r.text.split("\n")) {
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("counts tabs as width 4 so tabbed code cannot exceed the width bound", () => {
    // 10 tabs + 40 chars: naive width 50 > 40 → must wrap; with tab=0 the
    // line would pass through at 40 visible + 10 zero-width tabs and the
    // terminal would render it wider than the budget.
    const r = tailVisualLines("\t".repeat(10) + "y".repeat(40), 5, W);
    expect(r.text).toContain("\n"); // wrapped
    // Every emitted line stays within the budget when tabs render as ≤4.
    for (const line of r.text.split("\n")) {
      let w = 0;
      for (const ch of line) w += ch === "\t" ? 4 : 1;
      expect(w).toBeLessThanOrEqual(W);
    }
  });
});

// ============================================================
// #35 equivalence fuzz: the incremental prefix cache must be
// observationally IDENTICAL to the original full-scan algorithm.
// The reference below is a verbatim copy of the pre-#35
// implementation; random append-only streams (ASCII/CJK/tabs/
// blanks/long words, mixed widths) are fed to both and compared.
// ============================================================

const MIN_COL_WIDTH_REF = 20;
const cellWidthRef = (ch: string): number => (ch === "\t" ? 4 : visualWidth(ch));
function measureWidthRef(s: string): number {
  let w = 0;
  for (const ch of s) w += cellWidthRef(ch);
  return w;
}
function lineCostRef(line: string, colWidth: number): number {
  return Math.max(1, Math.ceil(measureWidthRef(line) / colWidth));
}
function hardWrapLineRef(line: string, width: number): string[] {
  if (measureWidthRef(line) <= width) return [line];
  const cps = Array.from(line);
  const out: string[] = [];
  let cur: string[] = [];
  let curW = 0;
  let lastSpace = -1;
  let wAfterSpace = 0;
  const flush = () => {
    out.push(cur.join(""));
    cur = [];
    curW = 0;
    lastSpace = -1;
    wAfterSpace = 0;
  };
  for (const ch of cps) {
    const w = cellWidthRef(ch);
    if (curW + w > width) {
      if (lastSpace > 0 && lastSpace < cur.length - 1) {
        out.push(cur.slice(0, lastSpace).join(""));
        cur = cur.slice(lastSpace + 1);
        curW = wAfterSpace;
      } else if (cur.length > 0) {
        flush();
      }
      lastSpace = -1;
      wAfterSpace = 0;
    }
    cur.push(ch);
    curW += w;
    if (ch === " ") {
      lastSpace = cur.length - 1;
      wAfterSpace = 0;
    } else if (lastSpace >= 0) {
      wAfterSpace += w;
    }
  }
  if (cur.length > 0 || out.length === 0) out.push(cur.join(""));
  return out;
}
function hardWrapRef(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") out.push("");
    else out.push(...hardWrapLineRef(line, width));
  }
  return out;
}
/** Verbatim pre-#35 tailVisualLines (no cache). */
function referenceTail(text: string, maxLines: number, colWidth: number) {
  const width = Math.max(MIN_COL_WIDTH_REF, colWidth);
  const lines = text.split("\n");
  let total = 0;
  let anyWide = false;
  for (const l of lines) {
    total += lineCostRef(l, width);
    if (!anyWide && measureWidthRef(l) > width) anyWide = true;
  }
  if (total <= maxLines && !anyWide) return { text, hiddenLines: 0 };
  if (total <= maxLines) {
    return { text: hardWrapRef(text, width).join("\n"), hiddenLines: 0 };
  }
  const charBudget = maxLines * width * 2;
  let budget = 0;
  let start = lines.length;
  while (start > 0) {
    const w = measureWidthRef(lines[start - 1]!);
    if (budget + w > charBudget && start < lines.length) break;
    budget += w;
    start--;
  }
  let tail = lines.slice(start).join("\n");
  if (start === 0 && budget > charBudget) {
    const cps = Array.from(tail);
    let w = 0;
    let cut = cps.length;
    while (cut > 0) {
      const cw = cellWidthRef(cps[cut - 1]!);
      if (w + cw > charBudget) break;
      w += cw;
      cut--;
    }
    tail = cps.slice(cut).join("");
  }
  const wrapped = hardWrapRef(tail, width);
  const kept = wrapped.slice(-maxLines);
  const hiddenLines = Math.max(1, total - kept.length);
  return { text: kept.join("\n"), hiddenLines };
}

/** Deterministic LCG so a fuzz failure is reproducible from the seed. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("tailVisualLines prefix cache — old/new equivalence fuzz (#35)", () => {
  beforeEach(() => __clearLiveWindowCacheForTests());

  const CHUNKS = [
    "a",
    "word ",
    "hello world ",
    "x".repeat(60),
    "你好世界",
    "\t",
    "\n",
    "\n\n",
    " ",
    "line of code();\n",
    "émoji 🚀 trail ",
    "y".repeat(120),
  ];

  for (const seed of [1, 7, 42, 999]) {
    it(`matches the reference on random append-only streams (seed ${seed})`, () => {
      const rng = makeRng(seed);
      const widths = [20, 23, 40, 77];
      let text = "";
      for (let step = 0; step < 60; step++) {
        // Append 1-3 random chunks (append-only, like a streaming turn).
        const n = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) text += CHUNKS[Math.floor(rng() * CHUNKS.length)];
        const width = widths[Math.floor(rng() * widths.length)]!;
        const maxLines = 1 + Math.floor(rng() * 12);
        const actual = tailVisualLines(text, maxLines, width);
        const expected = referenceTail(text, maxLines, width);
        expect(actual, `seed ${seed} step ${step} width ${width} maxLines ${maxLines}`).toEqual(
          expected,
        );
        // Occasionally simulate a fresh turn / process: the cache must re-seed
        // and stay exact.
        if (rng() < 0.1) {
          text = "";
          __clearLiveWindowCacheForTests();
        }
      }
    });
  }

  it("stays exact when the SAME width alternates between two texts", () => {
    // The two live regions share the cache map; alternating texts with a
    // shared width must miss (startsWith) and still return reference output.
    let a = "alpha stream ";
    let b = "beta 汉 stream ";
    for (let i = 0; i < 30; i++) {
      a += `chunk${i} `;
      b += `块${i} `;
      expect(tailVisualLines(a, 5, 40)).toEqual(referenceTail(a, 5, 40));
      expect(tailVisualLines(b, 6, 40)).toEqual(referenceTail(b, 6, 40));
    }
  });
});
