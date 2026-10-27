// ============================================================
// TogglePicker — 档位式二级 settings menu overlay
// ============================================================
// Bare /agents and /memory-approval open this instead of the old one-option-
// per-row picker (which needed one full round-trip per flip). Each row is ONE
// setting with its档位 shown inline ("thinking:  off | on"); ←/→ flips the
// highlighted row's档位 and fires onChange IMMEDIATELY (the flow persists on
// every flip — 即刻生效), ↑/↓ moves between rows, Enter/Esc closes. Colors
// mirror the "/" completion dropdown (InputBox): palette.secondary text,
// palette.commandSelected highlight, palette.promptBorder frame.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import type { Overlay, TogglePickerRow } from "./store.js";
import { palette } from "./theme.js";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function TogglePicker({ overlay }: { overlay: Extract<Overlay, { kind: "togglePicker" }> }) {
  const { title, hint, rows, onChange } = overlay;
  const [cursor, setCursor] = useState(0);
  // Local copy of each row's current value — committed only after onChange
  // confirms that the requested value was persisted and actually took effect.
  const [values, setValues] = useState<string[]>(rows.map((r) => r.current));
  const cursorRef = useRef(cursor);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const moveRow = (delta: number) => {
    const next = clamp(cursorRef.current + delta, 0, rows.length - 1);
    cursorRef.current = next;
    setCursor(next);
  };

  const flip = (delta: number) => {
    const rowIdx = cursorRef.current;
    const row: TogglePickerRow | undefined = rows[rowIdx];
    if (!row || row.values.length === 0) return;
    const cur = valuesRef.current[rowIdx] ?? row.current;
    const at = row.values.indexOf(cur);
    // Wrap around: ← from the first档位 lands on the last (and vice versa).
    const next = row.values[(at + delta + row.values.length) % row.values.length]!;
    if (!onChange(row.id, next)) return;
    const nextValues = valuesRef.current.map((v, i) => (i === rowIdx ? next : v));
    valuesRef.current = nextValues;
    setValues(nextValues);
  };

  useInput((_input, key) => {
    if (key.upArrow) moveRow(-1);
    else if (key.downArrow) moveRow(1);
    else if (key.leftArrow) flip(-1);
    else if (key.rightArrow) flip(1);
    else if (key.return || key.escape) overlay.resolve();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.promptBorder} paddingX={1}>
      <Text bold color={palette.secondary}>
        {title}
      </Text>
      {hint ? <Text dimColor>{hint}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => {
          const selected = i === cursor;
          const current = values[i] ?? row.current;
          return (
            <Text key={row.id} color={selected ? palette.commandSelected : palette.secondary}>
              {selected ? "❯ " : "  "}
              {row.label}
              {"  "}
              {row.values.map((v) => (
                <Text
                  key={v}
                  bold={v === current}
                  color={v === current ? palette.commandSelected : undefined}
                  dimColor={v !== current}
                >
                  {v === current ? `‹${v}›` : ` ${v} `}
                  {v === row.values[row.values.length - 1] ? "" : " "}
                </Text>
              ))}
              {row.detail ? <Text dimColor>{`  ${row.detail}`}</Text> : null}
            </Text>
          );
        })}
      </Box>

      <Text dimColor>←/→ 切换档位（即刻生效） · ↑/↓ 选择项 · Enter/Esc 退出</Text>
    </Box>
  );
}
