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
// per-role COLORED lines (P3-16: user blue, tool head accent, bodies dim —
// one color per row keeps the windowing exact without per-node measurement)
// and windowed by the ScrollView. The InputBox is the LAST rendered element
// with no bottom rule, so the terminal parks its real cursor on the prompt row.
//
// Scroll keys: PgUp/PgDn (half page) and less-style Ctrl+B/Ctrl+F (full
// page); Ctrl+End or G jumps to the bottom and re-sticks. ↑/↓ and Ctrl+U
// deliberately do NOT scroll — they belong to the InputBox (history /
// delete-to-line-start) and Ink delivers each keypress to every active
// useInput handler.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { CommandPicker } from "./CommandPicker.js";
import { EffortPrompt } from "./EffortPrompt.js";
import { HelpPanel } from "./HelpPanel.js";
import { type CommandInfo, InputBox } from "./InputBox.js";
import { t } from "./i18n.js";
import { ModelPicker } from "./ModelPicker.js";
import { PlanApproval } from "./PlanApproval.js";
import { PromptFooter } from "./PromptFooter.js";
import { ConfirmPrompt, PermissionPrompt, QuestionPrompt } from "./Prompts.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { RetryLine } from "./RetryLine.js";
import { RewindPicker } from "./RewindPicker.js";
import { bottomScrollTop, clampScrollTop, ScrollView } from "./ScrollView.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusLine } from "./StatusLine.js";
import { actionLabel } from "./spinner-core.js";
import type { StoreState, TuiStore } from "./store.js";
import { Toast } from "./Toast.js";
import { TodoList } from "./TodoList.js";
import { TranscriptReview } from "./TranscriptReview.js";
import { transcriptToLines } from "./transcript-lines.js";
import { useStoreField, useStoreSelector } from "./useStoreSelector.js";
import { useTerminalSize } from "./useTerminalSize.js";

/** Present-continuous status label for the live status line. */
function statusLabel(
  activeTools: StoreState["activeTools"],
  spinner: StoreState["spinner"],
): string {
  if (activeTools.length === 1) {
    const tool = activeTools[0]!;
    return actionLabel(tool.name, tool.detail);
  }
  if (activeTools.length > 1) return t("ui.phase.runningTools", { n: activeTools.length });
  if (spinner === "responding") return t("ui.phase.responding");
  return t("ui.phase.thinking");
}

function selectStatusLine(s: StoreState) {
  return {
    busy: s.busy,
    spinner: s.spinner,
    turnStartedAt: s.turnStartedAt,
    spinnerTokens: s.spinnerTokens,
    activityAt: s.spinnerActivityAt,
    toolCount: s.activeTools.length,
    label: statusLabel(s.activeTools, s.spinner),
  };
}

/** Animated status line while thinking / responding (no active tool). */
function FsStatusLine({ store }: { store: TuiStore }) {
  const { busy, spinner, turnStartedAt, spinnerTokens, activityAt, toolCount, label } =
    useStoreSelector(store, selectStatusLine);
  if (!(busy && toolCount === 0 && spinner !== "idle")) return null;
  return (
    <StatusLine
      label={label}
      startedAt={turnStartedAt}
      tokens={spinnerTokens}
      activityAt={activityAt}
      cycleVerbs={spinner === "thinking"}
    />
  );
}

function selectInteraction(s: StoreState) {
  return {
    overlay: s.overlay,
    busy: s.busy,
    inputHistory: s.inputHistory,
    queuedMessages: s.queuedMessages,
    inputAction: s.inputAction,
  };
}

function selectHelp(s: StoreState) {
  return { showHelp: s.showHelp, permissionMode: s.permissionMode };
}

function FsHelpRegion({ store }: { store: TuiStore }) {
  const { showHelp, permissionMode } = useStoreSelector(store, selectHelp);
  if (!showHelp) return null;
  return <HelpPanel currentMode={permissionMode} onClose={() => store.setShowHelp(false)} />;
}

/** Overlay (when present) or the InputBox — pinned to the bottom, no bottom
 *  rule, so the prompt row is the last line and the cursor sits on it. */
function FsInteraction({
  store,
  commands,
  onSubmit,
  editorMode,
  completeFiles,
  onRewind,
  onImagePaste,
  onQueuePop,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  editorMode?: { value: "default" | "vim" };
  completeFiles?: (query: string) => string[];
  onRewind?: () => void;
  onImagePaste?: () => Promise<string | null>;
  onQueuePop?: () => string | null;
}) {
  const { overlay, busy, inputHistory, queuedMessages, inputAction } = useStoreSelector(
    store,
    selectInteraction,
  );
  if (overlay) {
    switch (overlay.kind) {
      case "permission":
        return <PermissionPrompt overlay={overlay} store={store} />;
      case "question":
        return <QuestionPrompt overlay={overlay} />;
      case "sessionPicker":
        return <SessionPicker overlay={overlay} />;
      case "providerPicker":
        return <ProviderPicker overlay={overlay} />;
      case "modelPicker":
        return <ModelPicker overlay={overlay} />;
      case "planApproval":
        return <PlanApproval overlay={overlay} />;
      case "commandPicker":
        return <CommandPicker overlay={overlay} />;
      case "rewind":
        return <RewindPicker overlay={overlay} />;
      case "confirm":
        return <ConfirmPrompt overlay={overlay} />;
      default:
        return <EffortPrompt overlay={overlay} />;
    }
  }
  return (
    <>
      {busy ? <QueuedMessages messages={queuedMessages} /> : null}
      <InputBox
        commands={commands}
        disabled={false}
        busy={busy}
        onSubmit={onSubmit}
        editorMode={editorMode}
        completeFiles={completeFiles}
        keepColorWhenDisabled
        hideBottomRule
        history={inputHistory}
        onHistoryChange={(history) => store.setInputHistory(history)}
        onRewind={busy ? undefined : onRewind}
        onImagePaste={onImagePaste}
        onQueuePop={busy ? onQueuePop : undefined}
        pendingAction={inputAction}
        inputSuspended={() => store.getSnapshot().showHelp}
        onDraftChange={(draft) => store.setDraft(draft)}
        initialDraft={store.getSnapshot().draft}
      />
    </>
  );
}

/** P0-4: live retry countdown — shown where the status line sits. */
function FsRetryRegion({ store }: { store: TuiStore }) {
  const retry = useStoreField(store, "retryStatus");
  if (!retry) return null;
  return <RetryLine retry={retry} />;
}

/** Pinned live todo list between the scroll region and the status line (the
 *  same projection of Todo-tool state as App.tsx's TodoRegion). Rendering and
 *  windowing are shared via TodoList. */
function FsTodoRegion({ store }: { store: TuiStore }) {
  const todos = useStoreField(store, "todos");
  if (todos.length === 0) return null;
  return <TodoList todos={todos} />;
}

/** Mode hotkey — self-contained so FullScreenApp works without App.tsx. */
function FsModeHotkey({
  store,
  onModelPicker,
  onThinkingToggle,
}: {
  store: TuiStore;
  onModelPicker?: () => void;
  onThinkingToggle?: () => void;
}) {
  useInput((input, key) => {
    // Overlays own the keyboard (pickers bind their own keys).
    if (store.getSnapshot().overlay) return;
    if (key.ctrl && input === "s") {
      store.dispatchInputAction("stash");
    } else if (key.ctrl && input === "g") {
      store.dispatchInputAction("editor");
    } else if (key.ctrl && input === "r") {
      store.dispatchInputAction("historySearch");
    } else if (key.ctrl && input === "t") {
      store.toggleTodosCollapsed();
    } else if (key.ctrl && input === "l") {
      process.stdout.write("[2J[H");
      store.setQueuedInputs(store.getSnapshot().queuedInputs);
    } else if (key.meta && input === "p") {
      onModelPicker?.();
    } else if (key.meta && input === "t") {
      onThinkingToggle?.();
    } else if (key.tab && key.shift) {
      store.cyclePermissionMode();
    } else if (input === "?") {
      // Same contract as App's ModeHotkey: "?" opens help only on an empty
      // draft (the InputBox mirrors it into the store) and never toggles
      // closed — the panel closes via Esc/Enter, which the input-suspended
      // InputBox must not also consume.
      const s = store.getSnapshot();
      if (s.draft.text.length === 0 && !s.showHelp) store.setShowHelp(true);
    } else if (key.ctrl && input === "o") {
      // P0-1/P0-2: fullscreen thinking renders collapsed — this is the only
      // route to the verbose transcript viewer here.
      store.setReviewing(!store.getSnapshot().reviewing);
    }
  });
  return null;
}

export function FullScreenApp({
  store,
  commands,
  onSubmit,
  editorMode,
  completeFiles,
  onRewind,
  onImagePaste,
  onQueuePop,
  onModelPicker,
  onThinkingToggle,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  editorMode?: { value: "default" | "vim" };
  completeFiles?: (query: string) => string[];
  onRewind?: () => void;
  onImagePaste?: () => Promise<string | null>;
  /** B6: recall the last queued message (Up from an empty buffer). */
  onQueuePop?: () => string | null;
  /** B8 (alt+p): open the model picker overlay. */
  onModelPicker?: () => void;
  /** B8 (alt+t): flip extended thinking on/off. */
  onThinkingToggle?: () => void;
}) {
  const { rows } = useTerminalSize();
  const transcript = useStoreField(store, "transcript");
  const streamingText = useStoreField(store, "streamingText");
  const streamingThinking = useStoreField(store, "streamingThinking");

  const lines = transcriptToLines(transcript, streamingText, streamingThinking);
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

  // Scroll handler. Keys are chosen to NEVER collide with the InputBox, which
  // is always mounted below and receives the same Ink keypresses: ↑/↓ are the
  // input history / multi-line cursor, and Ctrl+U is delete-to-line-start —
  // binding them here too made one keypress both scroll and edit the buffer.
  // That leaves PgUp/PgDn (some terminals disagree, so less-style Ctrl+B/F are
  // the full-page fallback) plus Ctrl+End/G to re-stick at the bottom.
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
    // Pickers/overlays bind PgUp/PgDn themselves; the transcript viewer owns
    // the whole keyboard while open — don't scroll the background too.
    if (store.getSnapshot().overlay || store.getSnapshot().reviewing) return;
    if (key.pageUp) return void scrollBy(-1, 0.5);
    if (key.pageDown) return void scrollBy(1, 0.5);
    if (key.ctrl && input === "b") return void scrollBy(-1, 0.95);
    if (key.ctrl && input === "f") return void scrollBy(1, 0.95);
    if ((key.ctrl && (key.downArrow || (key as { end?: boolean }).end)) || input === "G") {
      return void scrollBy(1, 0, { toBottom: true });
    }
  });

  const reviewing = useStoreField(store, "reviewing");
  if (reviewing) {
    // P0-1: the verbose transcript viewer replaces the scroll view and owns
    // the keyboard (the InputBox unmounts so its history keys don't fight it).
    return (
      <Box flexDirection="column" height={rows}>
        <FsModeHotkey
          store={store}
          onModelPicker={onModelPicker}
          onThinkingToggle={onThinkingToggle}
        />
        <Toast store={store} />
        <TranscriptReview store={store} />
        <PromptFooter store={store} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={rows}>
      <FsModeHotkey
        store={store}
        onModelPicker={onModelPicker}
        onThinkingToggle={onThinkingToggle}
      />
      <Toast store={store} />
      <ScrollView
        lines={lines}
        scrollTop={scrollTop}
        fallbackHeight={Math.max(3, rows - 5)}
        onHeight={onViewportHeight}
      />
      <FsTodoRegion store={store} />
      <FsRetryRegion store={store} />
      {!sticky ? (
        <Text dimColor>{`  ${t("ui.fs.scrolled")}`}</Text>
      ) : (
        <FsStatusLine store={store} />
      )}
      <PromptFooter store={store} />
      <FsHelpRegion store={store} />
      {/* InputBox MUST be the last element: the terminal parks the real cursor
          at the end of the final rendered row, so the prompt has to be that row
          (InputBox renders with no bottom rule in this path). */}
      <FsInteraction
        onQueuePop={onQueuePop}
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        editorMode={editorMode}
        completeFiles={completeFiles}
        onRewind={onRewind}
        onImagePaste={onImagePaste}
      />
    </Box>
  );
}
