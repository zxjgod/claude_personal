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

const SHORTCUTS = [
  ["Shift+Tab", "Cycle permission mode (default → acceptEdits → bypassPermissions → plan)"],
  ["Ctrl+C", "Interrupt the current agent turn"],
  ["?", "Show this help panel"],
  ["/", "Open command palette"],
  ["← (left arrow)", "Switch to agent list panel"],
  ["↑↓ / 鼠标滚轮", "滚动查看历史消息"],
  ["Ctrl+U / Ctrl+D", "快速滚动半页（全屏模式）"],
  ["Ctrl+End or G", "Jump to bottom (full-screen mode)"],
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
  const pad = Math.max(0, Math.floor((cols - width) / 2));

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
