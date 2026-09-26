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
 * Width of one code point for wrapping. terminal-width's visualWidth treats
 * control chars as 0, but a tab physically occupies up to several columns —
 * count it as 4 so tab-indented code can't sneak past the width bound.
 */
const cellWidth = (ch: string): number => (ch === "\t" ? 4 : visualWidth(ch));

/** visualWidth, but tab-aware (see cellWidth). */
function measureWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cellWidth(ch);
  return w;
}

/** Min column width we ever wrap at (tiny terminals / tests). */
const MIN_COL_WIDTH = 20;

/** Estimated visual height of one logical line wrapped at `colWidth`. Used only
 *  for the fits-check fast path and the hiddenLines estimate; the kept tail is
 *  re-wrapped explicitly, so its rendered height is exact. */
function lineCost(line: string, colWidth: number): number {
  return Math.max(1, Math.ceil(measureWidth(line) / colWidth));
}

/**
 * Greedy word wrap of a single logical line at `width` columns. Breaks at the
 * last space when possible (dropping it — matches trim:true semantics so no
 * boundary-space inflation), otherwise breaks a long word at the character
 * boundary. Never splits a surrogate pair or a wide glyph.
 */
function hardWrapLine(line: string, width: number): string[] {
  if (measureWidth(line) <= width) return [line];
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
    const w = cellWidth(ch);
    if (curW + w > width) {
      // Break at the last space when it leaves a non-empty head AND a word
      // tail (lastSpace === 0 would emit an empty line — fall through to a
      // hard break instead, preserving leading whitespace e.g. in code).
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
 * #35 append-only prefix cache: streaming calls this ~30fps with a text that
 * only GROWS, but the cost scan below is a per-char JS measurement loop —
 * O(session) per frame, O(session²) per turn. The cache records the fully
 * measured line-prefix `(settled text, line count, total cost, wide flag)` so
 * a frame only measures lines appended since the last one. Keyed by wrap
 * width because the two live regions (text/thinking) wrap at different
 * columns; a startsWith miss (new turn, edit, resize) falls back to a full
 * scan and re-seeds. Entries die on process exit; two slots of ≤ one turn's
 * text is the whole footprint.
 */
interface PrefixCache {
  /** Measured prefix — always ends at a "\n" boundary. */
  settled: string;
  /** Number of COMPLETE lines in `settled` (settled.split("\n").length - 1). */
  lineCount: number;
  /** Σ lineCost over those complete lines. */
  total: number;
  /** True when any of those complete lines is wider than the wrap width. */
  anyWide: boolean;
}
const prefixCaches = new Map<number, PrefixCache>();

/** Test hook: drop all cached prefixes (simulates a fresh process). */
export function __clearLiveWindowCacheForTests(): void {
  prefixCaches.clear();
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
  //
  // #35: incremental scan. Complete lines (everything except the last split
  // element) that a previous frame already measured at THIS width are reused
  // from the prefix cache; only appended lines pay the per-char loop. The
  // wide-line flag is tracked separately for complete lines vs the final
  // partial line so the cached flag stays exact (flags can't be un-set when
  // the partial line later grows).
  const completeCount = lines.length - 1;
  let total = 0;
  let anyWideComplete = false;
  let startIdx = 0;
  const cached = prefixCaches.get(width);
  if (
    cached &&
    cached.lineCount <= completeCount &&
    (cached.lineCount === 0 || text.startsWith(cached.settled))
  ) {
    total = cached.total;
    anyWideComplete = cached.anyWide;
    startIdx = cached.lineCount;
  }
  let anyWideLast = false;
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i]!;
    total += lineCost(l, width);
    if (measureWidth(l) > width) {
      if (i === completeCount) anyWideLast = true;
      else anyWideComplete = true;
    }
  }
  // Grow the cache to cover every complete line (only forward — a shrink
  // means the text stopped being append-only and the next call re-seeds).
  if (completeCount > startIdx || (!cached && completeCount > 0)) {
    const settled = text.slice(0, text.lastIndexOf("\n") + 1);
    const lastLine = lines[completeCount]!;
    prefixCaches.set(width, {
      settled,
      lineCount: completeCount,
      total: total - lineCost(lastLine, width),
      anyWide: anyWideComplete,
    });
  }
  const anyWide = anyWideComplete || anyWideLast;
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
    const w = measureWidth(lines[start - 1]!);
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
      const cw = cellWidth(cps[cut - 1]!);
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
