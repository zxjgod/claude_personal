// ============================================================
// ScrollView — minimal windowed scroll viewport (M25.2)
// ============================================================
// Stock Ink 7 has no ScrollBox (the reference uses a forked Ink + hundreds of
// lines of wheel physics). This is a deliberately small replacement: given a
// flat array of already-rendered text lines, it fills the height it's given by
// its flex parent (measured via measureElement) and renders only the visible
// window, tracking a scroll offset with sticky-bottom behavior.
//
// Why measure (not a fixed height prop): the bottom chrome (status line + input
// box + command palette) changes height — the palette alone is up to 8 rows.
// A fixed-height layout fought that and pushed the cursor onto the wrong row.
// Here ScrollView lives in a flexGrow={1} box and adapts to whatever height the
// flex layout leaves it, so the input box stays pinned to the bottom and the
// cursor never drifts.
//
// Why line-based (not element measurement of content): a robust pixel/row
// scroll of arbitrary React subtrees needs per-node height measurement Ink
// doesn't expose cheaply. Flattening to lines keeps the windowing exact and
// testable — the caller turns transcript items into lines.
// ============================================================

import { Box, measureElement, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { TranscriptLine } from "./transcript-lines.js";

/** Pure windowing math, exported for tests. Returns the slice [start, end) of
 *  `lines` visible for a given scrollTop and viewport height. */
export function visibleWindow(
  totalLines: number,
  viewportHeight: number,
  scrollTop: number,
): { start: number; end: number } {
  const h = Math.max(1, viewportHeight);
  const maxTop = Math.max(0, totalLines - h);
  const start = Math.max(0, Math.min(scrollTop, maxTop));
  return { start, end: Math.min(totalLines, start + h) };
}

/** Clamp a desired scrollTop into the valid range for the content/viewport. */
export function clampScrollTop(
  totalLines: number,
  viewportHeight: number,
  desired: number,
): number {
  const maxTop = Math.max(0, totalLines - Math.max(1, viewportHeight));
  return Math.max(0, Math.min(desired, maxTop));
}

/** The scrollTop that pins the view to the bottom (most recent content). */
export function bottomScrollTop(totalLines: number, viewportHeight: number): number {
  return Math.max(0, totalLines - Math.max(1, viewportHeight));
}

/**
 * Windowed scroll view that fills its flex parent. Reports its measured height
 * back through `onHeight` so the parent can size scroll math (page steps,
 * sticky-bottom) against the real viewport rather than a guessed row count.
 *
 * P3-16: lines may be plain strings OR TranscriptLine objects carrying a role
 * color/dim — the pager and full-screen view render colored transcript rows
 * through the same windowing.
 */
export function ScrollView({
  lines,
  scrollTop,
  fallbackHeight,
  onHeight,
}: {
  lines: Array<string | TranscriptLine>;
  scrollTop: number;
  /** Used before the first measurement settles (and under ink-testing). */
  fallbackHeight: number;
  onHeight?: (h: number) => void;
}) {
  const ref = useRef(null);
  const [height, setHeight] = useState(fallbackHeight);

  // Measure the height the flex layout actually gave us, after each render
  // (content / terminal / palette changes all re-flow). measureElement is cheap
  // and synchronous in Ink. The guard avoids a setState (and re-render) when the
  // height is unchanged, so this can't loop.
  useEffect(() => {
    if (!ref.current) return;
    const measured = measureElement(ref.current).height;
    const h = measured > 0 ? measured : fallbackHeight;
    if (h !== height) {
      setHeight(h);
      onHeight?.(h);
    }
  });

  const { start, end } = visibleWindow(lines.length, height, scrollTop);
  const slice = lines.slice(start, end);
  const pad = Math.max(0, height - slice.length);
  return (
    <Box ref={ref} flexDirection="column" flexGrow={1}>
      {slice.map((line, i) => {
        const l = typeof line === "string" ? { text: line } : line;
        return (
          <Text
            key={start + i}
            wrap="truncate-end"
            color={l.color}
            backgroundColor={l.backgroundColor}
            dimColor={l.dim}
          >
            {l.text.length > 0 ? l.text : " "}
          </Text>
        );
      })}
      {Array.from({ length: pad }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </Box>
  );
}
