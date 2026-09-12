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
import type { ReactNode } from "react";
import { t } from "./i18n.js";
import { EXIT_DOUBLE_PRESS_MS, PERMISSION_MODE_CYCLE } from "./store.js";
import { padAligned, terminalColumns, visualWidth } from "./terminal-width.js";
import { palette } from "./theme.js";

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={palette.accent}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <Box>
      <Text color={palette.command} wrap="truncate">
        {`  ${padAligned(keys, visualWidth(keys), KEY_COL, "left")}`}
      </Text>
      <Text dimColor wrap="truncate">
        {desc}
      </Text>
    </Box>
  );
}

function ModeRow({
  name,
  description,
  current,
}: {
  name: string;
  description: string;
  current: boolean;
}) {
  return (
    <Box>
      <Text color={current ? palette.accent : palette.command}>
        {`  ${current ? "❯ " : "  "}${name.padEnd(18)}`}
      </Text>
      <Text dimColor wrap="truncate">
        {description}
      </Text>
    </Box>
  );
}

export function HelpPanel({ currentMode, onClose }: { currentMode: string; onClose: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose();
  });

  // Width-adaptive: fill the terminal up to a comfortable reading measure,
  // while never collapsing below the point where the two columns still read.
  const width = Math.max(56, Math.min(terminalColumns() - 2, 78));

  return (
    <Box justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.accent}
        paddingX={1}
        width={width}
      >
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={palette.accent}>
            {t("ui.help.title")}
          </Text>
        </Box>

        <Section title={t("ui.help.section.shortcuts")}>
          {SHORTCUTS.map((s) => (
            <ShortcutRow key={s.keys} keys={s.keys} desc={t(s.descKey, s.descParams)} />
          ))}
        </Section>

        <Section title={t("ui.help.section.modes")}>
          {PERMISSION_MODE_CYCLE.map((mode) => (
            <ModeRow
              key={mode}
              name={mode}
              description={t(MODE_DESC_KEYS[mode] ?? mode)}
              current={mode === currentMode}
            />
          ))}
        </Section>

        <Box justifyContent="center" marginTop={1}>
          <Text dimColor>{t("ui.help.close")}</Text>
        </Box>
      </Box>
    </Box>
  );
}
