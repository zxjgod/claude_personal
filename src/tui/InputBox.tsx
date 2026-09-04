// ============================================================
// InputBox — bordered prompt with cursor editing + "/" and "@" autocomplete
// ============================================================
// Built on Ink's useInput so we control editing precisely. A bordered "> "
// box with a movable cursor, and a dropdown of slash commands filtered by
// what's typed. Editing keys:
//   • ←/→        move the cursor within the buffer
//   • Ctrl+←/→   jump to the previous/next word
//   • Home/End   jump to start / end of the buffer
//   • Backspace  delete the char *before* the cursor (input only)
//   • Delete     delete the char *under* the cursor
//   • Enter      submit · Tab accept highlighted completion
//   • Ctrl+J     insert a newline (multi-line input; "\" + Enter also works)
//   • ↑/↓        move history (palette closed) or selection (palette open)
//   • Ctrl+U     delete from cursor to beginning of line (M41)
//   • Ctrl+K     delete from cursor to end of line (M41)
//   • Ctrl+W     delete word before cursor (M41)
//   • Esc        close the open dropdown ("/" palette or "@" files)
//   • Esc Esc    rewind menu (idle + empty buffer; first Esc clears a draft) — P0-3
//   • Ctrl/Alt+V paste a clipboard image as an "[Image #N]" chip — P0-5
//
// Two dropdown sources, mutually exclusive by their trigger:
//   "/" at the start of the buffer → slash-command palette
//   "@word" at the cursor          → workspace file completion (P2-10);
//                                    Tab inserts the full path. The submit
//                                    side (expandFileRefs) attaches it.
//
// Pasted text arrives through Ink's usePaste (bracketed paste): newlines are
// normalized to "\n" and a paste of >5 lines shows a one-shot note so an
// accidental middle-click paste of 50 lines is visible before Enter sends it.
//
// The cursor is rendered *inline* — the buffer is split at the cursor and the
// char under it is drawn inverse. This lets Ink wrap the text naturally and
// keeps the cursor glued to its character when the line wraps (the old
// trailing-block cursor stayed stranded on the previous row).
//
// M25.1: the buffer can contain "\n". The cursor is a single linear offset into
// the buffer; line/column are derived from it (see cursorRowCol). ↑/↓ move
// the offset to the same column on the adjacent logical line when the palette
// is closed, so the box behaves like a small multi-line editor.
//
// M41: input history — ↑/↓ navigate the command history when the "/" palette
// is closed. History is passed in from the parent so it can be persisted across
// turns.
// ============================================================

import { Box, Text, useInput, usePaste } from "ink";
import { useEffect, useRef, useState } from "react";
import { t } from "./i18n.js";
import { nextOffset } from "./SessionPicker.js";
import { terminalColumns } from "./terminal-width.js";
import { palette } from "./theme.js";
import { VimEngine } from "./vim/index.js";

export interface CommandInfo {
  name: string;
  description: string;
}

/** Maximum number of history entries to keep. */
const MAX_HISTORY_SIZE = 100;

const ORANGE = palette.accent;
/** How many command rows the inline "/" dropdown shows at once before it
 *  scrolls. The full filtered list is kept and windowed around the selection
 *  (see the render below) so every command is reachable, not just the first 8. */
const MAX_SUGGESTIONS = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

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

/** Delete the word before the cursor. Words are separated by whitespace.
 *  Standard Unix Ctrl+W behavior: delete word and trailing whitespace,
 *  but preserve at least one space between words. */
function deleteWordBefore(
  buffer: string,
  cursor: number,
): { newBuffer: string; newCursor: number } {
  const before = buffer.slice(0, cursor);
  // Match: optional whitespace, then word characters (no trailing whitespace)
  // This matches "query" in "test query|" and deletes only the word.
  const match = before.match(/\s*(\S+)\s*$/);
  if (!match) {
    // No word before cursor, just delete trailing whitespace
    const newBefore = before.replace(/\s+$/, "");
    return { newBuffer: newBefore + buffer.slice(cursor), newCursor: newBefore.length };
  }
  const deleted = match[0]!.length;
  const newBefore = before.slice(0, before.length - deleted);
  // Add back one space if there's content before and after
  const after = buffer.slice(cursor);
  const needsSpace =
    newBefore.length > 0 && after.length > 0 && !newBefore.endsWith(" ") && !after.startsWith(" ");
  const spacePrefix = needsSpace ? " " : "";
  return {
    newBuffer: newBefore + spacePrefix + after,
    newCursor: newBefore.length + (needsSpace ? 1 : 0),
  };
}

/** Map an Ink keystroke to a single vim-engine key token. */
function inkKeyToVim(
  input: string,
  key: { leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean },
): string {
  if (key.leftArrow) return "h";
  if (key.rightArrow) return "l";
  if (key.upArrow) return "k";
  if (key.downArrow) return "j";
  return input;
}

/**
 * The "@word" at the cursor: the run of non-whitespace ending at the cursor
 * that begins with '@'. Returns the query plus the buffer offset of the '@'
 * so an accepted completion can replace exactly that span (nothing before or
 * after the word moves). `@` alone (no chars typed) opens nothing — dumping
 * eight arbitrary paths before the user narrows is noise.
 */
function atTokenAt(buffer: string, cursor: number): { query: string; start: number } | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(buffer[start - 1]!)) start--;
  const word = buffer.slice(start, cursor);
  if (!word.startsWith("@") || word.length < 2) return null;
  return { query: word.slice(1), start };
}

/** Offset of the start of the word before `cursor` (skips whitespace, then
 *  the non-whitespace run) — the Ctrl+← jump target. */
function wordStartBefore(buffer: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(buffer[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(buffer[i - 1]!)) i--;
  return i;
}

/** Offset just past the end of the word after `cursor` — the Ctrl+→ target. */
function wordEndAfter(buffer: string, cursor: number): number {
  let i = cursor;
  while (i < buffer.length && /\s/.test(buffer[i]!)) i++;
  while (i < buffer.length && !/\s/.test(buffer[i]!)) i++;
  return i;
}

export interface InputBoxProps {
  commands: CommandInfo[];
  disabled: boolean;
  busy?: boolean;
  onSubmit: (value: string) => void;
  editorMode?: { value: "default" | "vim" };
  keepColorWhenDisabled?: boolean;
  hideBottomRule?: boolean;
  /** P2-10: workspace path matcher for "@" completions. Absent = the "@"
   *  dropdown is disabled (e.g. tests that don't touch the fs). */
  completeFiles?: (query: string) => string[];
  /** M41: input history for ↑/↓ navigation. Pass an array and a setter;
   *  the component pushes submitted values onto the array and drives the
   *  navigation index internally. */
  history?: string[];
  onHistoryChange?: (history: string[]) => void;
  /** P0-3: double-Esc rewind trigger. Called on the second Esc within 2s while
   *  idle with an empty buffer (first Esc clears a non-empty draft). Omit to
   *  disable (busy turns pass undefined). */
  onRewind?: () => void;
  /** P0-5: read a clipboard image (Ctrl/Cmd/Alt+V). Resolves with the
   *  "[Image #N]" chip text (already registered by the runner) or null. */
  onImagePaste?: () => Promise<string | null>;
}

/** Pastes longer than this show the "已粘贴 N 行" note (lines, threshold). */
const PASTE_NOTE_LINES = 5;

export function InputBox({
  commands,
  disabled,
  busy,
  onSubmit,
  editorMode,
  keepColorWhenDisabled,
  hideBottomRule,
  completeFiles,
  history: externalHistory,
  onHistoryChange,
  onRewind,
  onImagePaste,
}: InputBoxProps) {
  const vimActive = editorMode?.value === "vim";
  // Frame color: grey out when disabled UNLESS the caller asks to keep the
  // accent (full-screen path). The input remains inactive either way.
  const frameColor = disabled && !keepColorWhenDisabled ? "gray" : ORANGE;
  const [buffer, setBufferState] = useState("");
  const [cursor, setCursorState] = useState(0);
  const [selected, setSelected] = useState(0);
  // First-visible index of the dropdown scroll window; nudged as `selected`
  // moves so the highlighted command stays on screen (see MAX_SUGGESTIONS).
  const [suggestOffset, setSuggestOffset] = useState(0);
  // Dropdown dismissal (Esc): stores the query that was dismissed so the
  // dropdown reopens only once the user types a different query. One marker
  // per dropdown kind ("/" and "@").
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [atDismissed, setAtDismissed] = useState<string | null>(null);
  const [fileSelected, setFileSelected] = useState(0);
  // One-shot note shown after a large paste; cleared by the next keypress.
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  // P0-3: double-Esc rewind arming. First Esc (idle, empty buffer, non-vim)
  // arms; a second Esc within 2s fires onRewind. Any other key disarms.
  const escArmedRef = useRef(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // P0-5: draft generation. Bumped whenever the buffer is wholesale replaced
  // (submit / Esc-clear), so a slow in-flight clipboard read can detect that
  // the draft it snapshotted is gone and drop its chip instead of splicing
  // it into the next draft.
  const draftGenRef = useRef(0);
  const disarmEsc = () => {
    escArmedRef.current = false;
    if (escTimerRef.current !== null) {
      clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
    }
  };
  useEffect(() => {
    return () => {
      if (escTimerRef.current !== null) clearTimeout(escTimerRef.current);
    };
  }, []);
  // Vim sub-mode (only meaningful when vimActive). Starts in insert so typing
  // works immediately after /vim on; Esc drops to normal.
  const [vimMode, setVimMode] = useState<"normal" | "insert">("insert");

  // Refs for synchronous access (React state is async, refs are sync)
  const bufferRef = useRef("");
  bufferRef.current = buffer;
  const cursorRef = useRef(0);
  cursorRef.current = cursor;
  // Vim engine (only used when vimActive): persists across normal-mode keys so
  // multi-key operators (d/w, dd, 3w, …) keep their state machine between
  // keystrokes. Lazily created; text/offset re-synced from buffer on each key.
  const vimEngineRef = useRef<VimEngine | null>(null);

  // Wrappers that keep the refs in sync SYNCHRONOUSLY (computed from the ref,
  // not inside React's updater). A single stdin chunk can carry several
  // keypresses (key bursts / fast terminals); if the ref write waited inside
  // the state updater, the second keypress in the same batch would read the
  // pre-first-keypress value (e.g. two Ctrl+← jumps in one chunk both jumping
  // from the same origin). The refs are the handler-side source of truth;
  // state just mirrors them for render.
  const setCursor = (updater: number | ((prev: number) => number)) => {
    const next = typeof updater === "function" ? updater(cursorRef.current) : updater;
    cursorRef.current = next;
    setCursorState(next);
  };

  const setBuffer = (updater: string | ((prev: string) => string)) => {
    const next = typeof updater === "function" ? updater(bufferRef.current) : updater;
    bufferRef.current = next;
    setBufferState(next);
  };

  // M41: input history state. Managed internally but synced to external array
  // so the parent can persist it across turns. The history array stores items
  // in chronological order (oldest first), so index 0 = oldest, last = newest.
  // When navigating, historyIndex=0 means the most recent entry.
  const [history, setHistoryState] = useState<string[]>(externalHistory ?? []);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = current buffer, 0 = most recent
  const historyRef = useRef(history);
  historyRef.current = history;
  // Track if we're displaying a history item so we know to restore on edit.
  const historyRestoreRef = useRef<string | null>(null);

  // Sync external history changes into local state.
  useEffect(() => {
    if (externalHistory !== undefined) {
      setHistoryState(externalHistory);
    }
  }, [externalHistory]);

  // Push to history + sync to parent on submit.
  const pushHistory = (value: string) => {
    if (!value.trim()) return;
    const next = [...historyRef.current, value].slice(-MAX_HISTORY_SIZE);
    setHistoryState(next);
    onHistoryChange?.(next);
  };

  // Full filtered command list (no longer capped): the palette windows over
  // this so a long list scrolls with the cursor instead of truncating at 8.
  // Esc-dismissed queries hide the palette until the query changes.
  const slashQuery = buffer.startsWith("/") ? buffer.slice(1).split(/\s+/)[0]!.toLowerCase() : null;
  const suggestions =
    slashQuery !== null && slashQuery !== slashDismissed
      ? commands.filter((c) => c.name.startsWith(slashQuery))
      : [];
  const windowSize = Math.min(MAX_SUGGESTIONS, suggestions.length);

  // `selected` is plain state that can outlive a shrinking filtered list:
  // type "/", arrow down to a high index, then narrow the query and the list
  // gets shorter while `selected` stays put — now pointing past the end.
  // Clamp at every read site so Enter / Tab / render never deref undefined.
  // (This was a latent crash: `suggestions[selected]!.name` on a stale index.)
  const safeSelected = suggestions.length > 0 ? Math.min(selected, suggestions.length - 1) : 0;

  // "@path" completion (P2-10): the '@'-word at the cursor, matched against
  // the workspace by the injected `completeFiles`. Mutually exclusive with
  // the slash palette by construction ("/…" has no '@'-word at its cursor
  // position while the query is being typed). Esc-dismissed queries hide it.
  const atToken = completeFiles ? atTokenAt(buffer, cursor) : null;
  const fileSuggestions =
    atToken && atToken.query !== atDismissed ? (completeFiles?.(atToken.query) ?? []) : [];
  const safeFileSelected =
    fileSuggestions.length > 0 ? Math.min(fileSelected, fileSuggestions.length - 1) : 0;

  const reset = () => {
    setBuffer("");
    setCursor(0);
    setSelected(0);
    setSuggestOffset(0);
    setFileSelected(0);
    setSlashDismissed(null);
    setAtDismissed(null);
    setPasteNote(null);
    setHistoryIndex(-1);
    historyRestoreRef.current = null;
    draftGenRef.current++;
  };

  useInput(
    (input, key) => {
      // Any keypress retires the paste note — it has done its job once seen.
      if (pasteNote !== null) setPasteNote(null);
      // P0-3: any non-Esc key disarms the double-Esc rewind arm.
      if (!key.escape) disarmEsc();

      // --- Esc: close the open dropdown ("/" palette or "@" files) ---
      // Runs BEFORE the vim branch: leaving insert mode with a dropdown open
      // is the rarer intent than dismissing the list you're looking at.
      if (key.escape && (suggestions.length > 0 || fileSuggestions.length > 0)) {
        if (fileSuggestions.length > 0 && atToken) setAtDismissed(atToken.query);
        if (suggestions.length > 0 && slashQuery !== null) setSlashDismissed(slashQuery);
        setFileSelected(0);
        return;
      }

      // --- Vim normal mode (M18.10): drive the VimEngine state machine ---
      if (vimActive && vimMode === "normal") {
        // Ctrl-chords are global (Ctrl+O viewer toggle, Ctrl+C interrupt) —
        // never also vim operators.
        if (key.ctrl && input) return;
        if (key.return) {
          const value = buffer;
          pushHistory(value);
          reset();
          setVimMode("insert");
          onSubmit(value);
          return;
        }
        // Route the keystroke through the engine, then read its text/offset/
        // mode back into React state. The engine owns motions, operators,
        // counts, and text objects — a strict superset of the old inline
        // handlers (i/a/A/0/$/h/l/x/D and much more).
        if (!vimEngineRef.current) vimEngineRef.current = new VimEngine("");
        const engine = vimEngineRef.current;
        engine.setText(bufferRef.current, cursorRef.current);
        engine.handleKey(inkKeyToVim(input, key));
        setBuffer(engine.getText());
        setCursor(engine.getOffset());
        setVimMode(engine.getMode());
        return;
      }

      // --- Esc: drop to vim normal mode (only when vim is active) ---
      if (key.escape && vimActive) {
        setVimMode("normal");
        setCursor((c) => Math.max(0, c - 1));
        // Reset the engine to NORMAL/idle so the next normal-mode key starts a
        // fresh command (text/offset are re-synced on that key).
        vimEngineRef.current?.handleKey("Escape");
        return;
      }

      // --- P0-3: double-Esc rewind (idle, empty buffer, non-vim) ---
      // Esc#1 with a draft clears it; Esc#1 on an empty buffer arms; Esc#2
      // within 2s opens the rewind menu. While busy, Esc stays an interrupt
      // (InterruptHotkey owns it) — onRewind is undefined then by contract.
      if (key.escape && !vimActive && !busy && onRewind) {
        const arm = () => {
          disarmEsc();
          escArmedRef.current = true;
          escTimerRef.current = setTimeout(disarmEsc, 2000);
        };
        if (bufferRef.current.length > 0) {
          setBuffer("");
          setCursor(0);
          setHistoryIndex(-1);
          historyRestoreRef.current = null;
          draftGenRef.current++;
          setPasteNote(t("ui.rewind.draftCleared"));
          arm();
        } else if (escArmedRef.current) {
          disarmEsc();
          onRewind();
        } else {
          setPasteNote(t("ui.rewind.armHint"));
          arm();
        }
        return;
      }

      // --- Newline insertion (multi-line input, M25.1) ---
      // Ctrl+J inserts a newline. So does "\" immediately before Enter: if the
      // char left of the cursor is a backslash, Enter replaces it with a
      // newline instead of submitting (matches the reference editor).
      if (key.ctrl && input === "j") {
        setBuffer((b) => b.slice(0, cursorRef.current) + "\n" + b.slice(cursorRef.current));
        setCursor(cursorRef.current + 1);
        return;
      }

      // --- Submit / completion ---
      if (key.return) {
        // "\" + Enter → newline (continue editing) rather than submit.
        if (cursorRef.current > 0 && bufferRef.current[cursorRef.current - 1] === "\\") {
          setBuffer((b) => b.slice(0, cursorRef.current - 1) + "\n" + b.slice(cursorRef.current));
          // cursor stays put: removed "\" (−1) then added "\n" (+1).
          return;
        }
        let value = bufferRef.current;
        // When the command palette is open and the user is still on the
        // command *name* (no args typed yet), Enter runs the highlighted
        // command — so "/" + Enter selects e.g. /help instead of submitting a
        // bare "/" (which would be "Unknown command: /").
        if (suggestions.length > 0 && buffer.startsWith("/") && !buffer.trimEnd().includes(" ")) {
          value = "/" + suggestions[safeSelected].name;
        }
        pushHistory(value);
        reset();
        onSubmit(value);
        return;
      }
      // Tab accepts the highlighted completion — but NOT Shift+Tab: Ink sets
      // key.tab for Shift+Tab too (shift is a modifier flag), and Shift+Tab is
      // the global permission-mode cycle (keybindings/defaults). Accepting the
      // completion as well made one keypress do both.
      if (key.tab && !key.shift && suggestions.length > 0) {
        const next = "/" + suggestions[safeSelected].name + " ";
        setBuffer(next);
        setCursor(next.length);
        setSelected(0);
        return;
      }
      // Tab on the "@" dropdown: replace the '@'-word at the cursor with the
      // selected path (plus a trailing space to end the word). Only the
      // [start, cursor) span is replaced — surrounding text is untouched.
      if (key.tab && !key.shift && fileSuggestions.length > 0 && atToken) {
        const path = fileSuggestions[safeFileSelected]!;
        const replacement = `@${path} `;
        setBuffer((b) => b.slice(0, atToken.start) + replacement + b.slice(cursorRef.current));
        setCursor(atToken.start + replacement.length);
        setFileSelected(0);
        setAtDismissed(null);
        return;
      }

      // --- "@" file dropdown navigation (palette closed; P2-10) ---
      if (key.upArrow && suggestions.length === 0 && fileSuggestions.length > 0) {
        setFileSelected((s) => (s - 1 + fileSuggestions.length) % fileSuggestions.length);
        return;
      }
      if (key.downArrow && suggestions.length === 0 && fileSuggestions.length > 0) {
        setFileSelected((s) => (s + 1) % fileSuggestions.length);
        return;
      }

      // --- Dropdown navigation (only while it's open) ---
      // Wrap around at the ends, and slide the scroll window the minimum amount
      // needed to keep the highlighted row visible.
      if (key.upArrow && suggestions.length > 0) {
        const next = (safeSelected - 1 + suggestions.length) % suggestions.length;
        setSelected(next);
        setSuggestOffset((off) => nextOffset(next, off, windowSize));
        return;
      }
      if (key.downArrow && suggestions.length > 0) {
        const next = (safeSelected + 1) % suggestions.length;
        setSelected(next);
        setSuggestOffset((off) => nextOffset(next, off, windowSize));
        return;
      }

      // --- History navigation (palette closed, M41) ---
      // ↑/↓ navigate the command history when the "/" palette is closed.
      // If the user was viewing a history item and types, restore the buffer.
      if (key.upArrow && suggestions.length === 0 && history.length > 0) {
        // If user was editing (not browsing history), save current buffer.
        if (historyIndex === -1 && bufferRef.current.length > 0) {
          historyRestoreRef.current = bufferRef.current;
        }
        const next = Math.min(historyIndex + 1, history.length - 1);
        const newHistoryItem = history[history.length - 1 - next]!;
        setHistoryIndex(next);
        setBuffer(newHistoryItem);
        setCursor(newHistoryItem.length);
        return;
      }
      if (key.downArrow && suggestions.length === 0) {
        if (historyIndex === -1) {
          // Already at current buffer, do nothing.
          return;
        }
        const next = historyIndex - 1;
        if (next < 0) {
          // Back to current buffer.
          setHistoryIndex(-1);
          const restore = historyRestoreRef.current ?? "";
          setBuffer(restore);
          setCursor(restore.length);
        } else {
          const newHistoryItem = history[history.length - 1 - next]!;
          setHistoryIndex(next);
          setBuffer(newHistoryItem);
          setCursor(newHistoryItem.length);
        }
        return;
      }

      // --- Multi-line cursor movement (palette open but no suggestions, M25.1) ---
      // With the palette closed and no history to navigate, ↑/↓ move the cursor
      // to the same column on the adjacent logical line.
      if (key.upArrow) {
        const { row, col } = offsetToRowCol(bufferRef.current, cursorRef.current);
        if (row > 0) setCursor(rowColToOffset(bufferRef.current, row - 1, col));
        return;
      }
      if (key.downArrow) {
        const { row, col } = offsetToRowCol(bufferRef.current, cursorRef.current);
        if (row < splitLines(bufferRef.current).length - 1)
          setCursor(rowColToOffset(bufferRef.current, row + 1, col));
        return;
      }

      // --- Cursor movement ---
      // Ctrl+←/→ jump by word (Ink reports the CSI modifier as ctrl:true).
      if (key.leftArrow && key.ctrl) {
        setCursor(wordStartBefore(bufferRef.current, cursorRef.current));
        return;
      }
      if (key.rightArrow && key.ctrl) {
        setCursor(wordEndAfter(bufferRef.current, cursorRef.current));
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(bufferRef.current.length, c + 1));
        return;
      }
      // Ctrl+A / Ctrl+E (and Home/End where the terminal sends them) → jump to
      // the start / end of the CURRENT logical line (M25.1: line-relative, so a
      // multi-line buffer behaves like a normal editor; single-line is the
      // whole buffer as before).
      if ((key.ctrl && input === "a") || (key as { home?: boolean }).home) {
        const { row } = offsetToRowCol(bufferRef.current, cursorRef.current);
        setCursor(rowColToOffset(bufferRef.current, row, 0));
        return;
      }
      if ((key.ctrl && input === "e") || (key as { end?: boolean }).end) {
        const { row } = offsetToRowCol(bufferRef.current, cursorRef.current);
        setCursor(
          rowColToOffset(bufferRef.current, row, splitLines(bufferRef.current)[row]!.length),
        );
        return;
      }

      // --- Line editing shortcuts (M41: Emacs-style) ---
      // Ctrl+U: delete from cursor to beginning of line (keeps chars after cursor).
      if (key.ctrl && input === "u") {
        setBuffer(bufferRef.current.slice(cursorRef.current));
        setCursor(0);
        return;
      }
      // Ctrl+K: delete from cursor to end of line (keeps chars before cursor).
      if (key.ctrl && input === "k") {
        setBuffer(bufferRef.current.slice(0, cursorRef.current));
        return;
      }
      // Ctrl+W: delete word before cursor.
      if (key.ctrl && input === "w") {
        const { newBuffer, newCursor } = deleteWordBefore(bufferRef.current, cursorRef.current);
        setBuffer(newBuffer);
        setCursor(newCursor);
        return;
      }

      // --- P0-5: image paste (Ctrl/Cmd/Alt+V) ---
      // Reads the SYSTEM clipboard (terminals can't hand binaries through
      // stdin). On success the runner has already registered the image and
      // returns the "[Image #N]" chip to insert at the cursor.
      if ((key.ctrl || key.meta) && input === "v" && onImagePaste) {
        // Clipboard reads are slow (~1s via PowerShell on Windows). Snapshot
        // the cursor AND the draft generation NOW: if the draft was submitted
        // or cleared while the read was in flight, dropping the chip is the
        // honest outcome — splicing it into whatever the user is typing next
        // would silently attach the image to a later message.
        const posAtPress = cursorRef.current;
        const genAtPress = draftGenRef.current;
        void onImagePaste().then((chip) => {
          if (chip === null) {
            setPasteNote(t("ui.image.none"));
            return;
          }
          if (draftGenRef.current !== genAtPress) {
            setPasteNote(t("ui.image.stale"));
            return;
          }
          const pos = Math.min(posAtPress, bufferRef.current.length);
          const ins = bufferRef.current.length > 0 ? ` ${chip}` : chip;
          setBuffer((b) => b.slice(0, pos) + ins + b.slice(pos));
          setCursor(pos + ins.length);
          setPasteNote(t("ui.image.pasted", { chip }));
        });
        return;
      }

      // --- Deletion (buffer only — never touches the hints/transcript) ---
      if (key.backspace) {
        if (cursorRef.current > 0) {
          setBuffer((b) => b.slice(0, cursorRef.current - 1) + b.slice(cursorRef.current));
          setCursor(cursorRef.current - 1);
        }
        return;
      }
      if (key.delete) {
        // Ink reports the Del key as `key.delete`; delete the char under the
        // cursor. (Some terminals map Backspace to delete=true too, but those
        // also set backspace=true, handled above.)
        if (cursorRef.current < bufferRef.current.length) {
          setBuffer((b) => b.slice(0, cursorRef.current) + b.slice(cursorRef.current + 1));
        }
        return;
      }

      // --- Printable insertion at the cursor ---
      // Any printable input exits history browsing mode (M41) and re-arms the
      // dropdowns (an Esc-dismissed query stays dismissed only until the
      // query itself changes).
      if (input && !key.ctrl && !key.meta && !key.escape) {
        setHistoryIndex(-1);
        historyRestoreRef.current = null;
        setSlashDismissed(null);
        setAtDismissed(null);
        const insertPos = cursorRef.current;
        setBuffer((b) => b.slice(0, insertPos) + input + b.slice(insertPos));
        setCursor(insertPos + input.length);
      }
    },
    { isActive: !disabled },
  );

  // P2-11: bracketed paste via Ink's dedicated channel — pasted text arrives
  // as ONE string (never misparsed as keypresses, so a pasted \r can't submit
  // early). Newlines normalize to "\n" for the multi-line buffer; a large
  // paste surfaces a note so the user notices before Enter sends it.
  usePaste(
    (text) => {
      const sanitized = text.replace(/\r\n?/g, "\n");
      if (sanitized.length === 0) return;
      const pos = cursorRef.current;
      setBuffer((b) => b.slice(0, pos) + sanitized + b.slice(pos));
      setCursor(pos + sanitized.length);
      setHistoryIndex(-1);
      historyRestoreRef.current = null;
      const lines = sanitized.split("\n").length;
      if (lines > PASTE_NOTE_LINES) setPasteNote(t("ui.paste.note", { n: lines }));
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
    suggestions.length > 0
      ? (() => {
          // Window the full list around the selection so long command lists
          // scroll instead of overflowing the terminal.
          const start = clamp(suggestOffset, 0, Math.max(0, suggestions.length - windowSize));
          const visible = suggestions.slice(start, start + windowSize);
          const hiddenAbove = start;
          const hiddenBelow = suggestions.length - (start + windowSize);
          return (
            <Box flexDirection="column">
              {hiddenAbove > 0 ? <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text> : null}
              {visible.map((s, i) => {
                const realIdx = start + i;
                const sel = realIdx === safeSelected;
                return (
                  <Text key={s.name} color={sel ? ORANGE : palette.command}>
                    {sel ? "❯ " : "  "}/{s.name}
                    <Text dimColor> {s.description}</Text>
                  </Text>
                );
              })}
              {hiddenBelow > 0 ? <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text> : null}
            </Box>
          );
        })()
      : null;

  // M36: type-ahead hint — only while the agent is busy AND the box is active.
  // Tells the user their next line is queued (runs after the current turn),
  // rather than starting a competing turn.
  const typeAheadHint =
    busy && !disabled ? (
      <Text dimColor>{"  ⏎ queues your next message (runs after the current turn)"}</Text>
    ) : null;

  // One-shot note after a large paste (cleared by the next keypress).
  const pasteNoteLine = pasteNote ? <Text color="#e0af68">{`  ${pasteNote}`}</Text> : null;

  // The "@" file dropdown — mirrors the slash palette's styling, rows are
  // "@relative/path", highlighted row in accent orange.
  const fileList =
    fileSuggestions.length > 0 ? (
      <Box flexDirection="column">
        {fileSuggestions.map((path, i) => {
          const sel = i === safeFileSelected;
          return (
            <Text key={path} color={sel ? ORANGE : palette.command}>
              {`${sel ? "❯ " : "  "}@${path}`}
            </Text>
          );
        })}
        <Text dimColor>{`  ${t("ui.file.hint")}`}</Text>
      </Box>
    ) : null;

  // Whichever dropdown is open (they're mutually exclusive by trigger).
  const dropdown = suggestionList ?? fileList;

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
        {dropdown}
        {typeAheadHint}
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
      {typeAheadHint}
      {pasteNoteLine}
      {dropdown}
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
