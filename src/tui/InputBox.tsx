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
//   • Ctrl+J     insert a newline (multi-line input; "\" + Enter also works)
//   • ↑/↓        move the completion selection when the palette is open;
//                otherwise move the cursor between logical lines (M25.1)
//
// The cursor is rendered *inline* — the buffer is split at the cursor and the
// char under it is drawn inverse. This lets Ink wrap the text naturally and
// keeps the cursor glued to its character when the line wraps (the old
// trailing-block cursor stayed stranded on the previous row).
//
// M25.1: the buffer can contain "\n". The cursor is a single linear offset into
// the buffer; line/column are derived from it (see cursorRowCol). ↑/↓ move the
// offset to the same column on the adjacent logical line when the palette is
// closed, so the box behaves like a small multi-line editor.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { terminalColumns } from "./../terminal-width.js";

export interface CommandInfo {
  name: string;
  description: string;
}

const ORANGE = "#d77757";
const MAX_SUGGESTIONS = 8;

// Width of the input box's horizontal rules. We leave ONE column of slack
// (`cols - 1`) rather than going flush to the terminal edge: a rule exactly as
// wide as the terminal trips DECAWM (auto-wrap), so the terminal emits a
// phantom wrapped row that Ink's line model doesn't account for. On every
// InputBox re-render Ink then clears/repaints the dynamic region off by a row,
// which is what made the input box "jump" on each ASCII keystroke/backspace
// (CJK input goes through the IME and re-renders far less, so it didn't jump —
// the tell that pointed here). Every other rule in the codebase already leaves
// this slack (cli-renderer, cli-spinner, markdown); InputBox was the lone
// flush-width outlier. Computed per-render so it tracks terminal resize.
function ruleWidth(): number {
  return Math.max(20, terminalColumns() - 1);
}

// --- Multi-line cursor helpers (M25.1) ---
// The buffer is a single string that may contain "\n"; the cursor is one linear
// offset into it. These derive (row, col) from the offset and back, so ↑/↓ can
// move to the same column on the adjacent logical line.

/** Split a buffer into logical lines (kept simple — no wrap awareness). */
function splitLines(buffer: string): string[] {
  return buffer.split("\n");
}

/** Linear offset → { row, col } over logical lines. col is within the row. */
function offsetToRowCol(buffer: string, offset: number): { row: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, buffer.length));
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (buffer[i] === "\n") {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, col: clamped - lineStart };
}

/** { row, col } → linear offset, clamping col to the target row's length. */
function rowColToOffset(buffer: string, row: number, col: number): number {
  const lines = splitLines(buffer);
  const r = Math.max(0, Math.min(row, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < r; i++) offset += lines[i]!.length + 1; // +1 for the "\n"
  return offset + Math.min(col, lines[r]!.length);
}

export function InputBox({
  commands,
  disabled,
  onSubmit,
  editorMode,
  keepColorWhenDisabled,
  hideBottomRule,
}: {
  commands: CommandInfo[];
  disabled: boolean;
  onSubmit: (value: string) => void;
  /** M18.10: shared holder toggled by /vim. When "vim", input is modal. */
  editorMode?: { value: "default" | "vim" };
  /** M25.2 fix: in full-screen mode the box stays orange while the agent is
   *  busy (rather than greying out) so it doesn't read as "white + narrower".
   *  The cursor is still hidden while disabled. */
  keepColorWhenDisabled?: boolean;
  /** M25.2 fix: drop the bottom rule so the prompt row is the LAST rendered
   *  line. The terminal parks its real cursor at the end of the final row, so
   *  if a rule rendered below the prompt the cursor blinked one line too low.
   *  Full-screen passes this; the default path keeps the symmetric box. */
  hideBottomRule?: boolean;
}) {
  const vimActive = editorMode?.value === "vim";
  // Frame color: grey out when disabled UNLESS the caller asks to keep the
  // accent (full-screen path). The input remains inactive either way.
  const frameColor = disabled && !keepColorWhenDisabled ? "gray" : ORANGE;
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

  // `selected` is plain state that can outlive a shrinking filtered list:
  // type "/", arrow down to a high index, then narrow the query and the list
  // gets shorter while `selected` stays put — now pointing past the end.
  // Clamp at every read site so Enter / Tab / render never deref undefined.
  // (This was a latent crash: `suggestions[selected]!.name` on a stale index.)
  const safeSelected = suggestions.length > 0 ? Math.min(selected, suggestions.length - 1) : 0;

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
        if (input === "i") {
          setVimMode("insert");
          return;
        }
        if (input === "a") {
          setCursor((c) => Math.min(buffer.length, c + 1));
          setVimMode("insert");
          return;
        }
        if (input === "A") {
          setCursor(buffer.length);
          setVimMode("insert");
          return;
        }
        if (input === "0" || (key as { home?: boolean }).home) {
          setCursor(0);
          return;
        }
        if (input === "$" || (key as { end?: boolean }).end) {
          setCursor(Math.max(0, buffer.length - 1));
          return;
        }
        if (input === "h" || key.leftArrow) {
          setCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (input === "l" || key.rightArrow) {
          setCursor((c) => Math.min(buffer.length, c + 1));
          return;
        }
        if (input === "x") {
          if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
          return;
        }
        if (input === "D") {
          setBuffer((b) => b.slice(0, cursor));
          return;
        }
        // Swallow everything else in normal mode (no stray text insertion).
        return;
      }

      // --- Esc: drop to vim normal mode (only when vim is active) ---
      if (key.escape && vimActive) {
        setVimMode("normal");
        setCursor((c) => Math.max(0, c - 1));
        return;
      }

      // --- Newline insertion (multi-line input, M25.1) ---
      // Ctrl+J inserts a newline. So does "\" immediately before Enter: if the
      // char left of the cursor is a backslash, Enter replaces it with a
      // newline instead of submitting (matches the reference editor).
      if (key.ctrl && input === "j") {
        setBuffer((b) => b.slice(0, cursor) + "\n" + b.slice(cursor));
        setCursor((c) => c + 1);
        return;
      }

      // --- Submit / completion ---
      if (key.return) {
        // "\" + Enter → newline (continue editing) rather than submit.
        if (cursor > 0 && buffer[cursor - 1] === "\\") {
          setBuffer((b) => b.slice(0, cursor - 1) + "\n" + b.slice(cursor));
          // cursor stays put: removed "\" (−1) then added "\n" (+1).
          return;
        }
        let value = buffer;
        // When the command palette is open and the user is still on the
        // command *name* (no args typed yet), Enter runs the highlighted
        // command — so "/" + Enter selects e.g. /help instead of submitting a
        // bare "/" (which would be "Unknown command: /").
        if (suggestions.length > 0 && buffer.startsWith("/") && !buffer.trimEnd().includes(" ")) {
          value = "/" + suggestions[safeSelected].name;
        }
        reset();
        onSubmit(value);
        return;
      }
      if (key.tab && suggestions.length > 0) {
        const next = "/" + suggestions[safeSelected].name + " ";
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

      // --- Multi-line cursor movement (palette closed, M25.1) ---
      // With the palette closed, ↑/↓ move the cursor to the same column on the
      // adjacent logical line. On the first/last line they're a no-op (no
      // history navigation in this TUI — kept minimal).
      if (key.upArrow) {
        const { row, col } = offsetToRowCol(buffer, cursor);
        if (row > 0) setCursor(rowColToOffset(buffer, row - 1, col));
        return;
      }
      if (key.downArrow) {
        const { row, col } = offsetToRowCol(buffer, cursor);
        if (row < splitLines(buffer).length - 1) setCursor(rowColToOffset(buffer, row + 1, col));
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
      // Ctrl+A / Ctrl+E (and Home/End where the terminal sends them) → jump to
      // the start / end of the CURRENT logical line (M25.1: line-relative, so a
      // multi-line buffer behaves like a normal editor; single-line is the
      // whole buffer as before).
      if ((key.ctrl && input === "a") || (key as { home?: boolean }).home) {
        const { row } = offsetToRowCol(buffer, cursor);
        setCursor(rowColToOffset(buffer, row, 0));
        return;
      }
      if ((key.ctrl && input === "e") || (key as { end?: boolean }).end) {
        const { row } = offsetToRowCol(buffer, cursor);
        setCursor(rowColToOffset(buffer, row, splitLines(buffer)[row]!.length));
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

  // Read terminal width at render time so the rule tracks resize. (See
  // ruleWidth's note on why we leave one column of slack.)
  const rule = "─".repeat(ruleWidth());

  // M25.1: render each logical line on its own row so a multi-line buffer
  // displays as multiple rows. The "> " prompt sits on the first line; wrapped
  // continuation rows get a matching two-space indent so text aligns under it.
  const lines = splitLines(buffer);
  const { row: curRow, col: curCol } = offsetToRowCol(buffer, cursor);

  const suggestionList =
    suggestions.length > 0 ? (
      <Box flexDirection="column">
        {suggestions.map((s, i) => (
          <Text key={s.name} color={i === safeSelected ? ORANGE : "cyan"}>
            {i === safeSelected ? "❯ " : "  "}/{s.name}
            <Text dimColor> {s.description}</Text>
          </Text>
        ))}
      </Box>
    ) : null;

  const promptRows = lines.map((line, i) => (
    <Box key={i}>
      {i === 0 && vimActive ? (
        <Text color={vimMode === "normal" ? "yellow" : "green"}>
          {vimMode === "normal" ? "[N] " : "[I] "}
        </Text>
      ) : null}
      <Text color={frameColor}>{i === 0 ? "> " : "  "}</Text>
      <CursorLine
        line={line}
        // The cursor is only drawn on the row it sits on; other rows render
        // their text plainly.
        cursorCol={!disabled && i === curRow ? curCol : -1}
      />
    </Box>
  ));

  // Full-screen (hideBottomRule): suggestions go ABOVE the box and the bottom
  // rule is dropped, so the prompt row is the very last rendered line — the
  // terminal then parks its real cursor exactly on the prompt. Default path:
  // symmetric box with the suggestion dropdown below.
  if (hideBottomRule) {
    return (
      <Box flexDirection="column">
        {suggestionList}
        <Text color={frameColor}>{rule}</Text>
        {promptRows}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Input box: a top + bottom horizontal rule with the prompt between,
          matching the reference layout (not a rounded border). */}
      <Text color={frameColor}>{rule}</Text>
      {promptRows}
      <Text color={frameColor}>{rule}</Text>
      {suggestionList}
    </Box>
  );
}

/**
 * Render one logical line with an optional inline block cursor at `cursorCol`
 * (−1 = no cursor on this line). Splitting at the cursor and drawing the char
 * under it inverse keeps the cursor attached to its glyph as the text wraps.
 */
function CursorLine({ line, cursorCol }: { line: string; cursorCol: number }) {
  if (cursorCol < 0) {
    // No cursor on this row. Render a space for an empty line so the row keeps
    // height (Ink collapses a fully-empty <Text>).
    return <Text>{line.length > 0 ? line : " "}</Text>;
  }
  const before = line.slice(0, cursorCol);
  const under = line.slice(cursorCol, cursorCol + 1) || " ";
  const after = line.slice(cursorCol + 1);
  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  );
}
