// ============================================================
// ModelPicker — quick model switcher overlay (B8, alt+p / meta+p)
// ============================================================
// A vertically-stacked, arrow-navigable list of switchable models, built
// from the saved provider profiles plus the current model. Selecting one
// (Enter) resolves the overlay with that profile choice id; the runner
// swaps the live ModelConfig in place WITHOUT any LLM call. Esc cancels.
// Custom ids stay on /model <id> — this picker only lists known-good pairs.
//
// Scrolling mirrors ProviderPicker: only VISIBLE rows draw at once and
// "↑/↓ N more" markers flag the hidden rows.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { t } from "./i18n.js";
import { nextOffset } from "./SessionPicker.js";
import type { Overlay } from "./store.js";
import { palette } from "./theme.js";

// Read the live palette so theme switches update the picker immediately.
function accentColor(): string {
  return palette.promptAccent;
}
function currentColor(): string {
  return palette.success;
}

/** How many model rows are visible at once before the list scrolls. */
const VISIBLE = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function ModelPicker({ overlay }: { overlay: Extract<Overlay, { kind: "modelPicker" }> }) {
  const { items } = overlay;
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      items.findIndex((i) => i.current),
    ),
  );
  const [offset, setOffset] = useState(0);
  // Synced cursor ref (see ProviderPicker): two arrow keys arriving in ONE
  // stdin chunk must both move, and Enter in the same burst resolves the row
  // actually highlighted.
  const cursorRef = useRef(cursor);

  const windowSize = Math.min(VISIBLE, items.length);

  const move = (delta: number) => {
    const next = clamp(cursorRef.current + delta, 0, items.length - 1);
    cursorRef.current = next;
    setCursor(next);
    setOffset((off) => nextOffset(next, off, windowSize));
  };

  useInput((input, key) => {
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-windowSize);
    else if (key.pageDown) move(windowSize);
    else if (key.return) {
      const item = items[cursorRef.current];
      overlay.resolve(item?.id ?? item?.name ?? null);
    } else if (key.escape) overlay.resolve(null);
    else if (/^[1-9]$/.test(input)) {
      const idx = offset + parseInt(input, 10) - 1;
      if (idx < items.length) overlay.resolve(items[idx]!.id ?? items[idx]!.name);
    }
  });

  const start = clamp(offset, 0, Math.max(0, items.length - windowSize));
  const visible = items.slice(start, start + windowSize);
  const hiddenAbove = start;
  const hiddenBelow = items.length - (start + windowSize);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor()} paddingX={1}>
      <Text bold color={accentColor()}>
        Switch model
      </Text>
      <Text dimColor>alt+p · /model &lt;id&gt; for anything not listed</Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{hiddenAbove > 0 ? `  ↑ ${hiddenAbove} more` : " "}</Text>
        {visible.map((m, i) => {
          const realIdx = start + i;
          const selected = realIdx === cursor;
          return (
            <Text key={m.id ?? m.name} color={selected ? accentColor() : undefined}>
              {selected ? "❯ " : "  "}
              <Text color={m.current ? currentColor() : undefined}>{m.current ? "● " : ""}</Text>
              {m.name}
              <Text dimColor>{`  ${m.label}`}</Text>
            </Text>
          );
        })}
        <Text dimColor>{hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}</Text>
      </Box>

      <Text dimColor>{t("ui.picker.models")}</Text>
    </Box>
  );
}
