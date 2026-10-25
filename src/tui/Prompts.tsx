// ============================================================
// Prompts — permission + structured question overlays (9.5)
// ============================================================
// Arrow-key selectable menus rendered as Ink overlays. They call the
// overlay's resolve() with the choice; the store clears the overlay.
//
// Reference-style asking: one lavender rule, an open explanation and numbered
// choices. Tab opens an amended answer; y/a/n and Shift+Tab remain available.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { t } from "./i18n.js";
import { PromptAnswerInput, PromptOption, PromptPanel } from "./PromptPanel.js";
import type { Overlay, TuiStore } from "./store.js";
import { sanitizeTerminalText } from "./terminal-width.js";
import { modeColor, modeFooterText, palette } from "./theme.js";
import { DIFF_PREVIEW_MAX } from "./tool-output.js";
import { useStoreSelector } from "./useStoreSelector.js";

// Read at render time (see theme.ts header): module-scope snapshots freeze the dark palette.
function PermissionModeHint({ store }: { store: TuiStore }) {
  const mode = useStoreSelector(store, (state) => state.permissionMode);
  const label = modeFooterText(mode);
  return label ? <Text color={modeColor(mode)}>{` · ${label}`}</Text> : null;
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
    { label: t("ui.prompt.no"), value: "no" },
  ];
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);

  useInput((input, key) => {
    // Official confirmation-context key: cycle the permission mode without
    // leaving the dialog (the dialog stays; the footer mode line updates).
    if (key.tab && key.shift) {
      store?.cyclePermissionMode();
      return;
    }
    if (editing) return;
    if (key.tab && overlay.onAmend) {
      setEditing(true);
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
    <PromptPanel
      title={
        <>
          {overlay.header}
          {riskLevel ? (
            <Text color={riskColor(riskLevel)}>{` ${RISK_LEVELS[riskLevel].icon}`}</Text>
          ) : null}
        </>
      }
      subtitle={overlay.subtitle}
      footer={
        <>
          {t(
            editing
              ? "ui.prompt.editHint"
              : overlay.onAmend
                ? "ui.prompt.hint"
                : "ui.prompt.cancelHint",
          )}
          {store ? <PermissionModeHint store={store} /> : null}
        </>
      }
    >
      {overlay.description || overlay.detail ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {overlay.description ? (
            <Text color={palette.secondary}>{overlay.description}</Text>
          ) : null}
          {overlay.detail ? <Text color={palette.secondary}>{overlay.detail}</Text> : null}
        </Box>
      ) : null}
      {riskLevel ? (
        <Box>
          <Text color={riskColor(riskLevel)}>{RISK_LEVELS[riskLevel].label}</Text>
          <Text dimColor>: {overlay.riskHint}</Text>
        </Box>
      ) : overlay.riskHint ? (
        <Text color="#e0af68">{overlay.riskHint}</Text>
      ) : null}
      {/* #33 diff preview: caller-built lines (already colored by
            renderDiffLine), height-capped so a huge edit can't push the
            option row off-screen. */}
      {overlay.diff && overlay.diff.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {overlay.diff.slice(0, DIFF_PREVIEW_MAX).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static preview lines
            <Text key={i}>{line}</Text>
          ))}
          {overlay.diff.length > DIFF_PREVIEW_MAX ? (
            <Text dimColor>…{overlay.diff.length - DIFF_PREVIEW_MAX} more lines</Text>
          ) : null}
        </Box>
      ) : null}
      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text>{t("ui.prompt.feedback")}</Text>
          <PromptAnswerInput
            onCancel={() => setEditing(false)}
            onSubmit={(feedback) => {
              try {
                overlay.onAmend?.(feedback);
              } finally {
                overlay.resolve("no");
              }
            }}
          />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text>{t("ui.permission.proceed")}</Text>
          {options.map((opt, i) => (
            <PromptOption key={opt.value} index={i} selected={i === selected}>
              {opt.label}
            </PromptOption>
          ))}
        </Box>
      )}
    </PromptPanel>
  );
}

export function QuestionPrompt({ overlay }: { overlay: Extract<Overlay, { kind: "question" }> }) {
  const { options, multiSelect } = overlay;
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState(false);

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  useInput((input, key) => {
    if (editing) return;
    if (key.tab) {
      setEditing(true);
      return;
    }
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
    <PromptPanel
      title={overlay.header}
      subtitle={overlay.question}
      footer={t(
        editing ? "ui.prompt.editHint" : multiSelect ? "ui.prompt.multiHint" : "ui.prompt.hint",
      )}
    >
      {editing ? (
        <>
          <Box marginTop={1}>
            <Text>{t("ui.prompt.answer")}</Text>
          </Box>
          <PromptAnswerInput
            onCancel={() => setEditing(false)}
            onSubmit={(answer) => {
              const chosen = multiSelect
                ? [...checked].sort((a, b) => a - b).map((i) => options[i]!.label)
                : [];
              overlay.resolve([...new Set([...chosen, answer])]);
            }}
          />
        </>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {options.map((opt, i) => (
            <Box key={i} flexDirection="column">
              <PromptOption
                index={i}
                selected={i === cursor}
                prefix={multiSelect ? (checked.has(i) ? "[x] " : "[ ] ") : ""}
              >
                {opt.label}
              </PromptOption>
              {opt.description ? (
                <Box paddingLeft={5}>
                  <Text color={palette.secondary}>{sanitizeTerminalText(opt.description)}</Text>
                </Box>
              ) : null}
              {i === cursor && opt.preview ? (
                <Box paddingLeft={5} marginY={1}>
                  <Text>{sanitizeTerminalText(opt.preview)}</Text>
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      )}
    </PromptPanel>
  );
}

export function ElicitationPrompt({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "elicitation" }>;
}) {
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useInput((input, key) => {
    // Review fix ("空 elicitation 表单无法退出"): a schema with NO properties
    // (legal per protocol) produces zero fields; the generic `!field` guard
    // below used to swallow EVERY key including Esc/Enter, wedging the
    // overlay. Handle the empty form first: Esc cancels, Enter accepts {}.
    if (overlay.fields.length === 0) {
      if (key.escape) overlay.resolve({ action: "cancel" });
      else if (key.return) overlay.resolve({ action: "accept", content: {} });
      return;
    }
    const field = overlay.fields[index];
    if (!field) return;
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || key.tab) setIndex((i) => Math.min(overlay.fields.length - 1, i + 1));
    else if (key.escape) overlay.resolve({ action: "cancel" });
    else if (key.return) {
      if (overlay.fields.some((f) => f.required && !(values[f.name] ?? "").trim())) {
        setError("Complete the required fields before submitting.");
        return;
      }
      // Validate against the schema the server declared before submitting —
      // an enum violation or a NaN reaching the server as "content" is worse
      // than an inline error here.
      const content: Record<string, string | number | boolean | string[]> = {};
      for (const f of overlay.fields) {
        const v = (values[f.name] ?? "").trim();
        if (!v) continue;
        if (f.enum?.length && !f.enum.includes(v)) {
          setError(`"${v}" — ${f.name} must be one of: ${f.enum.join(" / ")}`);
          return;
        }
        if (f.type === "number" || f.type === "integer") {
          const num = Number(v);
          if (!Number.isFinite(num)) {
            setError(`"${v}" — ${f.name} must be a number`);
            return;
          }
          // "3.7" is a finite number but not an integer — the server declared
          // the field type, honor it before the value leaves the client.
          if (f.type === "integer" && !Number.isInteger(num)) {
            setError(`"${v}" — ${f.name} must be a whole number`);
            return;
          }
          if (f.minimum !== undefined && num < f.minimum) {
            setError(`${f.name} must be ≥ ${f.minimum}`);
            return;
          }
          if (f.maximum !== undefined && num > f.maximum) {
            setError(`${f.name} must be ≤ ${f.maximum}`);
            return;
          }
          content[f.name] = num;
        } else if (f.type === "boolean") content[f.name] = /^(true|yes|y)$/i.test(v);
        else if (f.type === "array")
          content[f.name] = v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        else content[f.name] = v;
      }
      overlay.resolve({ action: "accept", content });
    } else if (key.backspace || key.delete)
      // MUST come before the printable-input branch: Ink delivers Backspace as
      // the control char "\x7f" with key.backspace set, so a length-1
      // printable check here would insert DEL instead of deleting.
      setValues((v) => ({ ...v, [field.name]: (v[field.name] ?? "").slice(0, -1) }));
    else if (input && !key.ctrl && !key.meta) {
      // A multi-char `input` with no special key is a paste (bracketed paste
      // arrives as ONE event carrying the whole text) — accept all printable
      // chars, not just length-1 keystrokes.
      const chars = input.replace(/[\x00-\x1f\x7f]/g, "");
      if (chars) setValues((v) => ({ ...v, [field.name]: (v[field.name] ?? "") + chars }));
    } else return;
    // Any edit past a failed submit clears the stale error line.
    setError(null);
  });
  return (
    <PromptPanel
      title="MCP request"
      subtitle={overlay.message}
      footer="↑↓/Tab field · type or paste · Enter submit · Esc cancel"
    >
      {overlay.fields.map((f, i) => (
        <Text key={f.name} color={i === index ? palette.promptAccent : undefined}>
          {i === index ? "❯ " : "  "}
          {/* `name` is the answer's key and is deliberately NOT sanitized in
              the store, so it is sanitized here for display. */}
          {sanitizeTerminalText(f.title ?? f.name)}: {values[f.name] ?? ""}
          {f.enum?.length ? ` [${f.enum.join("/")}]` : ""}
        </Text>
      ))}
      {error ? <Text color={palette.error}>{error}</Text> : null}
    </PromptPanel>
  );
}

export function ConfirmPrompt({ overlay }: { overlay: Extract<Overlay, { kind: "confirm" }> }) {
  const [selected, setSelected] = useState(0);
  const options: Array<{ label: string; value: boolean }> = [
    { label: "Yes", value: true },
    { label: "No", value: false },
  ];

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
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
    <PromptPanel title={overlay.header} footer={t("ui.prompt.cancelHint")}>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <PromptOption key={opt.label} index={i} selected={i === selected}>
            {opt.label}
          </PromptOption>
        ))}
      </Box>
    </PromptPanel>
  );
}
