// ============================================================
// live-window — bound the live region to the terminal viewport
// ============================================================
// Ink's live-region redraw erases the PREVIOUS frame by counting its raw "\n"s
// (log-update eraseLines). Two terminal realities break that math when the
// frame is tall or wide:
//   • cursor-up clamps at the top of the viewport — an over-tall frame can
//     never be fully retracted, so every redraw leaks its top lines into the
//     scrollback (the "same ● line repeated 50×" symptom);
//   • on Windows consoles, writing the bottom-right cell scrolls immediately
//     (Ink #969), and any raw line wider than the terminal wraps mid-frame —
//     both desync the erase count.
// The invariant this module protects:
//
//     live frame height  ≤  stdout.rows   AND   raw line width  <  stdout.cols
//
// tailVisualLines windows a growing stream to a tail that satisfies both: it
// re-wraps the kept tail into lines NARROWER than the content column, so Ink
// never re-wraps them (wrap-ansi's trim:false boundary-space inflation can
// otherwise push a wrapped segment past the terminal width). The regions in
// App.tsx additionally clip with maxHeight+overflowY="hidden" as a hard
// geometric backstop for markdown constructs (tables, code blocks) whose
// rendered height can't be predicted from the raw text.
//
// Full content is never lost: it lives in the store and is committed to the
// write-once <Static> transcript at commit time; while streaming, the PgUp
// pager shows the whole thing.
// ============================================================

import { visualWidth } from "./terminal-width.js";

/**
 * Rows reserved around the streaming window: status line (1) + todo list (≤5) +
 * active tools (≤4) + input box (3) + status bar (1) + margins (2). The caps in
 * App.tsx keep those regions inside this budget, so streaming gets rows − 16.
 */
export const LIVE_CHROME_ROWS = 16;

/** Min column width we ever wrap at (tiny terminals / tests). */
const MIN_COL_WIDTH = 20;

/** Estimated visual height of one logical line wrapped at `colWidth`. Used only
 *  for the fits-check fast path and the hiddenLines estimate; the kept tail is
 *  re-wrapped explicitly, so its rendered height is exact. */
function lineCost(line: string, colWidth: number): number {
  return Math.max(1, Math.ceil(visualWidth(line) / colWidth));
}

/**
 * Greedy word wrap of a single logical line at `width` columns. Breaks at the
 * last space when possible (dropping it — matches trim:true semantics so no
 * boundary-space inflation), otherwise breaks a long word at the character
 * boundary. Never splits a surrogate pair or a wide glyph.
 */
function hardWrapLine(line: string, width: number): string[] {
  if (visualWidth(line) <= width) return [line];
  const cps = Array.from(line);
  const out: string[] = [];
  let cur: string[] = [];
  let curW = 0;
  // Code-point index (within cur) + width of the last breakable space.
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
    const w = visualWidth(ch);
    if (curW + w > width) {
      if (lastSpace >= 0 && lastSpace < cur.length - 1) {
        // Break at the last space: emit what precedes it, continue with the
        // word tail (the space itself is dropped).
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

/** Hard-wrap every logical line of `text` at `width`, preserving blank lines. */
function hardWrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") out.push("");
    else out.push(...hardWrapLine(line, width));
  }
  return out;
}

export interface TailWindow {
  /** The trailing slice of `text`, re-wrapped to ≤ `colWidth` columns. */
  text: string;
  /** Estimated number of visual lines hidden above the window (0 = untruncated). */
  hiddenLines: number;
}

/**
 * Window `text` to its LAST `maxLines` visual lines, re-wrapped at `colWidth`
 * columns (pass a width a few columns NARROWER than the real content column so
 * Ink never re-wraps the result). Cuts mid-line when the tail starts inside a
 * long logical line. Never invents content: `hiddenLines > 0` signals an
 * elision hint should be shown.
 */
export function tailVisualLines(text: string, maxLines: number, colWidth: number): TailWindow {
  const width = Math.max(MIN_COL_WIDTH, colWidth);
  const lines = text.split("\n");

  // Fast path: everything fits as-is AND no line needs re-wrapping — no
  // allocation churn per frame. A line wider than `width` must NOT pass
  // through raw: Ink would wrap it at the real (wider) column and wrap-ansi's
  // trim:false keeps the boundary space, emitting a raw line past the
  // terminal width that wraps mid-frame and desyncs the erase count.
  let total = 0;
  let anyWide = false;
  for (const l of lines) {
    total += lineCost(l, width);
    if (!anyWide && visualWidth(l) > width) anyWide = true;
  }
  if (total <= maxLines && !anyWide) return { text, hiddenLines: 0 };

  if (total <= maxLines) {
    // Fits height-wise but has wide lines: re-wrap the whole text, keep all.
    return { text: hardWrap(text, width).join("\n"), hiddenLines: 0 };
  }

  // Take a generous raw tail before wrapping: CJK text can need up to
  // width/2 characters per visual line, so ×2 character headroom guarantees
  // the wrapped tail still covers maxLines.
  const charBudget = maxLines * width * 2;
  let budget = 0;
  let start = lines.length;
  while (start > 0) {
    const w = visualWidth(lines[start - 1]!);
    if (budget + w > charBudget && start < lines.length) break;
    budget += w;
    start--;
  }
  let tail = lines.slice(start).join("\n");
  if (start === 0 && budget > charBudget) {
    // A single logical line exceeds the whole budget — cut its character tail.
    const cps = Array.from(tail);
    let w = 0;
    let cut = cps.length;
    while (cut > 0) {
      const cw = visualWidth(cps[cut - 1]!);
      if (w + cw > charBudget) break;
      w += cw;
      cut--;
    }
    tail = cps.slice(cut).join("");
  }

  const wrapped = hardWrap(tail, width);
  const kept = wrapped.slice(-maxLines);
  const hiddenLines = Math.max(1, total - kept.length);
  return { text: kept.join("\n"), hiddenLines };
}
