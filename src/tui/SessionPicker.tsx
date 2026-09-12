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
import { useRef, useState } from "react";
import { t } from "./i18n.js";
import type { Overlay } from "./store.js";
import { palette } from "./theme.js";

// Read at RENDER time (see the header note in theme.ts). CYAN used to be the
// bare ANSI name "cyan", which ignored the theme entirely; it is now the
// palette's command colour, and ORANGE is the accent.
function cyan(): string {
  return palette.command;
}
function orange(): string {
  return palette.accent;
}

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
  // Synced cursor ref (see RewindPicker): two arrow keys arriving in ONE
  // stdin chunk run the same handler closure without a re-render between
  // them — the second must see the first's cursor, and Enter in the same
  // burst must resolve the row actually highlighted.
  const cursorRef = useRef(0);

  const windowSize = Math.min(VISIBLE, sessions.length);

  const move = (delta: number) => {
    const next = clamp(cursorRef.current + delta, 0, sessions.length - 1);
    cursorRef.current = next;
    setCursor(next);
    setOffset((off) => nextOffset(next, off, windowSize));
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-windowSize);
    else if (key.pageDown) move(windowSize);
    else if (key.return) overlay.resolve(sessions[cursorRef.current]?.sessionId ?? null);
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
    <Box flexDirection="column" borderStyle="round" borderColor={cyan()} paddingX={1}>
      <Text bold color={cyan()}>
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
              <Text color={selected ? cyan() : undefined}>
                {selected ? "❯ " : "  "}
                <Text color={s.current ? orange() : undefined}>{s.current ? "● " : ""}</Text>
                {s.label}
              </Text>
              {s.preview ? <Text dimColor>{"      " + s.preview}</Text> : null}
            </Box>
          );
        })}
        <Text dimColor>{hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}</Text>
      </Box>

      <Text dimColor>{t("ui.picker.sessions")}</Text>
    </Box>
  );
}
