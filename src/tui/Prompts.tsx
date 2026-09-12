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

// Read at render time (see theme.ts header): module-scope snapshots freeze the dark palette.
function accent(): string {
  return palette.permission;
}

/** Risk level visual indicators. Colors come from the LIVE palette at render
 *  time — hardcoded hexes here froze the dark success/warning/error values, so
 *  the high-risk badge stayed dark-red under /theme light. */
const RISK_LEVELS = {
  low: { icon: "⚡", color: "success", label: "Low Risk" },
  medium: { icon: "⚠️", color: "warning", label: "Medium Risk" },
  high: { icon: "🔴", color: "error", label: "High Risk" },
} as const;

/** Resolve a risk level's palette token to its current color. */
function riskColor(level: keyof typeof RISK_LEVELS): string {
  return palette[RISK_LEVELS[level].color];
}

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
      <Text color={accent()}>{HORIZONTAL_BAR.repeat(Math.max(20, terminalColumns() - 1))}</Text>
      <Box flexDirection="column" borderStyle="round" borderColor={accent()} paddingX={1}>
        <Box>
          <Text bold color={accent()}>
            {overlay.header}
          </Text>
          {riskLevel && (
            <Text color={riskColor(riskLevel)} bold>
              {" "}
              {RISK_LEVELS[riskLevel].icon}
            </Text>
          )}
        </Box>
        {overlay.detail ? <Text>{overlay.detail}</Text> : null}
        {riskLevel ? (
          <Box>
            <Text color={riskColor(riskLevel)}>{RISK_LEVELS[riskLevel].label}</Text>
            <Text dimColor>: {overlay.riskHint}</Text>
          </Box>
        ) : overlay.riskHint ? (
          <Text color="#e0af68">{overlay.riskHint}</Text>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text>{t("ui.permission.proceed")}</Text>
          {options.map((opt, i) => (
            <Text key={opt.value} color={i === selected ? accent() : undefined}>
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
    <Box flexDirection="column" borderStyle="round" borderColor={accent()} paddingX={1}>
      <Text bold color={accent()}>
        {overlay.header}
      </Text>
      <Text>{overlay.question}</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Box key={i} flexDirection="column">
            <Text color={i === cursor ? accent() : undefined}>
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

export function ElicitationPrompt({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "elicitation" }>;
}) {
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  useInput((input, key) => {
    const field = overlay.fields[index];
    if (!field) return;
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || key.tab) setIndex((i) => Math.min(overlay.fields.length - 1, i + 1));
    else if (key.escape) overlay.resolve({ action: "cancel" });
    else if (key.return) {
      if (overlay.fields.some((f) => f.required && !values[f.name])) {
        overlay.resolve({ action: "decline" });
        return;
      }
      const content: Record<string, string | number | boolean | string[]> = {};
      for (const f of overlay.fields) {
        const v = values[f.name] ?? "";
        if (!v) continue;
        if (f.type === "number" || f.type === "integer") content[f.name] = Number(v);
        else if (f.type === "boolean") content[f.name] = /^(true|yes|y)$/i.test(v);
        else if (f.type === "array")
          content[f.name] = v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        else content[f.name] = v;
      }
      overlay.resolve({ action: "accept", content });
    } else if (input && input.length === 1 && !key.ctrl && !key.meta)
      setValues((v) => ({ ...v, [field.name]: (v[field.name] ?? "") + input }));
    else if (key.backspace || key.delete)
      setValues((v) => ({ ...v, [field.name]: (v[field.name] ?? "").slice(0, -1) }));
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent()} paddingX={1}>
      <Text bold color={accent()}>
        MCP request
      </Text>
      <Text>{overlay.message}</Text>
      {overlay.fields.map((f, i) => (
        <Text key={f.name} color={i === index ? accent() : undefined}>
          {i === index ? "❯ " : "  "}
          {f.title ?? f.name}: {values[f.name] ?? ""}
          {f.enum?.length ? ` [${f.enum.join("/")}]` : ""}
        </Text>
      ))}
      <Text dimColor>↑↓/Tab field · type · Enter submit · Esc cancel</Text>
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
    <Box flexDirection="column" borderStyle="round" borderColor={accent()} paddingX={1}>
      <Text bold color={accent()}>
        {overlay.header}
      </Text>
      <Box marginTop={1}>
        {options.map((opt, i) => (
          <Text key={opt.label} color={i === selected ? accent() : undefined}>
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
