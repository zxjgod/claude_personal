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

import { Box, Static, Text, useInput } from "ink";
import type { ReactNode } from "react";
import type { TodoDisplayItem } from "../types.js";
import { CommandPicker } from "./CommandPicker.js";
import { EffortPrompt } from "./EffortPrompt.js";
import { FullScreenApp } from "./FullScreenApp.js";
import { HelpPanel } from "./HelpPanel.js";
import { type CommandInfo, InputBox } from "./InputBox.js";
import { createResolver, DEFAULT_BINDINGS, loadUserBindings } from "./keybindings/index.js";
import { LIVE_CHROME_ROWS, tailVisualLines } from "./live-window.js";
import { renderMarkdown } from "./markdown.js";
import { ConfirmPrompt, PermissionPrompt, QuestionPrompt } from "./Prompts.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusLine } from "./StatusLine.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { actionLabel } from "./spinner-core.js";
import type { StoreState, TranscriptItem, TuiStore } from "./store.js";
import { Toast } from "./Toast.js";
import { ActiveToolCard, CompletedToolCard } from "./ToolCard.js";
import { TranscriptReview } from "./TranscriptReview.js";
import { modeColor, palette } from "./theme.js";
import { useStoreField, useStoreSelector } from "./useStoreSelector.js";
import { useTerminalSize } from "./useTerminalSize.js";

/** The orange ● bullet + a markdown body column. Shared by the committed
 *  assistant row and the live streaming region so the handoff at commit time
 *  has no layout shift — the body just stops re-parsing its tail. */
function AssistantMessage({ children }: { children: ReactNode }) {
  return (
    <Box>
      <Text color={palette.accent}>{"● "}</Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

/**
 * Present-continuous status for the live status line (M23.3). While a tool is
 * running we show the concrete action ("Reading App.tsx", "Running npm test");
 * otherwise the phase word ("Thinking" / "Responding").
 */
function statusLabel(
  activeTools: StoreState["activeTools"],
  spinner: StoreState["spinner"],
): string {
  if (activeTools.length === 1) {
    const t = activeTools[0]!;
    return actionLabel(t.name, t.detail);
  }
  if (activeTools.length > 1) {
    return `Running ${activeTools.length} tools`;
  }
  if (spinner === "responding") return "Responding";
  return "Thinking";
}

function TranscriptRow({ item, expanded }: { item: TranscriptItem; expanded: boolean }) {
  switch (item.kind) {
    case "user":
      // Role coloring: the user's turn is drawn in a calm blue (marker + text)
      // so it's instantly distinguishable from the assistant's orange-bulleted
      // reply as you scroll back through the transcript.
      return (
        <Box>
          <Text color={palette.user}>{"> "}</Text>
          <Text color={palette.user}>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <AssistantMessage>
          <Text>{renderMarkdown(item.text)}</Text>
        </AssistantMessage>
      );
    case "thinking_text":
      // Committed reasoning content: plain dim text, no markdown parsing.
      return (
        <Text dimColor italic>
          {item.text}
        </Text>
      );
    case "tool":
      return item.result ? (
        <CompletedToolCard result={item.result} detail={item.detail} expanded={expanded} />
      ) : null;
    case "thought":
      return <Text dimColor>{`  Thought for ${item.seconds}s`}</Text>;
    case "notice":
      return <Text dimColor>{item.text}</Text>;
    case "log":
      return (
        <Box flexDirection="column">
          {item.lines.map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
        </Box>
      );
  }
}

// --- Region components: each subscribes to only the slice it renders ---

/** Completed history — printed once into <Static>, never repainted. */
function TranscriptRegion({ store, expandedId }: { store: TuiStore; expandedId: number | null }) {
  const transcript = useStoreField(store, "transcript");
  return (
    <Static items={transcript}>
      {(item) => (
        <Box key={item.id} marginBottom={item.kind === "assistant" || item.kind === "tool" ? 1 : 0}>
          <TranscriptRow item={item} expanded={expandedId === item.id} />
        </Box>
      )}
    </Static>
  );
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
  if (!streamingText) return null;
  const maxLines = Math.max(3, rows - LIVE_CHROME_ROWS);
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
        <Text dimColor>{`  … 上文约 ${hiddenLines} 行（PgUp 回滚查看）`}</Text>
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
  if (!streamingThinking) return null;
  const maxLines = Math.max(3, rows - LIVE_CHROME_ROWS);
  const { text, hiddenLines } = tailVisualLines(streamingThinking, maxLines, columns - 6);
  return (
    <Box flexDirection="column">
      {hiddenLines > 0 ? (
        <Text dimColor>{`  … 思考前文约 ${hiddenLines} 行（PgUp 回滚查看）`}</Text>
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
        <ActiveToolCard key={t.id} name={t.name} detail={t.detail} />
      ))}
      {hidden > 0 ? <Text dimColor>{`  … +${hidden} 个工具运行中`}</Text> : null}
    </>
  );
}

/** One row of the pinned todo list. The first row carries the `⎿` connector
 *  (hanging from the status line above); continuation rows align under it. */
function TodoRow({ item, first }: { item: TodoDisplayItem; first: boolean }) {
  const prefix = first ? "  ⎿  " : "     ";
  if (item.status === "completed") {
    return (
      <Text dimColor>
        {prefix}☑ <Text strikethrough>{item.content}</Text>
      </Text>
    );
  }
  if (item.status === "in_progress") {
    return (
      <Text>
        {prefix}
        <Text color={palette.accent}>■ </Text>
        {item.content}
        {item.activeForm ? <Text dimColor>{` — ${item.activeForm}`}</Text> : null}
      </Text>
    );
  }
  return <Text dimColor>{`${prefix}□ ${item.content}`}</Text>;
}

/** Pinned live todo list, hanging below the status line (mirrors the reference
 *  layout: spinner on top, todo list attached under it via `⎿`). The list is a
 *  projection of the Todo tool's session state — it updates in place on every
 *  todo call and persists after the turn ends until the next update.
 *  Capped at 5 rows (4 items + overflow line) to respect the frame-height
 *  invariant; the full list is always visible in the PgUp pager. */
function TodoRegion({ store }: { store: TuiStore }) {
  const todos = useStoreField(store, "todos");
  if (todos.length === 0) return null;
  const visible = todos.length > 5 ? todos.slice(0, 4) : todos;
  const hidden = todos.length - visible.length;
  return (
    <Box flexDirection="column">
      {visible.map((t, i) => (
        <TodoRow key={i} item={t} first={i === 0} />
      ))}
      {hidden > 0 ? <Text dimColor>{`     … 还有 ${hidden} 项`}</Text> : null}
    </Box>
  );
}

/**
 * Animated status line while thinking / responding (no active tool). Subscribes
 * to the small slice that decides visibility + label; the StatusLine owns its
 * own per-frame interval for the glyph/shimmer/clock, so the animation itself
 * never touches this subscription.
 */
function StatusLineRegion({ store }: { store: TuiStore }) {
  const { busy, spinner, turnStartedAt, spinnerTokens, toolCount, label } = useStoreSelector(
    store,
    selectStatusLine,
  );
  if (!(busy && toolCount === 0 && spinner !== "idle")) return null;
  return (
    <StatusLine
      label={label}
      startedAt={turnStartedAt}
      tokens={spinnerTokens}
      cycleVerbs={spinner === "thinking"}
    />
  );
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

/** Overlay (when present) or the InputBox. Subscribes to `overlay` + `busy`. */
function InteractionRegion({
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
  const { overlay, busy, inputHistory } = useStoreSelector(store, selectInteraction);
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
      case "commandPicker":
        return <CommandPicker overlay={overlay} />;
      case "confirm":
        return <ConfirmPrompt overlay={overlay} />;
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
      history={inputHistory}
      onHistoryChange={(history) => store.setInputHistory(history)}
    />
  );
}

function selectInteraction(s: StoreState) {
  return { overlay: s.overlay, busy: s.busy, inputHistory: s.inputHistory };
}

function selectHelp(s: StoreState) {
  return { showHelp: s.showHelp, permissionMode: s.permissionMode };
}

function HelpRegion({ store }: { store: TuiStore }) {
  const { showHelp, permissionMode } = useStoreSelector(store, selectHelp);
  const { rows } = useTerminalSize();
  if (!showHelp) return null;
  // Clip the panel so it can never push the live frame past the viewport
  // while a stream is running underneath (frame-height invariant).
  return (
    <Box maxHeight={Math.max(5, rows - 8)} overflowY="hidden" flexDirection="column">
      <HelpPanel currentMode={permissionMode} onClose={() => store.setShowHelp(false)} />
    </Box>
  );
}

/** Bottom status bar. Subscribes to `busy` + token totals + permission mode. */
function StatusBar({ store }: { store: TuiStore }) {
  const { busy, permissionMode, tokensIn, tokensOut } = useStoreSelector(store, selectStatusBar);
  return (
    <Box>
      <Text dimColor>
        {busy ? "working… (Ctrl+C interrupt)" : "? shortcuts · ← agents · / commands · PgUp 回滚"}
        {" · "}
      </Text>
      <Text color={modeColor(permissionMode)} bold>
        {permissionMode}
      </Text>
      <Text dimColor>
        {" · "}
        {tokensIn}↑ {tokensOut}↓ tokens
      </Text>
    </Box>
  );
}

function selectStatusBar(s: StoreState) {
  return {
    busy: s.busy,
    permissionMode: s.permissionMode,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
  };
}

// Global-hotkey resolver: defaults + any user overrides from
// ~/.claude/keybindings.json. Loaded once at startup (not hot-reloaded).
const globalResolver = createResolver(DEFAULT_BINDINGS, loadUserBindings());

function ModeHotkey({ store }: { store: TuiStore }) {
  useInput((input, key) => {
    const result = globalResolver(input, key, ["Global"]);
    if (result.type !== "match") return;
    if (result.action === "transcript:review") {
      // PgUp opens the pager; while reviewing, the pager owns the keyboard
      // (PgUp/PgDn scroll there) so this becomes a no-op.
      if (!store.getSnapshot().reviewing) store.setReviewing(true);
      return;
    }
    // Review mode owns the keyboard: suppress other global hotkeys.
    if (store.getSnapshot().reviewing) return;
    if (result.action === "chat:cycleMode") {
      store.cyclePermissionMode();
    } else if (result.action === "help:toggle" && !store.getSnapshot().overlay) {
      // Show help panel only when not in an overlay (overlays have their own input).
      store.setShowHelp(true);
    }
  });
  return null;
}

/**
 * The regions between Toast and StatusBar. Subscribes to `reviewing` only: when
 * the transcript pager is open it REPLACES the transcript/live/input regions
 * (the InputBox must unmount so its ↑/↓ history keys don't fight the pager).
 */
function ReviewableBody({
  store,
  commands,
  onSubmit,
  expandedId,
  editorMode,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  expandedId: number | null;
  editorMode?: { value: "default" | "vim" };
}) {
  const reviewing = useStoreField(store, "reviewing");
  if (reviewing) return <TranscriptReview store={store} />;
  return (
    <>
      <TranscriptRegion store={store} expandedId={expandedId} />
      <ThinkingRegion store={store} />
      <StreamingRegion store={store} />
      <ActiveToolsRegion store={store} />
      <StatusLineRegion store={store} />
      <TodoRegion store={store} />
      <HelpRegion store={store} />
      <InteractionRegion
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        editorMode={editorMode}
      />
    </>
  );
}

export function App({
  store,
  commands,
  onSubmit,
  expandedId,
  editorMode,
  fullscreen,
}: {
  store: TuiStore;
  commands: CommandInfo[];
  onSubmit: (value: string) => void;
  expandedId: number | null;
  editorMode?: { value: "default" | "vim" };
  /** M25.2: when true, render the alt-screen full-screen layout (input pinned
   *  to the bottom + in-app PgUp/PgDn scrollback) instead of the default
   *  <Static> native-scrollback layout. */
  fullscreen?: boolean;
}) {
  if (fullscreen) {
    // FullScreenApp contains its own FsModeHotkey — no need for ModeHotkey wrapper.
    return (
      <FullScreenApp
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        editorMode={editorMode}
      />
    );
  }
  // The root no longer subscribes to the store at all — each region below owns
  // its own field-sliced subscription, so a mutation only re-renders the region
  // that reads the changed slice (M24.2). The outer column is a stable layout
  // anchor: regions appear/disappear but the vertical order is fixed, so the
  // InputBox keeps a predictable position (M24.5).
  return (
    <Box flexDirection="column">
      <ModeHotkey store={store} />
      <Toast store={store} />
      <ReviewableBody
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        expandedId={expandedId}
        editorMode={editorMode}
      />
      <StatusBar store={store} />
    </Box>
  );
}
