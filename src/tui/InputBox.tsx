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
import { POINTER } from "./figures.js";
import { t } from "./i18n.js";
import { editInEditor } from "./open-editor.js";
import { PASTE_FOLD_CHARS } from "./paste-chip.js";
import { nextOffset } from "./SessionPicker.js";
import { terminalColumns } from "./terminal-width.js";
import { palette } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { VimEngine } from "./vim/index.js";

export interface CommandInfo {
  name: string;
  description: string;
}

/** Maximum number of history entries to keep. */
const MAX_HISTORY_SIZE = 100;

const ORANGE = palette.accent;
/** Official prompt-frame gray — the rounded top border + disabled chrome. */
const PROMPT_BORDER = palette.promptBorder;
/** How many command rows the inline "/" dropdown shows at once before it
 *  scrolls. The full filtered list is kept and windowed around the selection
 *  (see the render below) so every command is reachable, not just the first 8. */
const MAX_SUGGESTIONS = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Width of the input box (border + content). We leave ONE column of slack
// (`cols - 1`) rather than going flush to the terminal edge: a border exactly
// as wide as the terminal trips DECAWM (auto-wrap), so the terminal emits a
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

/** The official input-area height cap: max(3, floor(rows/2) - footer rows).
 *  A pasted wall of text scrolls INSIDE the box instead of pushing the live
 *  frame off-screen. */
function maxVisiblePromptRows(termRows: number): number {
  return Math.max(3, Math.floor(termRows / 2) - 2);
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
  /** P0-3: double-Esc rewind trigger. Called on the second Esc within 800ms
   *  while idle with an empty buffer (first Esc clears a non-empty draft).
   *  Omit to disable (busy turns pass undefined). */
  onRewind?: () => void;
  /** P0-5: read a clipboard image (Ctrl/Cmd/Alt+V). Resolves with the
   *  "[Image #N]" chip text (already registered by the runner) or null. */
  onImagePaste?: () => Promise<string | null>;
  /** B6: recall the LAST queued message back into the buffer (Up from an
   *  empty first row). Returns the recalled text or null when the queue is
   *  empty; the caller removes it from the queue. */
  onQueuePop?: () => string | null;
  /** D5: fold a paste above PASTE_FOLD_CHARS into a "[Pasted text #N +L
   *  lines]" chip instead of dumping it into the buffer. The runner stores
   *  the content and expands the chip on submit. Absent = no folding. */
  onLargePaste?: (content: string) => string;
  /** B4/B5: one-shot command dispatched by global hotkeys through the store
   *  (stash / editor / clear / historySearch). The InputBox owns the buffer,
   *  so the hotkey layer signals rather than reaching in. */
  pendingAction?: { kind: "stash" | "editor" | "clear" | "historySearch"; seq: number } | null;
  /** Suspend ALL keyboard/paste editing while another surface (the help
   *  panel) owns the keyboard. Deliberately a SIGNAL read at EVENT time, not
   *  an isActive flag: the keypress that OPENS the panel is dispatched to
   *  every useInput listener in the same stdin burst, and a re-subscribe
   *  would only take effect after React re-renders — the opening "?" would
   *  still leak into the buffer. */
  inputSuspended?: () => boolean;
  /** Live draft mirror (text + cursor), written synchronously on every edit.
   *  Two consumers: the global "?" help hotkey's empty-draft guard (read at
   *  event time — see store.draft) and draft preservation across unmounts,
   *  because overlays and the review pager REPLACE this component and its
   *  state would die with it. */
  onDraftChange?: (draft: { text: string; cursor: number }) => void;
  /** Draft to seed the buffer with on mount: the mirror saved by the
   *  previous InputBox instance (see onDraftChange). Absent = start empty. */
  initialDraft?: { text: string; cursor: number };
}

/** Official double-press window (useDoublePress.ts): two Escs / two Ctrl+Cs
 *  within this span count as a double press. */
const DOUBLE_PRESS_ESC_MS = 800;

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
  onQueuePop,
  onLargePaste,
  pendingAction,
  inputSuspended,
  onDraftChange,
  initialDraft,
}: InputBoxProps) {
  const vimActive = editorMode?.value === "vim";
  // Seed from the saved draft (restores across overlay / review unmounts);
  // clamp the cursor defensively — the seed may predate a different buffer.
  const [buffer, setBufferState] = useState(initialDraft?.text ?? "");
  const [cursor, setCursorState] = useState(() =>
    clamp(initialDraft?.cursor ?? 0, 0, (initialDraft?.text ?? "").length),
  );
  // B1/B2: `!` bash mode tints the whole frame pink; `#` memory mode uses the
  // official remember blue for the marker only.
  const bashMode = buffer.startsWith("!");
  const memoryMode = buffer.startsWith("#");
  // Official chrome: the border stays the prompt gray (dimmed when the box is
  // disabled); the accent is no longer used for the frame. `keepColorWhenDisabled`
  // (full-screen path) keeps the border at full strength.
  const frameColor =
    bashMode && !disabled
      ? palette.bashBorder
      : disabled && !keepColorWhenDisabled
        ? "#666666"
        : PROMPT_BORDER;
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
  // B3 (ctrl+r): inline reverse-i-search state. While active it intercepts
  // ALL editing keys; `preSearch` restores the draft on cancel.
  const [historySearch, setHistorySearch] = useState<{
    query: string;
    idx: number;
    preSearch: string;
  } | null>(null);
  // B4 (ctrl+g): the external editor owns the TTY — replace the box with the
  // official waiting line until it exits.
  const [editorActive, setEditorActive] = useState(false);
  // B4 (ctrl+s): the stashed draft (text + cursor). Undefined = nothing
  // stashed; ctrl+s with an empty buffer restores it.
  const stashRef = useRef<{ text: string; cursor: number } | null>(null);
  // P0-3: double-Esc rewind arming. First Esc (idle, empty buffer, non-vim)
  // arms; a second Esc within the official 800ms window fires onRewind. Any
  // other key disarms.
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
  const bufferRef = useRef(initialDraft?.text ?? "");
  bufferRef.current = buffer;
  const cursorRef = useRef(clamp(initialDraft?.cursor ?? 0, 0, (initialDraft?.text ?? "").length));
  cursorRef.current = cursor;
  // Vim engine (only used when vimActive): persists across normal-mode keys so
  // multi-key operators (d/w, dd, 3w, …) keep their state machine between
  // keystrokes. Lazily created; text/offset re-synced from buffer on each key.
  const vimEngineRef = useRef<VimEngine | null>(null);

  // Latest draft-mirror callback (kept in a ref so it is read at event time
  // and so the mount effect below always calls the freshest instance).
  const draftCbRef = useRef(onDraftChange);
  draftCbRef.current = onDraftChange;

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
    draftCbRef.current?.({ text: bufferRef.current, cursor: next });
    setCursorState(next);
  };

  const setBuffer = (updater: string | ((prev: string) => string)) => {
    const next = typeof updater === "function" ? updater(bufferRef.current) : updater;
    bufferRef.current = next;
    // Draft mirror travels with the ref write (same synchronous rationale as
    // above): two keypresses in one stdin chunk must not report a stale draft.
    draftCbRef.current?.({ text: next, cursor: cursorRef.current });
    setBufferState(next);
  };

  // Mirror the seeded draft on mount so the store matches even when the box
  // mounted WITHOUT a seed. Deliberately NO unmount reset: the mirror is the
  // draft's survival mechanism across unmounts (overlays, the review pager)
  // — the next InputBox instance seeds itself from it.
  useEffect(() => {
    draftCbRef.current?.({ text: bufferRef.current, cursor: cursorRef.current });
    // Mount only: re-running per callback identity is pointless — the
    // callback is read through the ref above, not captured here.
  }, []);

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
    setHistorySearch(null);
    draftGenRef.current++;
  };

  // B3: history entries matching the search query, newest first. Empty query
  // matches everything (plain history walk).
  const searchMatches = (() => {
    if (!historySearch) return [] as string[];
    const q = historySearch.query.toLowerCase();
    return [...history].reverse().filter((h) => h.toLowerCase().includes(q));
  })();

  // B4/B5: execute one-shot actions dispatched by the global hotkeys. The
  // handler closes over per-render state helpers (reset/setBuffer/...), so it
  // lives in a latest-ref: the effect then depends on `pendingAction` ALONE —
  // every dispatch creates a fresh {kind, seq} object, which both re-fires
  // repeated same-kind dispatches and satisfies the dependency lint without
  // re-running the action on unrelated renders.
  const actionHandlerRef = useRef<(kind: "stash" | "editor" | "clear" | "historySearch") => void>(
    () => {},
  );
  actionHandlerRef.current = (kind) => {
    switch (kind) {
      case "clear":
        reset();
        return;
      case "stash": {
        // Official ctrl+s: with a draft, stash it (text + cursor) and clear;
        // with an EMPTY draft, restore the stash. Nothing stashed yet = noop.
        if (bufferRef.current.length > 0) {
          stashRef.current = { text: bufferRef.current, cursor: cursorRef.current };
          reset();
          setPasteNote(t("ui.input.stashed"));
        } else if (stashRef.current) {
          const stash = stashRef.current;
          stashRef.current = null;
          setBuffer(stash.text);
          setCursor(stash.cursor);
          setPasteNote(t("ui.input.restored"));
        }
        return;
      }
      case "editor": {
        // Official ctrl+g: hand the draft to $VISUAL/$EDITOR; the edited file
        // replaces the buffer on a clean exit. The child owns the TTY for the
        // duration — `editorActive` swaps the box for the waiting line.
        if (editorActive) return;
        setEditorActive(true);
        void editInEditor(bufferRef.current).then(({ ok, text }) => {
          setEditorActive(false);
          if (ok) {
            setBuffer(text);
            setCursor(text.length);
          } else {
            setPasteNote(t("ui.input.editorFailed"));
          }
        });
        return;
      }
      case "historySearch": {
        if (historyRef.current.length === 0) {
          setPasteNote(t("ui.input.noHistory"));
          return;
        }
        setHistorySearch({ query: "", idx: 0, preSearch: bufferRef.current });
        return;
      }
    }
  };
  useEffect(() => {
    if (pendingAction) actionHandlerRef.current(pendingAction.kind);
  }, [pendingAction]);

  useInput(
    (input, key) => {
      // Another surface (help panel) owns the keyboard: swallow the keypress
      // entirely. Checked FIRST and at event time — see the prop's note.
      if (inputSuspended?.()) return;
      // The external editor owns the TTY (B4): nothing arrives until it exits.
      if (editorActive) return;
      // Any keypress retires the paste note — it has done its job once seen.
      if (pasteNote !== null) setPasteNote(null);
      // P0-3: any non-Esc key disarms the double-Esc rewind arm.
      if (!key.escape) disarmEsc();

      // --- B3: inline reverse-i-search owns ALL keys while active ---
      if (historySearch) {
        const matches = searchMatches;
        if (key.escape) {
          // Esc accepts the match into the buffer without submitting.
          const match = matches[historySearch.idx];
          setHistorySearch(null);
          if (match !== undefined) {
            setBuffer(match);
            setCursor(match.length);
          }
          return;
        }
        if (key.tab && !key.shift && matches.length > 0) {
          // Tab accepts like Esc (official: accept without running).
          const match = matches[historySearch.idx]!;
          setHistorySearch(null);
          setBuffer(match);
          setCursor(match.length);
          return;
        }
        if ((key.ctrl && input === "r") || key.upArrow) {
          // ctrl+r / ↑ cycle to the next older match (wrap).
          if (matches.length > 0) {
            setHistorySearch({ ...historySearch, idx: (historySearch.idx + 1) % matches.length });
          }
          return;
        }
        if (key.downArrow) {
          if (matches.length > 0) {
            setHistorySearch({
              ...historySearch,
              idx: (historySearch.idx - 1 + matches.length) % matches.length,
            });
          }
          return;
        }
        if (key.return) {
          // Enter accepts AND runs the match (official behavior).
          const match = matches[historySearch.idx];
          setHistorySearch(null);
          if (match === undefined) {
            setBuffer(historySearch.preSearch);
            setCursor(historySearch.preSearch.length);
            return;
          }
          pushHistory(match);
          reset();
          onSubmit(match);
          return;
        }
        if (key.backspace) {
          const q = historySearch.query.slice(0, -1);
          setHistorySearch({ ...historySearch, query: q, idx: 0 });
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          const q = historySearch.query + input;
          setHistorySearch({ ...historySearch, query: q, idx: 0 });
          return;
        }
        return;
      }

      // --- Esc: close the open dropdown ("/" palette or "@" files) ---
      // Runs BEFORE the vim branch: leaving insert mode with a dropdown open
      // is the rarer intent than dismissing the list you're looking at.
      if (key.escape && (suggestions.length > 0 || fileSuggestions.length > 0)) {
        if (fileSuggestions.length > 0 && atToken) setAtDismissed(atToken.query);
        if (suggestions.length > 0 && slashQuery !== null) setSlashDismissed(slashQuery);
        setFileSelected(0);
        return;
      }

      // --- B1: Esc exits `!` bash mode when the buffer is just the marker ---
      if (key.escape && !busy && bufferRef.current === "!") {
        reset();
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
      // within the OFFICIAL 800ms window opens the rewind menu. While busy,
      // Esc stays an interrupt (InterruptHotkey owns it) — onRewind is
      // undefined then by contract.
      if (key.escape && !vimActive && !busy && onRewind) {
        const arm = () => {
          disarmEsc();
          escArmedRef.current = true;
          escTimerRef.current = setTimeout(disarmEsc, DOUBLE_PRESS_ESC_MS);
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
      // Legacy terminals send the SAME \r for Enter and Shift+Enter, so a
      // distinct Shift+Enter binding is impossible there; multi-line entry is
      // Ctrl+J (plus "\" + Enter below). Ctrl+J arrives as a bare 0x0A, which
      // Ink parses as input "\n" with key.return UNSET — match the byte
      // explicitly so the behavior no longer depends on falling through to
      // the printable-insertion branch.
      if ((key.ctrl && input === "j") || (input === "\n" && !key.return)) {
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

      // --- B6: queue recall (Up from an empty first row) ---
      // Official: "Up from first line takes back queued messages". Only when
      // the buffer is empty (nothing to protect) and the cursor sits on the
      // first row — otherwise ↑ keeps its multi-line/history duties.
      if (
        key.upArrow &&
        suggestions.length === 0 &&
        fileSuggestions.length === 0 &&
        bufferRef.current.length === 0 &&
        onQueuePop
      ) {
        const recalled = onQueuePop();
        if (recalled !== null && recalled !== undefined) {
          setBuffer(recalled);
          setCursor(recalled.length);
          setPasteNote(t("ui.queue.recalled"));
          return;
        }
        // Queue empty: fall through to history navigation below.
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
      // Ctrl+U: delete from cursor to the beginning of the CURRENT logical
      // line — line-relative like Ctrl+A/E above, so a multi-line draft keeps
      // the rows above the cursor (buffer-level slicing used to eat them all).
      if (key.ctrl && input === "u") {
        const { row } = offsetToRowCol(bufferRef.current, cursorRef.current);
        const lineStart = rowColToOffset(bufferRef.current, row, 0);
        setBuffer(
          bufferRef.current.slice(0, lineStart) + bufferRef.current.slice(cursorRef.current),
        );
        setCursor(lineStart);
        return;
      }
      // Ctrl+K: delete from cursor to the end of the current logical line
      // (the newline stays; at end-of-line it is a no-op rather than joining).
      if (key.ctrl && input === "k") {
        const { row } = offsetToRowCol(bufferRef.current, cursorRef.current);
        const lineEnd = rowColToOffset(
          bufferRef.current,
          row,
          splitLines(bufferRef.current)[row]!.length,
        );
        if (lineEnd > cursorRef.current) {
          setBuffer(
            bufferRef.current.slice(0, cursorRef.current) + bufferRef.current.slice(lineEnd),
          );
        }
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
      // Suspend signal gates paste for the same reason as keypresses.
      if (inputSuspended?.()) return;
      const sanitized = text.replace(/\r\n?/g, "\n");
      if (sanitized.length === 0) return;
      const pos = cursorRef.current;
      // D5: an oversized paste folds into a chip — the buffer stays readable
      // and the transcript echo stays one line; the full content still reaches
      // the model (expanded on submit by the runner).
      if (onLargePaste && sanitized.length > PASTE_FOLD_CHARS) {
        const chip = onLargePaste(sanitized);
        // Start the chip on its own line ONLY when the text before the cursor
        // doesn't already end at a line break — an unconditional prefix would
        // leave a blank line after a trailing "\n" (and mid-word, the chip
        // must never glue onto the character before the cursor either).
        const before = bufferRef.current;
        const needsBreak = pos > 0 && before[pos - 1] !== "\n";
        const ins = needsBreak ? `\n${chip}` : chip;
        setBuffer((b) => b.slice(0, pos) + ins + b.slice(pos));
        setCursor(pos + ins.length);
        setHistoryIndex(-1);
        historyRestoreRef.current = null;
        setPasteNote(t("ui.paste.folded", { n: sanitized.split("\n").length }));
        return;
      }
      setBuffer((b) => b.slice(0, pos) + sanitized + b.slice(pos));
      setCursor(pos + sanitized.length);
      setHistoryIndex(-1);
      historyRestoreRef.current = null;
      const lines = sanitized.split("\n").length;
      if (lines > PASTE_NOTE_LINES) setPasteNote(t("ui.paste.note", { n: lines }));
    },
    { isActive: !disabled },
  );

  // Read terminal size at render time so the box tracks resize. (See
  // ruleWidth's note on why we leave one column of slack.)
  const { rows: termRows } = useTerminalSize();
  const boxWidth = ruleWidth();

  // M25.1: render each logical line on its own row so a multi-line buffer
  // displays as multiple rows. The "❯" prompt sits on the first line; wrapped
  // continuation rows get a matching two-space indent so text aligns under it.
  const lines = splitLines(buffer);
  const { row: curRow, col: curCol } = offsetToRowCol(buffer, cursor);

  // Official input-area cap: past maxVisiblePromptRows the buffer scrolls
  // INSIDE the box, windowed around the cursor row (anchored to the tail when
  // the cursor is at the end — the common case while writing).
  const maxVisible = maxVisiblePromptRows(termRows);
  const clippedRows = Math.max(0, lines.length - maxVisible);
  let windowStart = 0;
  if (clippedRows > 0) {
    windowStart = clamp(curRow >= maxVisible ? curRow - maxVisible + 1 : 0, 0, clippedRows);
  }
  const visibleLines = clippedRows > 0 ? lines.slice(windowStart, windowStart + maxVisible) : lines;
  // Hidden-row indicators must reflect WHERE the window sits, not the total:
  // rows hidden ABOVE the window (↑) and BELOW it (↓) are independent — with
  // the cursor scrolled back up, the hidden mass is below and the arrow must
  // say so.
  const hiddenAbove = clippedRows > 0 ? windowStart : 0;
  const hiddenBelow = clippedRows > 0 ? clippedRows - windowStart : 0;

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
              {hiddenAbove > 0 ? (
                <Text dimColor>{`  ${t("ui.suggest.moreAbove", { n: hiddenAbove })}`}</Text>
              ) : null}
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
              {hiddenBelow > 0 ? (
                <Text dimColor>{`  ${t("ui.suggest.moreBelow", { n: hiddenBelow })}`}</Text>
              ) : null}
            </Box>
          );
        })()
      : null;

  // M36: type-ahead hint — only while the agent is busy AND the box is active.
  // Tells the user their next line is queued (runs after the current turn),
  // rather than starting a competing turn.
  const typeAheadHint =
    busy && !disabled ? <Text dimColor>{`  ${t("ui.input.queuedHint")}`}</Text> : null;

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

  // Official input chrome: ONE rounded top border (╭…╮) above the prompt —
  // no side/bottom borders, no bottom rule. The prompt pointer is "❯"
  // (figures.POINTER); continuation rows indent two spaces under it. When the
  // buffer outgrows maxVisible the window keeps the cursor row on screen.
  // B1/B2: in bash/memory mode the buffer's leading "!" / "#" is rendered AS
  // the prompt marker (official PromptInputModeIndicator: "! " pink, "#" blue)
  // — row 0's payload drops the raw mode char so it isn't shown twice, and
  // the cursor column shifts accordingly.
  const marker = bashMode ? "! " : memoryMode ? "# " : `${POINTER} `;
  const markerColor = bashMode ? palette.bashBorder : memoryMode ? "#7aa2f7" : frameColor;
  const promptRows = visibleLines.map((line, i) => {
    const realRow = windowStart + i;
    const rowText = realRow === 0 && (bashMode || memoryMode) ? line.slice(1) : line;
    return (
      <Box key={realRow}>
        {realRow === 0 && vimActive ? (
          <Text color={vimMode === "normal" ? "yellow" : "green"}>
            {vimMode === "normal" ? "[N] " : "[I] "}
          </Text>
        ) : null}
        <Text color={markerColor}>{realRow === 0 ? marker : "  "}</Text>
        <CursorLine
          line={rowText}
          // The cursor is only drawn on the row it sits on; other rows render
          // their text plainly.
          cursorCol={
            !disabled && realRow === curRow
              ? realRow === 0 && (bashMode || memoryMode)
                ? Math.max(0, curCol - 1)
                : curCol
              : -1
          }
        />
      </Box>
    );
  });

  const clippedHint =
    clippedRows > 0 ? (
      <>
        {hiddenAbove > 0 ? (
          <Text dimColor>{`  ${t("ui.suggest.moreAbove", { n: hiddenAbove })}`}</Text>
        ) : null}
        {hiddenBelow > 0 ? (
          <Text dimColor>{`  ${t("ui.suggest.moreBelow", { n: hiddenBelow })}`}</Text>
        ) : null}
      </>
    ) : null;

  // Classic full-round box (╭…╮ prompt ╰…╯). Drawn as manual rule lines, not a
  // bordered Box: Ink only renders corner glyphs when the adjacent side
  // borders exist, so borderStyle="round" with borderLeft/Right=false comes
  // out as bare ─── rules. Hand-drawing the ╭╮/╰╯ rows reproduces the official
  // input chrome exactly (sides stay invisible). The full-screen path drops
  // the bottom rule (hideBottomRule) so the prompt row stays the very last
  // rendered line and the terminal parks its real cursor on it.
  const ruleRepeat = Math.max(3, boxWidth - 2);
  const topRule = <Text color={frameColor}>{`╭${"─".repeat(ruleRepeat)}╮`}</Text>;
  const bottomRule = <Text color={frameColor}>{`╰${"─".repeat(ruleRepeat)}╯`}</Text>;

  // B4 (ctrl+g): the external editor owns the TTY — the official client
  // replaces the whole input box with a dim italic waiting line.
  if (editorActive) {
    return (
      <Box flexDirection="column">
        {topRule}
        <Text dimColor italic>
          {" "}
          {t("ui.input.editorWaiting")}
        </Text>
        {!hideBottomRule ? bottomRule : null}
      </Box>
    );
  }

  const promptBox = (
    <Box flexDirection="column">
      {topRule}
      {clippedHint}
      {promptRows}
      {!hideBottomRule ? bottomRule : null}
    </Box>
  );

  // B3: the reverse-i-search line — label + query + the current match, shown
  // under the box while the search owns the keyboard.
  const searchLine = historySearch ? (
    <Text dimColor>
      {`  (${t("ui.input.searchLabel")}) [${historySearch.query}] ${
        searchMatches[historySearch.idx] ?? t("ui.input.searchEmpty")
      }`}
    </Text>
  ) : null;

  // Full-screen: suggestions go ABOVE the box.
  if (hideBottomRule) {
    return (
      <Box flexDirection="column">
        {dropdown}
        {typeAheadHint}
        {promptBox}
        {searchLine}
      </Box>
    );
  }

  // Default path: bordered box with the suggestion dropdown below (official
  // renders suggestions under the input, over the footer slot).
  return (
    <Box flexDirection="column">
      {promptBox}
      {typeAheadHint}
      {pasteNoteLine}
      {searchLine}
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
