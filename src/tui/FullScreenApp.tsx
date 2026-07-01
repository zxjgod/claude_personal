// ============================================================
// FullScreenApp — opt-in alt-screen layout (M25.2), fully decoupled
// ============================================================
// This is an ISOLATED module: it is rendered only when `--fullscreen` /
// CCR_FULLSCREEN=1 is set, and it imports nothing from App.tsx. It depends only
// on leaf components (ScrollView, InputBox, StatusLine, the overlay prompts/
// pickers) and the store. The normal (default) TUI path lives entirely in
// App.tsx and never imports anything from here, so changes in this file cannot
// affect normal startup. App.tsx touches full-screen in exactly one place: a
// single `if (fullscreen) return <FullScreenApp/>` delegation branch.
//
// Layout: the whole terminal height is a flex column. ScrollView grows to fill
// the space ABOVE the bottom chrome (status line + status bar + input box),
// which sizes itself. The transcript + live streaming text are flattened to
// plain text lines and windowed by the ScrollView (color is dropped in the
// scroll region so the windowing can be exact without per-node measurement —
// the default path keeps full color). The InputBox is the LAST rendered element
// with no bottom rule, so the terminal parks its real cursor on the prompt row.
//
// Scroll keys: PgUp/PgDn and less-style Ctrl+U/Ctrl+D (half page) / Ctrl+B/
// Ctrl+F (full page); Ctrl+End or G jumps to the bottom and re-sticks.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { actionLabel } from "./../spinner-core.js";
import { EffortPrompt } from "./EffortPrompt.js";
import { type CommandInfo, InputBox } from "./InputBox.js";
import { PermissionPrompt, QuestionPrompt } from "./Prompts.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { bottomScrollTop, clampScrollTop, ScrollView } from "./ScrollView.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusLine } from "./StatusLine.js";
import type { StoreState, TuiStore } from "./store.js";
import { transcriptToLines } from "./transcript-lines.js";
import { useStoreField, useStoreSelector } from "./useStoreSelector.js";
import { useTerminalSize } from "./useTerminalSize.js";

/** Present-continuous status label for the live status line. */
function statusLabel(
  activeTools: StoreState["activeTools"],
  spinner: StoreState["spinner"],
): string {
  if (activeTools.length === 1) {
    const t = activeTools[0]!;
    return actionLabel(t.name, t.detail);
  }
  if (activeTools.length > 1) return `Running ${activeTools.length} tools`;
  if (spinner === "responding") return "Responding";
  return "Thinking";
}

function selectStatusLine(s: StoreState) {
  return {
    busy: s.busy,
    spinner: s.spinner,
    turnStartedAt: s.turnStartedAt,
    spinnerTokens: s.spinnerTokens,
    toolCount: s.activeTools.length,
    label: statusLabel(s.activeTools, s.spinner),
  };
}

/** Animated status line while thinking / responding (no active tool). */
function FsStatusLine({ store }: { store: TuiStore }) {
  const { busy, spinner, turnStartedAt, spinnerTokens, toolCount, label } = useStoreSelector(
    store,
    selectStatusLine,
  );
  if (!(busy && toolCount === 0 && spinner !== "idle")) return null;
  return <StatusLine label={label} startedAt={turnStartedAt} tokens={spinnerTokens} />;
}

function selectStatusBar(s: StoreState) {
  return {
    busy: s.busy,
    modelLabel: s.modelLabel,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
  };
}

/** Bottom status bar. */
function FsStatusBar({ store }: { store: TuiStore }) {
  const { busy, modelLabel, tokensIn, tokensOut } = useStoreSelector(store, selectStatusBar);
  return (
    <Box>
      <Text dimColor>
        {busy
          ? "  working… (Ctrl+C to interrupt)"
          : "  ? for shortcuts · / for commands · @path to attach · PgUp/Ctrl+U to scroll"}
      </Text>
      <Text dimColor>
        {"   "}
        {modelLabel} · {tokensIn}↑ {tokensOut}↓ tokens
      </Text>
    </Box>
  );
}

function selectInteraction(s: StoreState) {
  return { overlay: s.overlay, busy: s.busy };
}

/** Overlay (when present) or the InputBox — pinned to the bottom, no bottom
 *  rule, so the prompt row is the last line and the cursor sits on it. */
function FsInteraction({
  store,
  commands,
  onSubmit,
  editorMode,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  editorMode?: { value: "default" | "vim" };
}) {
  const { overlay, busy } = useStoreSelector(store, selectInteraction);
  if (overlay) {
    switch (overlay.kind) {
      case "permission":
        return <PermissionPrompt overlay={overlay} />;
      case "question":
        return <QuestionPrompt overlay={overlay} />;
      case "sessionPicker":
        return <SessionPicker overlay={overlay} />;
      case "providerPicker":
        return <ProviderPicker overlay={overlay} />;
      default:
        return <EffortPrompt overlay={overlay} />;
    }
  }
  return (
    <InputBox
      commands={commands}
      disabled={false}
      busy={busy}
      onSubmit={onSubmit}
      editorMode={editorMode}
      keepColorWhenDisabled
      hideBottomRule
    />
  );
}

export function FullScreenApp({
  store,
  commands,
  onSubmit,
  editorMode,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  editorMode?: { value: "default" | "vim" };
}) {
  const { rows } = useTerminalSize();
  const transcript = useStoreField(store, "transcript");
  const streamingText = useStoreField(store, "streamingText");

  const lines = transcriptToLines(transcript, streamingText);
  const [scrollTop, setScrollTop] = useState(0);
  const [sticky, setSticky] = useState(true);
  const stickyRef = useRef(true);
  const setStickyBoth = (v: boolean) => {
    stickyRef.current = v;
    setSticky(v);
  };
  // Latest line count + the ScrollView's MEASURED viewport height, kept in refs
  // so the (closure-captured) key handler scrolls against current data.
  const linesLenRef = useRef(lines.length);
  linesLenRef.current = lines.length;
  const viewportRef = useRef(Math.max(3, rows - 5));

  const onViewportHeight = (h: number) => {
    viewportRef.current = h;
    if (stickyRef.current) {
      setScrollTop(bottomScrollTop(linesLenRef.current, h));
    } else {
      setScrollTop((t) => clampScrollTop(linesLenRef.current, h, t));
    }
  };

  // Sticky-follow as content grows.
  useEffect(() => {
    const h = viewportRef.current;
    if (stickyRef.current) {
      setScrollTop(bottomScrollTop(lines.length, h));
    } else {
      setScrollTop((t) => clampScrollTop(lines.length, h, t));
    }
  }, [lines.length]);

  // Scroll handler — always active so it works whether or not the input box is
  // focused (Ink delivers each keypress to every active useInput). We bind
  // several keys because terminals disagree on PgUp/PgDn; less-style Ctrl+U/D
  // (half) and Ctrl+B/F (full) are the reliable fallback.
  const scrollBy = (sign: -1 | 1, frac: number, opts?: { toBottom?: boolean }) => {
    const total = linesLenRef.current;
    const h = viewportRef.current;
    if (opts?.toBottom) {
      setStickyBoth(true);
      setScrollTop(bottomScrollTop(total, h));
      return;
    }
    const step = Math.max(1, Math.floor(h * frac)) * sign;
    setScrollTop((t) => {
      const next = clampScrollTop(total, h, t + step);
      setStickyBoth(next >= bottomScrollTop(total, h));
      return next;
    });
  };

  useInput((input, key) => {
    if (key.pageUp || (key.ctrl && input === "u")) return void scrollBy(-1, 0.5);
    if (key.ctrl && input === "b") return void scrollBy(-1, 0.95);
    if (key.pageDown || (key.ctrl && input === "d")) return void scrollBy(1, 0.5);
    if (key.ctrl && input === "f") return void scrollBy(1, 0.95);
    if ((key.ctrl && (key.downArrow || (key as { end?: boolean }).end)) || input === "G") {
      return void scrollBy(1, 0, { toBottom: true });
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <ScrollView
        lines={lines}
        scrollTop={scrollTop}
        fallbackHeight={Math.max(3, rows - 5)}
        onHeight={onViewportHeight}
      />
      {!sticky ? (
        <Text dimColor>{"  ↑ scrolled — PgDn / Ctrl+End to return to latest"}</Text>
      ) : (
        <FsStatusLine store={store} />
      )}
      <FsStatusBar store={store} />
      {/* InputBox MUST be the last element: the terminal parks the real cursor
          at the end of the final rendered row, so the prompt has to be that row
          (InputBox renders with no bottom rule in this path). */}
      <FsInteraction
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        editorMode={editorMode}
      />
    </Box>
  );
}
