// ============================================================
// InputBox — bordered prompt with cursor editing + "/" autocomplete
// ============================================================
// Built on Ink's useInput so we control editing precisely. A bordered "> "
// box with a movable cursor, and a dropdown of slash commands filtered by
// what's typed. Editing keys:
//   • ←/→        move the cursor within the buffer
//   • Home/End   jump to start / end of the buffer
//   • Backspace  delete the char *before* the cursor (input only)
//   • Delete     delete the char *under* the cursor
//   • Enter      submit · Tab accept highlighted completion
//   • ↑/↓        move the completion selection (only when the dropdown is open)
//
// The cursor is rendered *inline* — the buffer is split at the cursor and the
// char under it is drawn inverse. This lets Ink wrap the text naturally and
// keeps the cursor glued to its character when the line wraps (the old
// trailing-block cursor stayed stranded on the previous row).
// ============================================================

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { terminalColumns } from "./../terminal-width.js";

export interface CommandInfo {
  name: string;
  description: string;
}

const ORANGE = "#d77757";
const MAX_SUGGESTIONS = 8;
// Width of the input box's horizontal rules — flush to the terminal edges
// ("顶格"): the full column count, no side margin.
const RULE_WIDTH = Math.max(20, terminalColumns());

export function InputBox({
  commands,
  disabled,
  onSubmit,
  editorMode,
}: {
  commands: CommandInfo[];
  disabled: boolean;
  onSubmit: (value: string) => void;
  /** M18.10: shared holder toggled by /vim. When "vim", input is modal. */
  editorMode?: { value: "default" | "vim" };
}) {
  const vimActive = editorMode?.value === "vim";
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  // Vim sub-mode (only meaningful when vimActive). Starts in insert so typing
  // works immediately after /vim on; Esc drops to normal.
  const [vimMode, setVimMode] = useState<"normal" | "insert">("insert");

  const suggestions = buffer.startsWith("/")
    ? commands
        .filter((c) => c.name.startsWith(buffer.slice(1).split(/\s+/)[0]!.toLowerCase()))
        .slice(0, MAX_SUGGESTIONS)
    : [];

  const reset = () => {
    setBuffer("");
    setCursor(0);
    setSelected(0);
  };

  useInput(
    (input, key) => {
      // --- Vim normal mode (M18.10): motions + mode switches, no text input ---
      if (vimActive && vimMode === "normal") {
        if (key.return) {
          const value = buffer;
          reset();
          setVimMode("insert");
          onSubmit(value);
          return;
        }
        if (input === "i") { setVimMode("insert"); return; }
        if (input === "a") { setCursor((c) => Math.min(buffer.length, c + 1)); setVimMode("insert"); return; }
        if (input === "A") { setCursor(buffer.length); setVimMode("insert"); return; }
        if (input === "0" || (key as { home?: boolean }).home) { setCursor(0); return; }
        if (input === "$" || (key as { end?: boolean }).end) { setCursor(Math.max(0, buffer.length - 1)); return; }
        if (input === "h" || key.leftArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
        if (input === "l" || key.rightArrow) { setCursor((c) => Math.min(buffer.length, c + 1)); return; }
        if (input === "x") {
          if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
          return;
        }
        if (input === "D") { setBuffer((b) => b.slice(0, cursor)); return; }
        // Swallow everything else in normal mode (no stray text insertion).
        return;
      }

      // --- Esc: drop to vim normal mode (only when vim is active) ---
      if (key.escape && vimActive) {
        setVimMode("normal");
        setCursor((c) => Math.max(0, c - 1));
        return;
      }

      // --- Submit / completion ---
      if (key.return) {
        let value = buffer;
        // When the command palette is open and the user is still on the
        // command *name* (no args typed yet), Enter runs the highlighted
        // command — so "/" + Enter selects e.g. /help instead of submitting a
        // bare "/" (which would be "Unknown command: /").
        if (
          suggestions.length > 0 &&
          buffer.startsWith("/") &&
          !buffer.trimEnd().includes(" ")
        ) {
          value = "/" + suggestions[selected]!.name;
        }
        reset();
        onSubmit(value);
        return;
      }
      if (key.tab && suggestions.length > 0) {
        const next = "/" + suggestions[selected]!.name + " ";
        setBuffer(next);
        setCursor(next.length);
        setSelected(0);
        return;
      }

      // --- Dropdown navigation (only while it's open) ---
      if (key.upArrow && suggestions.length > 0) {
        setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow && suggestions.length > 0) {
        setSelected((s) => (s + 1) % suggestions.length);
        return;
      }

      // --- Cursor movement ---
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(buffer.length, c + 1));
        return;
      }
      // Ctrl+A / Ctrl+E (and Home/End where the terminal sends them) → edges.
      if ((key.ctrl && input === "a") || (key as { home?: boolean }).home) {
        setCursor(0);
        return;
      }
      if ((key.ctrl && input === "e") || (key as { end?: boolean }).end) {
        setCursor(buffer.length);
        return;
      }

      // --- Deletion (buffer only — never touches the hints/transcript) ---
      if (key.backspace) {
        if (cursor > 0) {
          setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
          setCursor((c) => c - 1);
        }
        return;
      }
      if (key.delete) {
        // Ink reports the Del key as `key.delete`; delete the char under the
        // cursor. (Some terminals map Backspace to delete=true too, but those
        // also set backspace=true, handled above.)
        if (cursor < buffer.length) {
          setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
        }
        return;
      }

      // --- Printable insertion at the cursor ---
      if (input && !key.ctrl && !key.meta && !key.escape) {
        setBuffer((b) => b.slice(0, cursor) + input + b.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      {/* Input box: a top + bottom horizontal rule with the prompt between,
          matching the reference layout (not a rounded border). */}
      <Text color={disabled ? "gray" : ORANGE}>{"─".repeat(RULE_WIDTH)}</Text>
      <Box>
        {vimActive ? (
          <Text color={vimMode === "normal" ? "yellow" : "green"}>
            {vimMode === "normal" ? "[N] " : "[I] "}
          </Text>
        ) : null}
        <Text color={disabled ? "gray" : ORANGE}>{"> "}</Text>
        <CursorText buffer={buffer} cursor={cursor} showCursor={!disabled} />
      </Box>
      <Text color={disabled ? "gray" : ORANGE}>{"─".repeat(RULE_WIDTH)}</Text>
      {suggestions.length > 0 ? (
        <Box flexDirection="column">
          {suggestions.map((s, i) => (
            <Text key={s.name} color={i === selected ? ORANGE : "cyan"}>
              {i === selected ? "❯ " : "  "}/{s.name}
              <Text dimColor> {s.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Render the buffer with an inline block cursor. Splitting at the cursor and
 * drawing the char under it inverse keeps the cursor attached to its glyph as
 * the text wraps, rather than floating at the end of the previous line.
 */
function CursorText({
  buffer,
  cursor,
  showCursor,
}: {
  buffer: string;
  cursor: number;
  showCursor: boolean;
}) {
  if (!showCursor) {
    return <Text>{buffer}</Text>;
  }
  const before = buffer.slice(0, cursor);
  const under = buffer.slice(cursor, cursor + 1) || " ";
  const after = buffer.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  );
}
