// ============================================================
// Prompts — permission + structured question overlays (9.5)
// ============================================================
// Arrow-key selectable menus rendered as Ink overlays. They call the
// overlay's resolve() with the choice; the store clears the overlay.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Overlay } from "./store.js";

const CYAN = "cyan";

export function PermissionPrompt({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "permission" }>;
}) {
  const options: Array<{ label: string; value: "yes" | "always" | "no" }> = [
    { label: "Yes", value: "yes" },
    { label: "Yes, and always allow this", value: "always" },
    { label: "No", value: "no" },
  ];
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => (s - 1 + options.length) % options.length);
    else if (key.downArrow) setSelected((s) => (s + 1) % options.length);
    else if (key.return) overlay.resolve(options[selected]!.value);
    else if (key.escape) overlay.resolve("no");
    else if (/^[1-3]$/.test(input)) overlay.resolve(options[parseInt(input, 10) - 1]!.value);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={CYAN} paddingX={1}>
      <Text bold color={CYAN}>
        {overlay.header}
      </Text>
      {overlay.detail ? <Text>{overlay.detail}</Text> : null}
      {overlay.riskHint ? <Text color="yellow">{overlay.riskHint}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text>Do you want to proceed?</Text>
        {options.map((opt, i) => (
          <Text key={opt.value} color={i === selected ? CYAN : undefined}>
            {i === selected ? "❯ " : "  "}
            {i + 1}. {opt.label}
          </Text>
        ))}
      </Box>
      <Text dimColor>↑↓ choose · Enter confirm · Esc cancel · Shift+Tab mode</Text>
    </Box>
  );
}

export function QuestionPrompt({ overlay }: { overlay: Extract<Overlay, { kind: "question" }> }) {
  const { options, multiSelect } = overlay;
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => (c - 1 + options.length) % options.length);
    else if (key.downArrow) setCursor((c) => (c + 1) % options.length);
    else if (input === " " && multiSelect) toggle(cursor);
    else if (key.escape) overlay.resolve(null);
    else if (key.return) {
      if (multiSelect) {
        const labels = [...checked].sort((a, b) => a - b).map((i) => options[i]!.label);
        overlay.resolve(labels);
      } else {
        overlay.resolve([options[cursor]!.label]);
      }
    } else if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx < options.length) {
        if (multiSelect) {
          toggle(idx);
          setCursor(idx);
        } else {
          overlay.resolve([options[idx]!.label]);
        }
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={CYAN} paddingX={1}>
      <Text bold color={CYAN}>
        {overlay.header}
      </Text>
      <Text>{overlay.question}</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Box key={i} flexDirection="column">
            <Text color={i === cursor ? CYAN : undefined}>
              {i === cursor ? "❯ " : "  "}
              {multiSelect ? (checked.has(i) ? "[x] " : "[ ] ") : ""}
              {opt.label}
            </Text>
            {opt.description ? <Text dimColor>{"    " + opt.description}</Text> : null}
          </Box>
        ))}
      </Box>
      <Text dimColor>
        {multiSelect
          ? "↑↓ move · Space toggle · Enter confirm · Esc cancel"
          : "↑↓ move · Enter select · Esc cancel"}
        {" · Shift+Tab mode"}
      </Text>
    </Box>
  );
}
