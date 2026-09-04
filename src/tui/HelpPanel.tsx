// ============================================================
// HelpPanel — keyboard shortcuts + permission mode reference overlay (M38)
// ============================================================
// Triggered by pressing "?" in the main App. Shows:
//   • Global shortcuts (Shift+Tab, Ctrl+C, ?, /)
//   • Permission mode cycle with descriptions
// Esc or Enter dismisses.
// ============================================================

import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { terminalColumns } from "./terminal-width.js";
import { palette } from "./theme.js";

const MODES: Array<{ name: string; description: string }> = [
  {
    name: "default",
    description: "Ask before running tools that modify files or execute commands",
  },
  { name: "acceptEdits", description: "Auto-approve Read/Edit/Write tools without prompting" },
  {
    name: "bypassPermissions",
    description: "Auto-approve all tools except dangerous patterns (rm -rf, sudo, pipe-to-shell)",
  },
  {
    name: "plan",
    description: "Plan only — describe what would happen without executing destructive tools",
  },
];

// Only shortcuts that are actually wired. Every row here must have a live
// handler — this panel is the source users trust, so documented-but-unimplemented
// keys ("← agents", mouse-wheel scroll) must not reappear.
const SHORTCUTS: Array<[string, string]> = [
  ["Shift+Tab", "Cycle permission mode (default → acceptEdits → bypassPermissions → plan)"],
  ["Esc / Ctrl+C", "Interrupt the running turn · Ctrl+C exits when idle"],
  ["Esc Esc", "Rewind to an earlier message and restore files (idle, empty input)"],
  ["Ctrl+O", "Toggle the verbose transcript viewer (full tool output + thinking)"],
  ["Ctrl+R", "Expand the latest collapsed tool output"],
  ["Ctrl/Alt+V", "Paste a clipboard image as an [Image #N] attachment"],
  ["?", "Show this help panel"],
  ["/", "Slash command palette (Tab accepts the selection)"],
  ["@path", "File-path completion at the cursor (Tab inserts · Esc closes)"],
  ["↑ / ↓", "Palette selection · input history when the palette is closed"],
  ["Ctrl+← / Ctrl+→", "Jump to the previous / next word in the input"],
  ["PgUp", "Open the transcript viewer (scroll while the model streams)"],
  ["/ n N { }", "Search / next / previous match · jump between prompts (in viewer)"],
  ["v", "Open the transcript in $VISUAL/$EDITOR (in viewer)"],
  ["PgUp/PgDn · Ctrl+B/F", "Scroll the transcript (full-screen mode)"],
  ["Ctrl+End / G", "Jump to the bottom (full-screen mode)"],
];

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
        {`  ${keys.padEnd(22)}`}
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
  const cols = Math.min(terminalColumns(), 80);

  useInput((_input, key) => {
    if (key.escape || key.return) onClose();
  });

  const width = Math.min(cols, 72);

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
            Keyboard Shortcuts
          </Text>
        </Box>

        <Section title="Global shortcuts">
          {SHORTCUTS.map(([keys, desc]) => (
            <ShortcutRow key={keys} keys={keys} desc={desc} />
          ))}
        </Section>

        <Section title="Permission modes (Shift+Tab to cycle)">
          {MODES.map((m) => (
            <ModeRow
              key={m.name}
              name={m.name}
              description={m.description}
              current={m.name === currentMode}
            />
          ))}
        </Section>

        <Box justifyContent="center" marginTop={1}>
          <Text dimColor>Esc or Enter to close</Text>
        </Box>
      </Box>
    </Box>
  );
}
