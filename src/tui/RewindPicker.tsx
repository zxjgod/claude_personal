// ============================================================
// RewindPicker — Esc+Esc rewind menu overlay (P0-3 · batch C3)
// ============================================================
// Two-stage menu, mirroring the official MessageSelector flow:
//   Stage 1: pick a user turn (most recent first, preview + timestamp).
//   Stage 2: pick WHAT to restore —
//     • Restore code and conversation  (files + messages)
//     • Restore conversation           (messages only)
//     • Restore code                   (files only)
//     • Never mind
//   Enter on stage 1 jumps straight to stage 2 (default = the official
//   "both"); Backspace/Esc on stage 2 goes back to turn selection.
// The resolver receives { turnIndex, action }; the run.tsx handler executes.
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

type RewindAction = "both" | "conversation" | "code";

const ACTIONS: Array<{ value: RewindAction; labelKey: string }> = [
  { value: "both", labelKey: "ui.rewind.both" },
  { value: "conversation", labelKey: "ui.rewind.conversation" },
  { value: "code", labelKey: "ui.rewind.code" },
];

export function RewindPicker({ overlay }: { overlay: Extract<Overlay, { kind: "rewind" }> }) {
  const { entries } = overlay;
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  // Stage 2 state: the chosen turn (null = still picking a turn).
  const [chosenTurn, setChosenTurn] = useState<number | null>(null);
  const [actionCursor, setActionCursor] = useState(0);
  // Synced refs: two arrow keys arriving in ONE stdin chunk run the same
  // handler closure without a re-render between them — the second must see
  // the first's cursor or it moves by one step total.
  const cursorRef = useRef(0);
  const actionCursorRef = useRef(0);
  const windowSize = Math.min(VISIBLE, entries.length);

  const move = (delta: number) => {
    const next = clamp(cursorRef.current + delta, 0, entries.length - 1);
    cursorRef.current = next;
    setCursor(next);
    setOffset((off) => nextOffset(next, off, windowSize));
  };

  useInput((_input, key) => {
    // --- Stage 2: the action menu for the chosen turn ---
    if (chosenTurn !== null) {
      if (key.upArrow) {
        const next = (actionCursorRef.current - 1 + ACTIONS.length) % ACTIONS.length;
        actionCursorRef.current = next;
        setActionCursor(next);
      } else if (key.downArrow) {
        const next = (actionCursorRef.current + 1) % ACTIONS.length;
        actionCursorRef.current = next;
        setActionCursor(next);
      } else if (key.return) {
        overlay.resolve({
          turnIndex: chosenTurn,
          action: ACTIONS[actionCursorRef.current]!.value,
        });
      } else if (key.escape || key.backspace || key.tab) {
        // Back to turn selection (Esc here is "go back", not cancel — the
        // turn list is one Esc away from cancelling).
        setChosenTurn(null);
      }
      return;
    }

    // --- Stage 1: pick a turn ---
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-windowSize);
    else if (key.pageDown) move(windowSize);
    else if (key.return) {
      const turnIndex = entries[cursorRef.current]?.turnIndex;
      if (turnIndex !== undefined) {
        actionCursorRef.current = 0;
        setActionCursor(0);
        setChosenTurn(turnIndex);
      }
    } else if (key.escape) overlay.resolve(null);
  });

  const start = clamp(offset, 0, Math.max(0, entries.length - windowSize));
  const visible = entries.slice(start, start + windowSize);
  const hiddenAbove = start;
  const hiddenBelow = entries.length - (start + windowSize);
  const chosenEntry =
    chosenTurn !== null ? entries.find((e) => e.turnIndex === chosenTurn) : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
      <Text bold color={ORANGE}>
        {t("ui.rewind.title")}
      </Text>

      {chosenEntry ? (
        // --- Stage 2: action menu under the chosen turn's preview ---
        <Box marginTop={1} flexDirection="column">
          <Text
            dimColor
          >{`  #${chosenEntry.turnIndex} ${truncateVisual(chosenEntry.label, 60)}`}</Text>
          <Box marginTop={1} flexDirection="column">
            {ACTIONS.map((a, i) => (
              <Text key={a.value} color={i === actionCursor ? ORANGE : undefined}>
                {`${i === actionCursor ? "❯ " : "  "}${i + 1}. ${t(a.labelKey)}`}
              </Text>
            ))}
            <Text dimColor>{`  4. ${t("ui.rewind.nevermind")}`}</Text>
          </Box>
        </Box>
      ) : (
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
      )}

      <Text dimColor>{chosenEntry ? t("ui.rewind.actionHint") : t("ui.rewind.hint")}</Text>
    </Box>
  );
}
