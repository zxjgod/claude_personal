// ============================================================
// HelpPanel — keyboard shortcuts + permission mode reference overlay
// ============================================================
// Triggered by pressing "?" in the main App. Shows the global shortcuts and
// the permission-mode cycle, and dismisses on Esc or Enter.
//
// Two invariants this panel must keep, because it is the list users trust:
//   1. Every row maps to a live handler. Documented-but-unimplemented keys
//      ("← agents", mouse-wheel scroll) must not reappear here.
//   2. The mode list comes from PERMISSION_MODE_CYCLE — the same constant the
//      Shift+Tab handler in store.ts cycles — so the panel can never again
//      disagree with the key it documents (it previously listed the stale
//      default→acceptEdits→bypassPermissions→plan order while the shortcut row
//      directly beneath it printed the correct one).
//
// All copy is in i18n.ts (en + zh-CN). Key-column labels stay literal: they
// are key names, not prose.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { t } from "./i18n.js";
import { wrapVisualLines } from "./live-window.js";
import { EXIT_DOUBLE_PRESS_MS, PERMISSION_MODE_CYCLE } from "./store.js";
import { padAligned, visualWidth } from "./terminal-width.js";
import { palette } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";

/** Interpolation values for the description — keeps copy that quotes a
 *  constant (the 800ms exit window) tied to the constant itself. */
type Shortcut = { keys: string; descKey: string; descParams?: Record<string, string | number> };

/** Only shortcuts that are actually wired — see invariant 1 above. */
const SHORTCUTS: Shortcut[] = [
  { keys: "Shift+Tab / Alt+M", descKey: "ui.help.shortcut.modeCycle" },
  { keys: "Esc / Ctrl+C", descKey: "ui.help.shortcut.interrupt" },
  {
    keys: "Ctrl+D",
    descKey: "ui.help.shortcut.exit",
    descParams: { ms: EXIT_DOUBLE_PRESS_MS },
  },
  { keys: "Esc Esc", descKey: "ui.help.shortcut.rewind" },
  { keys: "Ctrl+O", descKey: "ui.help.shortcut.verbose" },
  { keys: "Ctrl+R", descKey: "ui.help.shortcut.history" },
  { keys: "Ctrl+S", descKey: "ui.help.shortcut.stash" },
  { keys: "Ctrl+G", descKey: "ui.help.shortcut.editor" },
  { keys: "Ctrl+T", descKey: "ui.help.shortcut.todos" },
  { keys: "Ctrl+L", descKey: "ui.help.shortcut.clear" },
  { keys: "Alt+P / Alt+T", descKey: "ui.help.shortcut.model" },
  { keys: "!", descKey: "ui.help.shortcut.bash" },
  { keys: "#", descKey: "ui.help.shortcut.memory" },
  { keys: "Ctrl/Alt+V", descKey: "ui.help.shortcut.image" },
  { keys: "?", descKey: "ui.help.shortcut.help" },
  { keys: "/", descKey: "ui.help.shortcut.slash" },
  { keys: "@path", descKey: "ui.help.shortcut.at" },
  { keys: "↑ / ↓", descKey: "ui.help.shortcut.arrows" },
  { keys: "Ctrl+← / Ctrl+→", descKey: "ui.help.shortcut.word" },
  { keys: "PgUp", descKey: "ui.help.shortcut.pgup" },
  { keys: "/ n N { }", descKey: "ui.help.shortcut.viewerKeys" },
  { keys: "v", descKey: "ui.help.shortcut.viewerEditor" },
  { keys: "PgUp/PgDn · Ctrl+B/F", descKey: "ui.help.shortcut.fsScroll" },
  { keys: "Ctrl+End / G", descKey: "ui.help.shortcut.fsBottom" },
];

/** Mode display name (the identifier users pass to /mode) → its description. */
const MODE_DESC_KEYS: Record<string, string> = {
  default: "ui.help.mode.default",
  acceptEdits: "ui.help.mode.acceptEdits",
  plan: "ui.help.mode.plan",
  bypassPermissions: "ui.help.mode.bypassPermissions",
};

/** Widest key label, so the description column starts at the same x on every
 *  row regardless of which shortcuts are currently listed. */
const KEY_COL = Math.max(...SHORTCUTS.map((s) => visualWidth(s.keys))) + 3;

export interface HelpLine {
  label: string;
  description: string;
  color: string;
  heading?: boolean;
}

/** Explicit display rows keep columns aligned and make every wrapped line scrollable. */
export function helpLines(contentWidth: number, currentMode: string): HelpLine[] {
  const labelWidth = Math.min(KEY_COL, Math.max(8, Math.floor(contentWidth * 0.45)));
  const descriptionWidth = Math.max(1, contentWidth - labelWidth - 2);
  const lines: HelpLine[] = [];
  const heading = (key: string) => {
    for (const description of wrapVisualLines(t(key), contentWidth)) {
      lines.push({ label: "", description, color: palette.promptAccent, heading: true });
    }
  };
  const row = (label: string, description: string, color: string) => {
    const labels = wrapVisualLines(label, labelWidth);
    const descriptions = wrapVisualLines(description, descriptionWidth);
    for (let i = 0; i < Math.max(labels.length, descriptions.length); i++) {
      const left = labels[i] ?? "";
      lines.push({
        label: padAligned(left, visualWidth(left), labelWidth) + "  ",
        description: descriptions[i] ?? "",
        color,
      });
    }
  };
  const spacer = () => lines.push({ label: "", description: "", color: palette.secondary });
  heading("ui.help.section.shortcuts");
  for (const shortcut of SHORTCUTS) {
    row(`  ${shortcut.keys}`, t(shortcut.descKey, shortcut.descParams), palette.promptAccent);
  }
  spacer();
  heading("ui.help.section.modes");
  for (const mode of PERMISSION_MODE_CYCLE) {
    row(
      `  ${mode === currentMode ? "❯ " : "  "}${mode}`,
      t(MODE_DESC_KEYS[mode] ?? mode),
      mode === currentMode ? palette.promptAccent : palette.secondary,
    );
  }
  return lines;
}

export function HelpPanel({
  currentMode,
  onClose,
  maxHeight,
}: {
  currentMode: string;
  onClose: () => void;
  maxHeight?: number;
}) {
  const { columns, rows } = useTerminalSize();
  const width = Math.max(16, Math.min(columns - 2, 140));
  const lines = helpLines(width - 4, currentMode);
  const visibleRows = Math.min(lines.length, Math.max(1, (maxHeight ?? rows - 4) - 6));
  const maxOffset = Math.max(0, lines.length - visibleRows);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const start = Math.min(offset, maxOffset);
  const scrollable = maxOffset > 0;
  useInput((input, key) => {
    if (key.escape || key.return) return onClose();
    let next = Math.min(offsetRef.current, maxOffset);
    if (key.upArrow) next--;
    else if (key.downArrow) next++;
    else if (key.pageUp || (key.ctrl && input === "b")) next -= visibleRows;
    else if (key.pageDown || (key.ctrl && input === "f")) next += visibleRows;
    else if (key.home) next = 0;
    else if (key.end) next = maxOffset;
    else return;
    next = Math.max(0, Math.min(next, maxOffset));
    offsetRef.current = next;
    setOffset(next);
  });

  return (
    <Box justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.promptAccent}
        paddingX={1}
        width={width}
      >
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={palette.promptAccent}>
            {t("ui.help.title")}
            {scrollable ? ` ${start + 1}-${start + visibleRows}/${lines.length}` : ""}
          </Text>
        </Box>

        <Box flexDirection="column" height={visibleRows} flexShrink={0}>
          {lines.slice(start, start + visibleRows).map((line, i) => (
            <Text key={start + i}>
              <Text color={line.color} bold={line.heading}>
                {line.label}
              </Text>
              <Text
                color={line.heading ? palette.promptAccent : palette.secondary}
                bold={line.heading}
              >
                {line.description || (line.label ? "" : " ")}
              </Text>
            </Text>
          ))}
        </Box>

        <Box justifyContent="center" marginTop={1}>
          <Text color={palette.secondary}>
            {scrollable ? "↑↓ · " : ""}
            {t("ui.help.close")}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
