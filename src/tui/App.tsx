// ============================================================
// App — root Ink component (9.1 / 9.2 · M24.2 field-sliced rerender)
// ============================================================
// Completed transcript items go in <Static> (printed once, scroll into
// history, never repainted — this is what makes streaming flicker-free). The
// live region below shows in-progress assistant text + active tools + spinner.
// An overlay (permission / question) takes over input when present; otherwise
// the InputBox is active.
//
// M24.2: instead of one whole-snapshot subscription that re-rendered the entire
// tree on every streamed token, the App is split into region components that
// each subscribe (via useStoreField / useStoreSelector) to only the slice they
// render. A token delta now re-renders the streaming text region alone — the
// input box, status bar, and idle regions stay put. This is the core of the
// M24 "response smoothing": no more whole-tree reconcile per frame.
// ============================================================

import { Box, Static, Text, useInput, usePaste } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CommandPicker } from "./CommandPicker.js";
import { EffortPrompt } from "./EffortPrompt.js";
import { FullScreenApp } from "./FullScreenApp.js";
import { BLACK_CIRCLE } from "./figures.js";
import { HelpPanel } from "./HelpPanel.js";
import { type CommandInfo, InputBox } from "./InputBox.js";
import { t } from "./i18n.js";
import { createResolver, DEFAULT_BINDINGS, loadUserBindings } from "./keybindings/index.js";
import { LoopMenu } from "./LoopMenu.js";
import { tailVisualLines } from "./live-window.js";
import { ModelPicker } from "./ModelPicker.js";
import { renderMarkdown } from "./markdown.js";
import { PlanApproval } from "./PlanApproval.js";
import { PromptFooter } from "./PromptFooter.js";
import { promptRequestKey } from "./PromptPanel.js";
import { ConfirmPrompt, ElicitationPrompt, PermissionPrompt, QuestionPrompt } from "./Prompts.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { RetryLine } from "./RetryLine.js";
import { RewindPicker } from "./RewindPicker.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusLine } from "./StatusLine.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { isReducedMotion, nextTipId } from "./spinner-core.js";
import type { StoreState, TranscriptItem, TuiStore } from "./store.js";
import { CTX_CRITICAL_PCT, CTX_WARN_PCT } from "./store.js";
import { Toast } from "./Toast.js";
import { TODO_MAX_ROWS, TodoList } from "./TodoList.js";
import { TogglePicker } from "./TogglePicker.js";
import { ActiveToolCard, CompletedToolCard } from "./ToolCard.js";
import { TranscriptReview } from "./TranscriptReview.js";
import { truncateVisual } from "./terminal-width.js";
import { palette } from "./theme.js";
import { collapsedThinkingLine, userMessageLines } from "./transcript-lines.js";
import { useStoreField, useStoreSelector } from "./useStoreSelector.js";
import { useTerminalSize } from "./useTerminalSize.js";

/** Shared layout for committed and streaming replies. */
function AssistantMessage({ children }: { children: ReactNode }) {
  return (
    <Box>
      <Text color={palette.userText}>{`${BLACK_CIRCLE} `}</Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * Present-continuous phase word for the live status line (M23.3). The concrete
 * per-tool action ("Reading App.tsx") lives on the tool cards below the status
 * line, so the label only reflects the loop phase ("Thinking" / "Responding").
 */
function statusLabel(spinner: StoreState["spinner"]): string {
  if (spinner === "responding") return t("ui.phase.responding");
  return t("ui.phase.thinking");
}

/**
 * Keeps bracketed-paste mode (2004h) enabled for the WHOLE app lifetime.
 * InputBox is the primary usePaste consumer, but overlays and the transcript
 * pager REPLACE (unmount) it — the hook's refcount then drops to zero, Ink
 * writes `\x1b[?2004l`, and a paste floods the modal's useInput handlers as
 * raw keystrokes. Overlays resolve on single keys (`y` approves a permission,
 * Enter confirms a picker, `v` opens $EDITOR in the pager), so the first
 * pasted character can act on them instantly. This always-mounted no-op
 * absorber holds the refcount above zero and routes paste bytes to the paste
 * channel, where they are safely dropped while InputBox is absent.
 */
function PasteGuard(): null {
  usePaste(() => {});
  return null;
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Box flexDirection="column">
          {userMessageLines(item).map((line, i) => (
            <Text key={i} color={line.color} backgroundColor={line.backgroundColor}>
              <Text
                color={item.bash ? palette.bashBorder : item.memory ? "#7aa2f7" : palette.secondary}
              >
                {line.text.slice(0, 2)}
              </Text>
              {line.text.slice(2)}
            </Text>
          ))}
        </Box>
      );
    case "assistant":
      return (
        <AssistantMessage>
          <Text color={palette.text}>{renderMarkdown(item.text)}</Text>
        </AssistantMessage>
      );
    case "thinking_text":
      // P0-2: committed reasoning renders COLLAPSED (one dim line); the full
      // text lives in the transcript viewer (Ctrl+O). The label comes from
      // the SHARED collapsedThinkingLine (transcript-lines.ts) so this path
      // and the flat-lines path can never disagree — including the
      // no-duration case (/resume replayed history shows "Thinking · N
      // lines", not a misleading "Thought for 0s").
      return (
        <Text color={palette.secondary}>
          {`  ${collapsedThinkingLine(item.seconds, item.text.split("\n").length)}`}
        </Text>
      );
    case "tool":
      return item.result ? <CompletedToolCard result={item.result} detail={item.detail} /> : null;
    case "thought":
      return <Text color={palette.secondary}>{`  Thought for ${item.seconds}s`}</Text>;
    case "notice":
      return <Text dimColor>{item.text}</Text>;
    case "compact":
      // Official CompactSummary: bold ⏺ header, dim ⎿ detail lines, and the
      // ctrl+o hint pointing at the verbose viewer.
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>⏺ </Text>
            <Text bold>{t("ui.compact.title")}</Text>
          </Text>
          <Box flexDirection="column" paddingLeft={2}>
            {item.messages !== undefined ? (
              <Text dimColor>{`⎿  ${t("ui.compact.messages", { n: item.messages })}`}</Text>
            ) : null}
            <Text
              dimColor
            >{`⎿  ${t("ui.compact.context", { snippet: truncateVisual(item.summary, 120) })}`}</Text>
            <Text dimColor>{`   ${t("ui.tool.expandHint")}`}</Text>
          </Box>
        </Box>
      );
    case "log":
      return (
        <Box flexDirection="column">
          {item.lines.map((l, i) => (
            <Box key={i} minHeight={1}>
              <Text>{l}</Text>
            </Box>
          ))}
        </Box>
      );
  }
}

// --- Region components: each subscribes to only the slice it renders ---

/** Completed history — printed once into <Static>, never repainted. */
function TranscriptRegion({ store }: { store: TuiStore }) {
  const transcript = useStoreField(store, "transcript");
  // The epoch key remounts <Static> after a bulk transcript replace (rewind /
  // reload). Ink's Static keeps a monotonically growing internal index: on a
  // SHRUNK items array, slice(index) stays empty forever and every later item
  // would be swallowed. Remounting restarts the index (and reprints the
  // surviving history — same semantics as the /resume replay).
  const epoch = useStoreField(store, "transcriptEpoch");
  return (
    <Static key={epoch} items={transcript}>
      {(item) => (
        <Box
          key={item.id}
          marginBottom={
            ["user", "assistant", "tool", "thought", "thinking_text"].includes(item.kind) ? 1 : 0
          }
        >
          <TranscriptRow item={item} />
        </Box>
      )}
    </Static>
  );
}

/**
 * Live-chrome rows around the streaming window, derived from ACTUAL state
 * (not a worst-case constant): the status line hides while tools run, the
 * todo list and tool cards are capped, toast/help are transient. Keeping this
 * exact is what makes the frame-height invariant hold when everything is
 * visible at once, without wasting space in the common case.
 */
function selectLiveChromeRows(s: StoreState): number {
  let rows = 0;
  // Status line (shown whenever the loop is busy — spinner phase + live region).
  if (s.busy && s.spinner !== "idle") rows += 1;
  // Todo region: windowed to at most TODO_MAX_ROWS rows.
  if (s.todos.length > 0) rows += Math.min(s.todos.length, TODO_MAX_ROWS);
  // Active tool cards: ≤3 + one overflow row.
  rows += Math.min(s.activeTools.length, 3) + (s.activeTools.length > 3 ? 1 : 0);
  if (s.toast) rows += 1;
  // P0-4: live retry countdown replaces the status line's slot while active.
  if (s.retryStatus) rows += 1;
  // Help panel is clipped to max(5, rows-8) — while it's open, conservatively
  // assume the clip fills (streaming shrinks to the floor; the user is reading
  // help, not the stream).
  if (s.showHelp) rows += 20;
  return rows;
}

/** Rows the streaming window must always leave: input box (4) + status bar
 *  (1) + its own margin (1) + elision hint (1) + wrap-estimation slack (1). */
const LIVE_FIXED_ROWS = 8;

function useLiveMaxLines(store: TuiStore, termRows: number): number {
  const chromeRows = useStoreSelector(store, selectLiveChromeRows);
  // Pathological case (tiny terminal + everything visible): the floor of 2 can
  // still overflow — the pager (PgUp) is the escape hatch there.
  return Math.max(2, termRows - chromeRows - LIVE_FIXED_ROWS);
}

/**
 * Live streaming assistant text. Subscribes to ONLY `streamingText`, so the
 * ~30fps stream of token deltas re-renders this leaf and nothing else (M24.3).
 * Markdown is rendered LIVE via StreamingMarkdown: completed blocks settle into
 * a memoized prefix (parsed once), only the in-progress tail re-lexes per frame.
 * At commit the same text becomes an AssistantMessage transcript row with no
 * layout shift (shared bullet + markdown-column layout).
 *
 * HEIGHT BOUND (frame-leak fix): the text is windowed to its last few visual
 * lines so the live frame can never grow taller than the terminal — an
 * over-tall frame breaks Ink's erase-the-previous-frame math and leaks the
 * frame's top line into the scrollback on every redraw. Hidden lines stay in
 * the store and land in <Static> at commit; PgUp shows them live.
 */
function StreamingRegion({ store }: { store: TuiStore }) {
  const streamingText = useStoreField(store, "streamingText");
  const { rows, columns } = useTerminalSize();
  const maxLines = useLiveMaxLines(store, rows);
  if (!streamingText) return null;
  // Slice the tail and re-wrap it a few columns NARROWER than the body column,
  // so Ink's own wrap never reflows these lines (wrap-ansi trim:false can push
  // a boundary segment past the terminal width, which wraps mid-frame and
  // desyncs the erase count). The maxHeight+overflowY box is the hard backstop
  // for markdown constructs whose rendered height can't be predicted. Clip
  // keeps the top of the slice, so the slice errs on the under-full side.
  const { text, hiddenLines } = tailVisualLines(streamingText, maxLines, columns - 8);
  return (
    <Box marginBottom={1} flexDirection="column">
      {hiddenLines > 0 ? (
        <Text dimColor>{`  ${t("ui.elide.above", { n: hiddenLines })}`}</Text>
      ) : null}
      <Box maxHeight={maxLines} overflowY="hidden" flexDirection="column">
        <AssistantMessage>
          <StreamingMarkdown>{text}</StreamingMarkdown>
        </AssistantMessage>
      </Box>
    </Box>
  );
}

/** Live streaming reasoning content (extended thinking). Subscribes to ONLY
 *  `streamingThinking`; rendered as plain dim text (no markdown — it's prose).
 *  Windowed + height-clipped for the same frame-leak reason as
 *  StreamingRegion — long thinking bursts are taller than most terminals. */
function ThinkingRegion({ store }: { store: TuiStore }) {
  const streamingThinking = useStoreField(store, "streamingThinking");
  const { rows, columns } = useTerminalSize();
  const maxLines = useLiveMaxLines(store, rows);
  if (!streamingThinking) return null;
  const { text, hiddenLines } = tailVisualLines(streamingThinking, maxLines, columns - 6);
  return (
    <Box flexDirection="column">
      {hiddenLines > 0 ? (
        <Text dimColor>{`  ${t("ui.elide.thinking", { n: hiddenLines })}`}</Text>
      ) : null}
      <Box maxHeight={maxLines} overflowY="hidden" flexDirection="column">
        <Text dimColor italic>
          {text}
        </Text>
      </Box>
    </Box>
  );
}

/** Live tool cards (one per concurrent tool). Subscribes to `activeTools`.
 *  Capped at 3 cards + an overflow line so a subagent storm can't push the
 *  live frame past the viewport (same frame-leak invariant as the streams). */
function ActiveToolsRegion({ store }: { store: TuiStore }) {
  const activeTools = useStoreField(store, "activeTools");
  const visible = activeTools.slice(0, 3);
  const hidden = activeTools.length - visible.length;
  return (
    <>
      {visible.map((t) => (
        <ActiveToolCard key={t.id} name={t.name} detail={t.detail} startedAt={t.startedAt} />
      ))}
      {hidden > 0 ? <Text dimColor>{`  ${t("ui.tools.moreRunning", { n: hidden })}`}</Text> : null}
    </>
  );
}

/** Pinned live todo list, hanging below the status line (mirrors the reference
 *  layout: spinner on top, todo list attached under it via `⎿`). The list is a
 *  projection of the Todo tool's session state — it updates in place on every
 *  todo call and is retired when the turn ends. Rendering
 *  (incl. the active-item-centered window for long lists) lives in TodoList. */
function TodoRegion({ store }: { store: TuiStore }) {
  const todos = useStoreField(store, "todos");
  const collapsed = useStoreField(store, "todosCollapsed");
  if (todos.length === 0 || collapsed) return null;
  return <TodoList todos={todos} />;
}

/** B4 (ctrl+t): while the todo list is collapsed, the next pending task rides
 *  under the spinner as the official "Next: <task>" line — collapsing keeps
 *  the signal without the rows. */
function NextTodoRegion({ store }: { store: TuiStore }) {
  const todos = useStoreField(store, "todos");
  const collapsed = useStoreField(store, "todosCollapsed");
  const next =
    todos.find((x) => x.status === "in_progress") ?? todos.find((x) => x.status === "pending");
  if (!collapsed || !next) return null;
  return <Text dimColor>{`  ${t("ui.todos.next", { task: next.content })}`}</Text>;
}

/** D1: a tip only shows once the spinner has been running this long. */
const TIP_AFTER_MS = 8000;

/**
 * D1: the official-style tip line under the spinner. Appears once the turn
 * has run ≥8s AND the todo projection is empty (todos own this slot via
 * "Next:" first — official effectiveTip priority). Owns a slow tick so the
 * 8s deadline fires even while the stream is silent; reduced motion keeps
 * the line but drops the ticking cadence cost. The rotation pool lives on
 * the store (one per TUI instance, reset on /clear and /resume), so a tip
 * never repeats within a session.
 */
export function TipLine({
  turnStartedAt,
  todos,
  pool,
}: {
  turnStartedAt: number;
  todos: number;
  pool: Set<string>;
}) {
  const [tipId, setTipId] = useState<string | null>(null);
  // The tip leaves the pool ONLY when the 8s gate fires — picking at mount
  // would burn one pool entry per turn even when the turn ends before the
  // tip ever displays, silently exhausting all 14 tips on short turns.
  // The ref (not a state updater) does the picking: React may double-invoke
  // updaters, and nextTipId mutates the pool.
  const tipIdRef = useRef<string | null>(null);
  const reduced = isReducedMotion();
  useEffect(() => {
    const t = setInterval(
      () => {
        if (Date.now() - turnStartedAt < TIP_AFTER_MS) return;
        if (tipIdRef.current === null) tipIdRef.current = nextTipId(pool);
        setTipId(tipIdRef.current);
      },
      reduced ? 1000 : 500,
    );
    return () => clearInterval(t);
  }, [turnStartedAt, pool, reduced]);
  if (tipId === null || todos > 0 || turnStartedAt <= 0) return null;
  return <Text dimColor>{`  ⎿ Tip: ${t(`ui.tip.${tipId}`)}`}</Text>;
}

/**
 * Animated status line, shown whenever the loop is busy (tool cards render in
 * their own region below). Subscribes to the small slice that decides
 * visibility + label; the StatusLine owns its own per-frame interval for the
 * glyph/shimmer/clock, so the animation itself never touches this subscription.
 */
function StatusLineRegion({ store }: { store: TuiStore }) {
  const { busy, spinner, turnStartedAt, spinnerTokens, activityAt, label, todoCount } =
    useStoreSelector(store, selectStatusLine);
  if (!(busy && spinner !== "idle")) return null;
  return (
    <Box flexDirection="column">
      <StatusLine
        label={label}
        startedAt={turnStartedAt}
        tokens={spinnerTokens}
        activityAt={activityAt}
        cycleVerbs={spinner !== "responding"}
      />
      <NextTodoRegion store={store} />
      <TipLine turnStartedAt={turnStartedAt} todos={todoCount} pool={store.getTipPool()} />
    </Box>
  );
}

function selectStatusLine(s: StoreState) {
  return {
    busy: s.busy,
    spinner: s.spinner,
    turnStartedAt: s.turnStartedAt,
    spinnerTokens: s.spinnerTokens,
    activityAt: s.spinnerActivityAt,
    todoCount: s.todos.length,
    label: statusLabel(s.spinner),
  };
}

/**
 * Batch C4: the persistent Context-low line (official TokenWarning). Shows
 * once the window is ≥75% used — amber, then red at ≥90% — with the official
 * "Run /compact" phrasing. The footer's right column keeps the quiet
 * "X% until auto-compact" number; THIS line is the loud warning.
 */
function TokenWarningRegion({ store }: { store: TuiStore }) {
  const { contextUsed, contextLimit } = useStoreSelector(store, (s: StoreState) => ({
    contextUsed: s.contextUsed,
    contextLimit: s.contextLimit,
  }));
  if (contextLimit <= 0 || contextUsed <= 0) return null;
  const fraction = Math.min(1, contextUsed / contextLimit);
  if (fraction < CTX_WARN_PCT) return null;
  const remaining = 100 - Math.floor(fraction * 100);
  const line = t("ui.compact.low", { pct: remaining });
  // palette.error / palette.warning, not literals: the old hexes were the DARK
  // values, so this warning stayed dark-red on a light theme.
  return <Text color={fraction >= CTX_CRITICAL_PCT ? palette.error : palette.warning}>{line}</Text>;
}

/** P0-4: live model-error retry countdown ("⚠ 429 — retrying in 8s · 2/10").
 *  Subscribes to `retryStatus` alone; the store owns the 1s countdown tick. */
function RetryRegion({ store }: { store: TuiStore }) {
  const retry = useStoreField(store, "retryStatus");
  if (!retry) return null;
  return <RetryLine retry={retry} />;
}

/** Overlay (when present) or the InputBox. Subscribes to `overlay` + `busy`. */
function InteractionRegion({
  store,
  commands,
  onSubmit,
  editorMode,
  completeFiles,
  onRewind,
  onImagePaste,
  onQueuePop,
  onLargePaste,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  editorMode?: { value: "default" | "vim" };
  completeFiles?: (query: string) => string[];
  /** P0-3: double-Esc rewind trigger (idle + empty input). */
  onRewind?: () => void;
  /** P0-5: Ctrl+V clipboard-image paste; resolves with the "[Image #N]" chip
   *  (registered by the runner) or null when no image was read. */
  onImagePaste?: () => Promise<string | null>;
  /** B6: recall the last queued message (Up from an empty buffer). */
  onQueuePop?: () => string | null;
  /** D5: fold large pastes into chips. */
  onLargePaste?: (content: string) => string;
}) {
  const { overlay, busy, inputHistory, queuedMessages, inputAction } = useStoreSelector(
    store,
    selectInteraction,
  );
  if (overlay) {
    switch (overlay.kind) {
      case "loopMenu":
        return <LoopMenu overlay={overlay} />;
      case "permission":
        return <PermissionPrompt key={promptRequestKey(overlay)} overlay={overlay} store={store} />;
      case "question":
        return <QuestionPrompt key={promptRequestKey(overlay)} overlay={overlay} />;
      case "elicitation":
        return <ElicitationPrompt key={promptRequestKey(overlay)} overlay={overlay} />;
      case "sessionPicker":
        return <SessionPicker overlay={overlay} />;
      case "providerPicker":
        return <ProviderPicker overlay={overlay} />;
      case "modelPicker":
        return <ModelPicker overlay={overlay} />;
      case "togglePicker":
        return <TogglePicker overlay={overlay} />;
      case "planApproval":
        return <PlanApproval key={promptRequestKey(overlay)} overlay={overlay} />;
      case "commandPicker":
        return <CommandPicker overlay={overlay} />;
      case "rewind":
        return <RewindPicker overlay={overlay} />;
      case "confirm":
        return <ConfirmPrompt key={promptRequestKey(overlay)} overlay={overlay} />;
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
        history={inputHistory}
        onHistoryChange={(history) => store.setInputHistory(history)}
        onRewind={busy ? undefined : onRewind}
        onImagePaste={onImagePaste}
        onQueuePop={busy ? onQueuePop : undefined}
        onLargePaste={onLargePaste}
        pendingAction={inputAction}
        inputSuspended={() => store.getSnapshot().showHelp}
        onDraftChange={(draft) => store.setDraft(draft)}
        initialDraft={store.getSnapshot().draft}
      />
    </>
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

function HelpRegion({ store }: { store: TuiStore }) {
  const { showHelp, permissionMode } = useStoreSelector(store, selectHelp);
  if (!showHelp) return null;
  return (
    <HelpPanel
      currentMode={permissionMode}
      onClose={() => queueMicrotask(() => store.setShowHelp(false))}
    />
  );
}

// Global-hotkey resolver: defaults + any user overrides from
// ~/.claude/keybindings.json. Loaded once at startup (not hot-reloaded).
const globalResolver = createResolver(DEFAULT_BINDINGS, loadUserBindings());

function ModeHotkey({
  store,
  onModelPicker,
  onThinkingToggle,
}: {
  store: TuiStore;
  /** B8 (alt+p): open the model picker overlay. */
  onModelPicker?: () => void;
  /** B8 (alt+t): flip extended thinking on/off. */
  onThinkingToggle?: () => void;
  /** D5: fold a large paste into a "[Pasted text #N +L lines]" chip; the
   *  runner stores the content and expands it on submit. */
  onLargePaste?: (content: string) => string;
}) {
  useInput((input, key) => {
    const result = globalResolver(input, key, ["Global"]);
    if (result.type !== "match") return;
    // Overlays own the keyboard: flipping `reviewing` under an open overlay
    // would unmount the overlay component and hang its resolve() promise.
    if (store.getSnapshot().overlay || store.getSnapshot().showHelp) return;
    if (result.action === "transcript:review") {
      // PgUp opens the viewer; while reviewing, the viewer owns the keyboard
      // (PgUp/PgDn scroll there) so this becomes a no-op.
      if (!store.getSnapshot().reviewing) store.setReviewing(true);
      return;
    }
    if (result.action === "transcript:toggle") {
      // Ctrl+O toggles (P0-1): opens the verbose viewer, closes it while open.
      store.setReviewing(!store.getSnapshot().reviewing);
      return;
    }
    // Review mode owns the keyboard: suppress other global hotkeys.
    if (store.getSnapshot().reviewing) return;
    if (result.action === "chat:cycleMode") {
      store.cyclePermissionMode();
    } else if (result.action === "chat:stash") {
      // B4: the InputBox owns the buffer — signal it through the store.
      store.dispatchInputAction("stash");
    } else if (result.action === "chat:externalEditor") {
      store.dispatchInputAction("editor");
    } else if (result.action === "history:search") {
      store.dispatchInputAction("historySearch");
    } else if (result.action === "app:toggleTodos") {
      store.toggleTodosCollapsed();
    } else if (result.action === "app:redraw") {
      // B5 (ctrl+l): clear the viewport (scrollback stays) and force a store
      // emit so Ink repaints the live frame immediately — Ink 7's useApp has
      // no clear(), so this is the manual equivalent.
      process.stdout.write("\x1B[2J\x1B[H");
      store.setQueuedInputs(store.getSnapshot().queuedInputs);
    } else if (result.action === "chat:modelPicker") {
      onModelPicker?.();
    } else if (result.action === "chat:thinkingToggle") {
      onThinkingToggle?.();
    } else if (result.action === "help:toggle" && !store.getSnapshot().overlay) {
      // "?" opens help only on an EMPTY draft — typing "what is X?" must
      // insert the character, not pop the panel. The InputBox mirrors its
      // draft into the store; while the panel is open the box is
      // input-suspended, so "?" stays swallowed and the panel closes via
      // Esc/Enter (which the box must NOT also see — see inputSuspended).
      const s = store.getSnapshot();
      if (s.draft.text.length === 0 && !s.showHelp) store.setShowHelp(true);
    }
  });
  return null;
}

/**
 * The regions between Toast and PromptFooter. Subscribes to `reviewing` only.
 * When the transcript pager is open it REPLACES the live/input regions (the
 * InputBox must unmount so its ↑/↓ history keys don't fight the pager) — but
 * TranscriptRegion stays MOUNTED either way: Ink's <Static> restarts its
 * emitted-index at 0 on remount, so unmounting it here would reprint the
 * entire transcript into the scrollback every time the pager closes. New
 * items committed while reviewing simply print above the pager (normal
 * terminal scroll); the pager itself becomes the live region.
 */
function ReviewableBody({
  store,
  commands,
  onSubmit,
  editorMode,
  completeFiles,
  onRewind,
  onImagePaste,
  onQueuePop,
  onLargePaste,
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
  /** D5: fold large pastes into chips. */
  onLargePaste?: (content: string) => string;
}) {
  const reviewing = useStoreField(store, "reviewing");
  const showHelp = useStoreField(store, "showHelp");
  const loopMenu = useStoreSelector(store, (state) => state.overlay?.kind === "loopMenu");
  if (reviewing) {
    return (
      <>
        <TranscriptRegion store={store} />
        <TranscriptReview store={store} />
      </>
    );
  }
  return (
    <>
      <TranscriptRegion store={store} />
      {loopMenu ? null : showHelp ? (
        <HelpRegion store={store} />
      ) : (
        <>
          <ThinkingRegion store={store} />
          <StreamingRegion store={store} />
          <ActiveToolsRegion store={store} />
          <RetryRegion store={store} />
          <TokenWarningRegion store={store} />
          <StatusLineRegion store={store} />
          <TodoRegion store={store} />
        </>
      )}
      <InteractionRegion
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        editorMode={editorMode}
        completeFiles={completeFiles}
        onRewind={onRewind}
        onImagePaste={onImagePaste}
        onQueuePop={onQueuePop}
        onLargePaste={onLargePaste}
      />
    </>
  );
}

export function App({
  store,
  commands,
  onSubmit,
  editorMode,
  completeFiles,
  fullscreen,
  onRewind,
  onImagePaste,
  onQueuePop,
  onModelPicker,
  onThinkingToggle,
  onLargePaste,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  editorMode?: { value: "default" | "vim" };
  /** Workspace path matcher for the InputBox's "@" dropdown. */
  completeFiles?: (query: string) => string[];
  /** M25.2: when true, render the alt-screen full-screen layout (input pinned
   *  to the bottom + in-app PgUp/PgDn scrollback) instead of the default
   *  <Static> native-scrollback layout. */
  fullscreen?: boolean;
  /** P0-3: double-Esc rewind trigger. */
  onRewind?: () => void;
  /** P0-5: clipboard-image paste (Ctrl+V). */
  onImagePaste?: () => Promise<string | null>;
  /** B6: recall the last queued message (Up from an empty buffer). */
  onQueuePop?: () => string | null;
  /** B8 (alt+p): open the model picker overlay. */
  onModelPicker?: () => void;
  /** B8 (alt+t): flip extended thinking on/off. */
  onThinkingToggle?: () => void;
  /** D5: fold a large paste into a "[Pasted text #N +L lines]" chip; the
   *  runner stores the content and expands it on submit. */
  onLargePaste?: (content: string) => string;
}) {
  if (fullscreen) {
    // FullScreenApp contains its own FsModeHotkey — no need for ModeHotkey wrapper.
    return (
      <>
        <PasteGuard />
        <FullScreenApp
          store={store}
          commands={commands}
          onSubmit={onSubmit}
          editorMode={editorMode}
          completeFiles={completeFiles}
          onRewind={onRewind}
          onImagePaste={onImagePaste}
          onQueuePop={onQueuePop}
          onModelPicker={onModelPicker}
          onThinkingToggle={onThinkingToggle}
          onLargePaste={onLargePaste}
        />
      </>
    );
  }
  // The root no longer subscribes to the store at all — each region below owns
  // its own field-sliced subscription, so a mutation only re-renders the region
  // that reads the changed slice (M24.2). The outer column is a stable layout
  // anchor: regions appear/disappear but the vertical order is fixed, so the
  // InputBox keeps a predictable position (M24.5).
  return (
    <Box flexDirection="column">
      <PasteGuard />
      <ModeHotkey store={store} onModelPicker={onModelPicker} onThinkingToggle={onThinkingToggle} />
      <Toast store={store} />
      <ReviewableBody
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        editorMode={editorMode}
        completeFiles={completeFiles}
        onRewind={onRewind}
        onImagePaste={onImagePaste}
        onQueuePop={onQueuePop}
      />
      <PromptFooter store={store} />
    </Box>
  );
}
