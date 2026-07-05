// ============================================================
// SessionPicker — interactive /resume session list overlay
// ============================================================
// A vertically-stacked, arrow-navigable list of saved sessions. Selecting one
// (Enter) resolves the overlay with that session's id; the run.tsx handler then
// loads its history WITHOUT any LLM call (no tokens) and replays it into the
// transcript. Esc cancels.
//
// Scrolling window: only VISIBLE rows are drawn at once. When the cursor moves
// past either edge, the window slides just enough to keep the highlighted row
// on screen, so a long session list never pushes the selection out of view.
// "↑ N more" / "↓ N more" markers indicate hidden rows above/below.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Overlay } from "./store.js";

const CYAN = "cyan";
const ORANGE = "#d77757";

/** How many session rows are visible at once before the list scrolls. */
const VISIBLE = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Slide the scroll window the minimum amount needed to keep `cursor` visible.
 * Returns the new first-visible index. Pure so the scroll behaviour can be
 * unit-tested without driving the Ink input loop.
 *   - cursor above the window  → pin window top to cursor
 *   - cursor below the window  → pin window bottom to cursor
 *   - cursor already visible    → window unchanged
 */
export function nextOffset(cursor: number, offset: number, windowSize: number): number {
  if (cursor < offset) return cursor;
  if (cursor >= offset + windowSize) return cursor - windowSize + 1;
  return offset;
}

export function SessionPicker({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "sessionPicker" }>;
}) {
  const { sessions } = overlay;
  const [cursor, setCursor] = useState(0);
  // Index of the first visible row. Kept in state and nudged on each move so
  // the window follows the cursor with minimal scrolling (no jumpy centering).
  const [offset, setOffset] = useState(0);

  const windowSize = Math.min(VISIBLE, sessions.length);

  const move = (delta: number) => {
    const next = clamp(cursor + delta, 0, sessions.length - 1);
    setCursor(next);
    setOffset((off) => nextOffset(next, off, windowSize));
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-windowSize);
    else if (key.pageDown) move(windowSize);
    else if (key.return) overlay.resolve(sessions[cursor]?.sessionId ?? null);
    else if (key.escape) overlay.resolve(null);
    else if (/^[1-9]$/.test(input)) {
      // Jump to the Nth *visible* row (1-based within the current window).
      const idx = offset + parseInt(input, 10) - 1;
      if (idx < sessions.length) overlay.resolve(sessions[idx]!.sessionId);
    }
  });

  const start = clamp(offset, 0, Math.max(0, sessions.length - windowSize));
  const visible = sessions.slice(start, start + windowSize);
  const hiddenAbove = start;
  const hiddenBelow = sessions.length - (start + windowSize);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={CYAN} paddingX={1}>
      <Text bold color={CYAN}>
        Resume a session
      </Text>
      <Text dimColor>
        {sessions.length} saved session{sessions.length === 1 ? "" : "s"} — restores history without
        using tokens
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{hiddenAbove > 0 ? `  ↑ ${hiddenAbove} more` : " "}</Text>
        {visible.map((s, i) => {
          const realIdx = start + i;
          const selected = realIdx === cursor;
          return (
            <Box key={s.sessionId} flexDirection="column">
              <Text color={selected ? CYAN : undefined}>
                {selected ? "❯ " : "  "}
                <Text color={s.current ? ORANGE : undefined}>{s.current ? "● " : ""}</Text>
                {s.label}
              </Text>
              {s.preview ? <Text dimColor>{"      " + s.preview}</Text> : null}
            </Box>
          );
        })}
        <Text dimColor>{hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}</Text>
      </Box>

      <Text dimColor>↑↓ move · PgUp/PgDn page · Enter resume · Esc cancel · Shift+Tab mode</Text>
    </Box>
  );
}
