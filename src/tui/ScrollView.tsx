// ============================================================
// ScrollView — minimal windowed scroll viewport (M25.2)
// ============================================================
// Stock Ink 7 has no ScrollBox (the reference uses a forked Ink + hundreds of
// lines of wheel physics). This is a deliberately small replacement: given a
// flat array of already-rendered text lines and a fixed viewport height, it
// renders only the visible window and tracks a scroll offset with sticky-bottom
// behavior (new content auto-follows unless the user has scrolled up).
//
// Why line-based (not element measurement): a robust pixel/row scroll of
// arbitrary React subtrees needs per-node height measurement that Ink doesn't
// expose cheaply. Flattening to lines keeps the windowing exact and testable —
// the caller is responsible for turning transcript items into lines.
//
// Scrolling is driven by the parent via a ScrollController (see useScrollView):
// PgUp/PgDn page by half a viewport, Ctrl+End jumps to bottom and re-sticks.
// ============================================================

import { Box, Text } from "ink";

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

export function ScrollView({
  lines,
  height,
  scrollTop,
}: {
  lines: string[];
  height: number;
  scrollTop: number;
}) {
  const { start, end } = visibleWindow(lines.length, height, scrollTop);
  const slice = lines.slice(start, end);
  // Pad to a fixed height so the regions below (status line / input) keep a
  // stable position even when the content is shorter than the viewport.
  const pad = Math.max(0, height - slice.length);
  return (
    <Box flexDirection="column" height={height}>
      {slice.map((line, i) => (
        <Text key={start + i}>{line.length > 0 ? line : " "}</Text>
      ))}
      {Array.from({ length: pad }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </Box>
  );
}
