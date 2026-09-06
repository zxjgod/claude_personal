// ============================================================
// Prompts — permission + structured question overlays (9.5)
// ============================================================
// Arrow-key selectable menus rendered as Ink overlays. They call the
// overlay's resolve() with the choice; the store clears the overlay.
//
// Official alignment (2026-09): dialogs use the official permission blue
// (rgb(87,105,247)) with a ▔ divider row above, the permission menu carries
// the official option wording (tool-aware "always" label built by run.tsx),
// single-key y/a/n shortcuts, and Shift+Tab cycles the permission mode
// IN-dialog — the official confirmation-context key.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { HORIZONTAL_BAR } from "./figures.js";
import { t } from "./i18n.js";
import type { Overlay, TuiStore } from "./store.js";
import { terminalColumns } from "./terminal-width.js";
import { palette } from "./theme.js";

const ACCENT = palette.permission;

/** Risk level visual indicators */
const RISK_LEVELS = {
  low: { icon: "⚡", color: "#4EBA65", label: "Low Risk" },
  medium: { icon: "⚠️", color: "#e0af68", label: "Medium Risk" },
  high: { icon: "🔴", color: "#f7768e", label: "High Risk" },
} as const;

/** Get risk level from riskHint */
function getRiskLevel(riskHint?: string): keyof typeof RISK_LEVELS | null {
  if (!riskHint) return null;
  const lower = riskHint.toLowerCase();
  // Check for explicit high risk indicators
  if (
    lower.includes("high") ||
    lower.includes("dangerous") ||
    lower.includes("destructive") ||
    lower.includes("recursive delete") ||
    lower.includes("rm -rf") ||
    lower.includes("sudo") ||
    lower.includes("fork bomb")
  ) {
    return "high";
  }
  if (lower.includes("medium") || lower.includes("moderate")) {
    return "medium";
  }
  if (lower.includes("low") || lower.includes("safe") || lower.includes("read")) {
    return "low";
  }
  return null;
}

export function PermissionPrompt({
  overlay,
  store,
}: {
  overlay: Extract<Overlay, { kind: "permission" }>;
  /** Shift+Tab cycles the permission mode in-dialog (official behavior). */
  store?: TuiStore;
}) {
  // Official option wording; the "always" line is tool-aware when the caller
  // (run.tsx) provided one — "…for commands in <dir>" / "…all edits this
  // session" — falling back to the session-generic label.
  const options: Array<{ label: string; value: "yes" | "always" | "no" }> = [
    { label: t("ui.permission.yes"), value: "yes" },
    { label: overlay.alwaysLabel ?? t("ui.permission.always"), value: "always" },
    { label: t("ui.permission.no"), value: "no" },
  ];
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    // Official confirmation-context key: cycle the permission mode without
    // leaving the dialog (the dialog stays; the footer mode line updates).
    if (key.tab && key.shift) {
      store?.cyclePermissionMode();
      return;
    }
    if (key.upArrow) setSelected((s) => (s - 1 + options.length) % options.length);
    else if (key.downArrow) setSelected((s) => (s + 1) % options.length);
    else if (key.return) overlay.resolve(options[selected]!.value);
    else if (key.escape) overlay.resolve("no");
    else if (/^[1-3]$/.test(input)) overlay.resolve(options[parseInt(input, 10) - 1]!.value);
    // Single-letter shortcuts (official muscle memory): y = allow once,
    // a = always, n = deny.
    else if (input === "y") overlay.resolve("yes");
    else if (input === "a") overlay.resolve("always");
    else if (input === "n") overlay.resolve("no");
  });

  const riskLevel = getRiskLevel(overlay.riskHint);

  return (
    <Box flexDirection="column">
      {/* Official modal divider: a ▔ rule in permission blue above the dialog. */}
      <Text color={ACCENT}>{HORIZONTAL_BAR.repeat(Math.max(20, terminalColumns() - 1))}</Text>
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Box>
          <Text bold color={ACCENT}>
            {overlay.header}
          </Text>
          {riskLevel && (
            <Text color={RISK_LEVELS[riskLevel].color} bold>
              {" "}
              {RISK_LEVELS[riskLevel].icon}
            </Text>
          )}
        </Box>
        {overlay.detail ? <Text>{overlay.detail}</Text> : null}
        {riskLevel ? (
          <Box>
            <Text color={RISK_LEVELS[riskLevel].color}>{RISK_LEVELS[riskLevel].label}</Text>
            <Text dimColor>: {overlay.riskHint}</Text>
          </Box>
        ) : overlay.riskHint ? (
          <Text color="#e0af68">{overlay.riskHint}</Text>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text>{t("ui.permission.proceed")}</Text>
          {options.map((opt, i) => (
            <Text key={opt.value} color={i === selected ? ACCENT : undefined}>
              {i === selected ? "❯ " : "  "}
              {i + 1}. {opt.label}
            </Text>
          ))}
        </Box>
        <Text dimColor>{`${t("ui.permission.hint")} · Shift+Tab mode`}</Text>
      </Box>
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
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text bold color={ACCENT}>
        {overlay.header}
      </Text>
      <Text>{overlay.question}</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Box key={i} flexDirection="column">
            <Text color={i === cursor ? ACCENT : undefined}>
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
      </Text>
    </Box>
  );
}

export function ConfirmPrompt({ overlay }: { overlay: Extract<Overlay, { kind: "confirm" }> }) {
  const [selected, setSelected] = useState(0);
  const options: Array<{ label: string; value: boolean }> = [
    { label: "Yes", value: true },
    { label: "No", value: false },
  ];

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow) {
      setSelected((s) => (s + 1) % options.length);
    } else if (key.return) {
      overlay.resolve(options[selected]!.value);
    } else if (key.escape) {
      overlay.resolve(false);
    } else if (/^[12]$/.test(input)) {
      overlay.resolve(input === "1");
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text bold color={ACCENT}>
        {overlay.header}
      </Text>
      <Box marginTop={1}>
        {options.map((opt, i) => (
          <Text key={opt.label} color={i === selected ? ACCENT : undefined}>
            {i === selected ? "❯ " : "  "}
            {opt.label}
            {"  "}
          </Text>
        ))}
      </Box>
      <Text dimColor>←→ choose · Enter confirm · Esc cancel</Text>
    </Box>
  );
}
