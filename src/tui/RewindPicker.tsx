// ============================================================
// RewindPicker — Esc+Esc rewind menu overlay (P0-3)
// ============================================================
// Lists the session's user turns (most recent first). Selecting one resolves
// the overlay with that 1-based turn index; the run.tsx handler then
// truncates the message history to BEFORE that turn and restores on-disk
// files from the checkpoint snapshots (see src/checkpoint.ts). Esc cancels.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { t } from "./i18n.js";
import { nextOffset } from "./SessionPicker.js";
import type { Overlay } from "./store.js";
import { truncateVisual } from "./terminal-width.js";

const ORANGE = "#d77757";
/** Rewind entries carry a message preview + timestamp — two rows each. */
const VISIBLE = 5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function RewindPicker({ overlay }: { overlay: Extract<Overlay, { kind: "rewind" }> }) {
  const { entries } = overlay;
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  // Synced refs: two arrow keys arriving in ONE stdin chunk run the same
  // handler closure without a re-render between them — the second must see
  // the first's cursor or it moves by one step total.
  const cursorRef = useRef(0);
  const windowSize = Math.min(VISIBLE, entries.length);

  const move = (delta: number) => {
    const next = clamp(cursorRef.current + delta, 0, entries.length - 1);
    cursorRef.current = next;
    setCursor(next);
    setOffset((off) => nextOffset(next, off, windowSize));
  };

  useInput((_input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-windowSize);
    else if (key.pageDown) move(windowSize);
    else if (key.return) overlay.resolve(entries[cursorRef.current]?.turnIndex ?? null);
    else if (key.escape) overlay.resolve(null);
  });

  const start = clamp(offset, 0, Math.max(0, entries.length - windowSize));
  const visible = entries.slice(start, start + windowSize);
  const hiddenAbove = start;
  const hiddenBelow = entries.length - (start + windowSize);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
      <Text bold color={ORANGE}>
        {t("ui.rewind.title")}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{hiddenAbove > 0 ? `  ↑ ${hiddenAbove} more` : " "}</Text>
        {visible.map((e, i) => {
          const realIdx = start + i;
          const selected = realIdx === cursor;
          return (
            <Box key={e.turnIndex} flexDirection="column">
              <Text color={selected ? ORANGE : undefined}>
                {`${selected ? "❯ " : "  "}#${e.turnIndex} ${truncateVisual(e.label, 60)}`}
              </Text>
              <Text dimColor>
                {`     ${e.timestamp}${e.filesChanged > 0 ? ` · ${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"} changed` : ""}`}
              </Text>
            </Box>
          );
        })}
        <Text dimColor>{hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}</Text>
      </Box>

      <Text dimColor>{t("ui.rewind.hint")}</Text>
    </Box>
  );
}
