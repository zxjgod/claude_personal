// ============================================================
// ProviderPicker — interactive /provider profile list overlay
// ============================================================
// A vertically-stacked, arrow-navigable list of saved API endpoint profiles
// (from .claude/providers.json). Selecting one (Enter) resolves the overlay
// with that profile's name; the run.tsx handler then swaps the live ModelConfig
// in place WITHOUT any LLM call (no tokens). Esc cancels.
//
// Scrolling mirrors SessionPicker: only VISIBLE rows draw at once, the window
// slides to keep the highlighted row on screen, and "↑ N more" / "↓ N more"
// mark hidden rows.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { t } from "./i18n.js";
import { nextOffset } from "./SessionPicker.js";
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

/** How many profile rows are visible at once before the list scrolls. */
const VISIBLE = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function ProviderPicker({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "providerPicker" }>;
}) {
  const { profiles } = overlay;
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  // Synced cursor ref (see RewindPicker): two arrow keys arriving in ONE
  // stdin chunk run the same handler closure without a re-render between
  // them — the second must see the first's cursor, and Enter in the same
  // burst must resolve the row actually highlighted.
  const cursorRef = useRef(0);

  const windowSize = Math.min(VISIBLE, profiles.length);

  const move = (delta: number) => {
    const next = clamp(cursorRef.current + delta, 0, profiles.length - 1);
    cursorRef.current = next;
    setCursor(next);
    setOffset((off) => nextOffset(next, off, windowSize));
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-windowSize);
    else if (key.pageDown) move(windowSize);
    else if (key.return) overlay.resolve(profiles[cursorRef.current]?.name ?? null);
    else if (key.escape) overlay.resolve(null);
    else if (/^[1-9]$/.test(input)) {
      const idx = offset + parseInt(input, 10) - 1;
      if (idx < profiles.length) overlay.resolve(profiles[idx]!.name);
    }
  });

  const start = clamp(offset, 0, Math.max(0, profiles.length - windowSize));
  const visible = profiles.slice(start, start + windowSize);
  const hiddenAbove = start;
  const hiddenBelow = profiles.length - (start + windowSize);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={cyan()} paddingX={1}>
      <Text bold color={cyan()}>
        Switch provider
      </Text>
      <Text dimColor>
        {profiles.length} saved profile{profiles.length === 1 ? "" : "s"} — switches endpoint
        without using tokens
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{hiddenAbove > 0 ? `  ↑ ${hiddenAbove} more` : " "}</Text>
        {visible.map((p, i) => {
          const realIdx = start + i;
          const selected = realIdx === cursor;
          return (
            <Box key={p.name} flexDirection="column">
              <Text color={selected ? cyan() : undefined}>
                {selected ? "❯ " : "  "}
                <Text color={p.current ? orange() : undefined}>{p.current ? "● " : ""}</Text>
                {p.name}
                <Text dimColor>{`  (${p.label})`}</Text>
              </Text>
              {p.detail ? <Text dimColor>{"      " + p.detail}</Text> : null}
            </Box>
          );
        })}
        <Text dimColor>{hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}</Text>
      </Box>

      <Text dimColor>{t("ui.picker.providers")}</Text>
    </Box>
  );
}
