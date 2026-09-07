// ============================================================
// TranscriptReview — in-app verbose transcript viewer (PgUp / Ctrl+O)
// ============================================================
// The default TUI renders committed content into Ink <Static>, which is
// write-once: scrolling belongs to the TERMINAL's scrollback, and on consoles
// with scroll-on-output snap (classic Windows console) every streamed frame
// yanks the viewport back to the bottom — the user effectively cannot scroll
// while the model streams. This viewer moves scrolling into the app, immune
// to terminal snap.
//
// P0-1: the viewer is now VERBOSE (Ctrl+O semantics — full tool output and
// full thinking text, no preview cuts) and adds:
//   • "/" search — type a query, Enter/n/N step through matches
//   • "{" / "}"  — jump to the previous / next user prompt
//   • "v"        — open the flattened transcript in $VISUAL/$EDITOR
//   • q / Esc / Ctrl+O — close
// Opens pinned to the BOTTOM (latest content) with sticky OFF: new lines
// that arrive while reviewing extend the content but never drag the viewport.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n.js";
import { openInEditor } from "./open-editor.js";
import { bottomScrollTop, clampScrollTop, ScrollView } from "./ScrollView.js";
import type { TuiStore } from "./store.js";
import { stripAnsi, visualWidth } from "./terminal-width.js";
import { type TranscriptLine, transcriptToLines } from "./transcript-lines.js";
import { useStoreSelector } from "./useStoreSelector.js";
import { useTerminalSize } from "./useTerminalSize.js";

/** Rows reserved for the viewer's own chrome (title + search + a ONE-ROW
 *  footer hint) and the app status bar. The footer's real row count is added
 *  on top — it wraps under narrow terminals, so a wide terminal must not pay
 *  for the narrow case. */
const CHROME_ROWS = 5;

const SEARCH_HIGHLIGHT = "yellow";

function selectContent(s: ReturnType<TuiStore["getSnapshot"]>) {
  return {
    transcript: s.transcript,
    streamingText: s.streamingText,
    streamingThinking: s.streamingThinking,
    busy: s.busy,
  };
}

export function TranscriptReview({ store }: { store: TuiStore }) {
  const { transcript, streamingText, streamingThinking, busy } = useStoreSelector(
    store,
    selectContent,
  );
  const { rows, columns } = useTerminalSize();

  // Verbose: this viewer IS the Ctrl+O transcript mode. ctrl+e (D6) toggles
  // the official showAll — the collapsed side folds thinking to one-liners
  // while tool output stays full.
  const [showAll, setShowAll] = useState(true);
  const lines = transcriptToLines(transcript, streamingText, streamingThinking, {
    verbose: true,
    collapseThinking: !showAll,
  });

  // The footer wraps when its display width exceeds the terminal columns
  // (CJK counts double) — budget its REAL row count so a wide terminal
  // doesn't lose a viewport row to a static worst-case reserve.
  const footerText = `  ${t("ui.viewer.footer", { action: t(showAll ? "ui.viewer.collapse" : "ui.viewer.expand") })}`;
  const footerRows = Math.max(1, Math.ceil(visualWidth(footerText) / Math.max(1, columns)));
  const viewportHeight = Math.max(3, rows - (CHROME_ROWS - 1 + footerRows));

  // Open at the bottom (most recent content). Sticky stays OFF: streaming
  // appends must not yank the reader — new content only re-clamps the offset.
  const [scrollTop, setScrollTop] = useState(() => bottomScrollTop(lines.length, viewportHeight));
  const scrollTopRef = useRef(scrollTop);
  scrollTopRef.current = scrollTop;

  // "/" search state. `searching` = the query line is being edited; `query`
  // persists after Enter so n/N keep stepping through matches.
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  // `v` hands the terminal to $EDITOR — swallow keys until it exits.
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    setScrollTop((t) => clampScrollTop(lines.length, viewportHeight, t));
  }, [lines.length, viewportHeight]);

  const scrollTo = (desired: number) => {
    const next = clampScrollTop(lines.length, viewportHeight, desired);
    // Update the ref SYNCHRONOUSLY: two keys arriving in one stdin chunk run
    // the same handler closure without a re-render between them, so the second
    // must see the first's offset (not the stale render-time value).
    scrollTopRef.current = next;
    setScrollTop(next);
  };

  /** Indices of lines matching the current query (case-insensitive).
   *  Memoized: the render pass (highlight + count) and the jump keys all
   *  share ONE scan per (lines, query) instead of three.
   *  Matching runs on stripAnsi(text) — the VISIBLE text: rows carry raw
   *  chalk SGR escapes, and matching those (a) hits the SGR parameter digits
   *  on every colored row ("36" matched any cyan row), (b) can never match
   *  a word spanning a color boundary. */
  const matches = useMemo((): number[] => {
    const q = query.toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (stripAnsi(lines[i]!.text).toLowerCase().includes(q)) out.push(i);
    }
    return out;
  }, [lines, query]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  /** Jump to the match nearest after `from` (wraps). Returns true on jump. */
  const jumpToMatch = (from: number, dir: 1 | -1): boolean => {
    const found = matchesRef.current;
    if (found.length === 0) return false;
    let target: number | undefined;
    if (dir === 1) {
      target = found.find((m) => m > from);
      if (target === undefined) target = found[0]; // wrap
    } else {
      target = [...found].reverse().find((m) => m < from);
      if (target === undefined) target = found[found.length - 1]; // wrap
    }
    if (target === undefined) return false;
    scrollTo(target);
    return true;
  };

  /** Jump to the previous ("{") / next ("}") user-prompt line. */
  const jumpToPrompt = (dir: -1 | 1): void => {
    const userIdx: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.role === "user") userIdx.push(i);
    }
    if (userIdx.length === 0) return;
    const from = scrollTopRef.current;
    const target =
      dir === 1 ? userIdx.find((i) => i > from) : [...userIdx].reverse().find((i) => i < from);
    if (target !== undefined) scrollTo(target);
  };

  useInput((input, key) => {
    if (editorOpen) return;

    // --- search-editing mode: keystrokes edit the query ---
    if (searching) {
      if (key.escape) {
        setSearching(false);
        return;
      }
      if (key.return) {
        setSearching(false);
        jumpToMatch(scrollTopRef.current - 1, 1);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        return;
      }
      return;
    }

    // --- close ---
    if (key.escape || input === "q" || (key.ctrl && input === "o")) {
      store.setReviewing(false);
      return;
    }

    // --- ctrl+e: official transcript:toggleShowAll (expand/collapse) ---
    if (key.ctrl && input === "e") {
      setShowAll((v) => !v);
      return;
    }

    // --- search / jumps / editor ---
    if (input === "/") {
      setSearching(true);
      return;
    }
    if (input === "n") {
      jumpToMatch(scrollTopRef.current, 1);
      return;
    }
    if (input === "N") {
      jumpToMatch(scrollTopRef.current, -1);
      return;
    }
    if (input === "{") {
      jumpToPrompt(-1);
      return;
    }
    if (input === "}") {
      jumpToPrompt(1);
      return;
    }
    if (input === "v") {
      setEditorOpen(true);
      // Export the VISIBLE text — rows carry raw chalk SGR escapes, and
      // writing those to the file would fill $EDITOR with \x1b[...m garbage.
      // openInEditor never rejects, but the .catch keeps that contract from
      // being load-bearing — a future refactor that lets it throw must not
      // turn a bad $EDITOR into a process-crashing unhandled rejection.
      void openInEditor(lines.map((l) => stripAnsi(l.text)))
        .then((r) => {
          if (!r.ok) store.showToast(t("ui.viewer.editorFailed", { path: r.filePath }));
        })
        .catch(() => store.showToast(t("ui.viewer.editorFailed", { path: "(unknown)" })))
        .finally(() => setEditorOpen(false));
      return;
    }

    // --- scrolling ---
    const lineStep = 1;
    const halfPage = Math.max(1, Math.floor(viewportHeight * 0.5));
    const fullPage = Math.max(1, Math.floor(viewportHeight * 0.95));
    if (key.upArrow) return scrollTo(scrollTopRef.current - lineStep);
    if (key.downArrow) return scrollTo(scrollTopRef.current + lineStep);
    if (key.pageUp || (key.ctrl && input === "u")) return scrollTo(scrollTopRef.current - halfPage);
    if (key.pageDown || (key.ctrl && input === "d"))
      return scrollTo(scrollTopRef.current + halfPage);
    if (key.ctrl && input === "b") return scrollTo(scrollTopRef.current - fullPage);
    if (key.ctrl && input === "f") return scrollTo(scrollTopRef.current + fullPage);
    if (key.home) return scrollTo(0);
    if (key.end || input === "G") return scrollTo(bottomScrollTop(lines.length, viewportHeight));
  });

  // Highlight matched rows while a query is active (search line or after).
  // Derived from the memoized match set — no third full scan.
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const displayLines: TranscriptLine[] =
    matchSet.size > 0
      ? lines.map((l, i) => (matchSet.has(i) ? { ...l, color: SEARCH_HIGHLIGHT } : l))
      : lines;

  const matchCount = matches.length;
  // The badge predicts where Enter will land: jumpToMatch(scrollTop - 1, 1)
  // picks the first match at or below the scroll offset, wrapping to the
  // first match overall when every match is above it. (The badge only shows
  // while the query is being typed, so "next jump target" is the only
  // reading — a plain last-match-above count would be off by one whenever
  // the offset sits between two matches.)
  const currentMatch =
    matchCount > 0 ? (matches.filter((m) => m < scrollTop).length % matchCount) + 1 : 0;

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {busy
          ? t("ui.viewer.titleStreaming", { n: lines.length })
          : t("ui.viewer.title", { n: lines.length })}
      </Text>
      {/* Fixed-height wrapper: the default App root has no height constraint,
          so without it ScrollView's measured height would follow the CONTENT
          (breaking the windowing math) instead of the viewport. */}
      <Box height={viewportHeight} flexShrink={0}>
        <ScrollView lines={displayLines} scrollTop={scrollTop} fallbackHeight={viewportHeight} />
      </Box>
      {searching ? (
        <Text color={SEARCH_HIGHLIGHT}>
          {`${t("ui.viewer.searchPrompt", { q: query })} ${
            query && matchCount > 0
              ? `· (${currentMatch}/${matchCount})`
              : query
                ? `· ${t("ui.viewer.matches", { n: 0 })}`
                : ""
          }`}
        </Text>
      ) : (
        <Text dimColor>{footerText}</Text>
      )}
    </Box>
  );
}
