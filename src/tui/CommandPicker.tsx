// ============================================================
// CommandPicker — interactive /help command palette overlay (M37)
// ============================================================
// A vertically-stacked, arrow-navigable list of every slash command. Opened by
// `/help` (or `/commands`) + Enter. Selecting one (Enter) resolves the overlay
// with that command's name; run.tsx then dispatches it exactly as if the user
// had typed "/name". Esc cancels.
//
// Scrolling window: only VISIBLE rows are drawn at once, and the window slides
// the minimum amount needed to keep the highlighted row on screen (reusing
// SessionPicker's `nextOffset`), so a long command list never pushes the cursor
// out of view — "↑ N more" / "↓ N more" markers flag the hidden rows.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { nextOffset } from "./SessionPicker.js";
import type { Overlay } from "./store.js";
import { palette } from "./theme.js";

/** How many command rows are visible at once before the list scrolls. */
const VISIBLE = 10;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function CommandPicker({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "commandPicker" }>;
}) {
  const { commands } = overlay;
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  const windowSize = Math.min(VISIBLE, commands.length);

  const move = (delta: number) => {
    const next = clamp(cursor + delta, 0, commands.length - 1);
    setCursor(next);
    setOffset((off) => nextOffset(next, off, windowSize));
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-windowSize);
    else if (key.pageDown) move(windowSize);
    else if (key.return) overlay.resolve(commands[cursor]?.name ?? null);
    else if (key.escape) overlay.resolve(null);
  });

  const start = clamp(offset, 0, Math.max(0, commands.length - windowSize));
  const visible = commands.slice(start, start + windowSize);
  const hiddenAbove = start;
  const hiddenBelow = commands.length - (start + windowSize);
  // Align descriptions into a column: pad names to the longest visible name.
  const nameWidth = visible.reduce((w, c) => Math.max(w, c.name.length), 0);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.command} paddingX={1}>
      <Text bold color={palette.command}>
        Commands
      </Text>
      <Text dimColor>
        {commands.length} command{commands.length === 1 ? "" : "s"} — ↑↓ to move, Enter to run
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{hiddenAbove > 0 ? `  ↑ ${hiddenAbove} more` : " "}</Text>
        {visible.map((c, i) => {
          const realIdx = start + i;
          const selected = realIdx === cursor;
          return (
            <Box key={c.name}>
              <Text color={selected ? palette.command : undefined}>
                {selected ? "❯ " : "  "}/{c.name.padEnd(nameWidth)}
              </Text>
              <Text dimColor>{"  " + c.description}</Text>
            </Box>
          );
        })}
        <Text dimColor>{hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}</Text>
      </Box>

      <Text dimColor>↑↓ move · PgUp/PgDn page · Enter run · Esc cancel</Text>
    </Box>
  );
}
