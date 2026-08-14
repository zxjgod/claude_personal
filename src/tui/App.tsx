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
import { CommandPicker } from "./CommandPicker.js";
import { EffortPrompt } from "./EffortPrompt.js";
import { FullScreenApp } from "./FullScreenApp.js";
import { HelpPanel } from "./HelpPanel.js";
import { type CommandInfo, InputBox } from "./InputBox.js";
import { createResolver, DEFAULT_BINDINGS, loadUserBindings } from "./keybindings/index.js";
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
import { modeColor, palette } from "./theme.js";
import { useStoreField, useStoreSelector } from "./useStoreSelector.js";

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
 */
function StreamingRegion({ store }: { store: TuiStore }) {
  const streamingText = useStoreField(store, "streamingText");
  if (!streamingText) return null;
  return (
    <Box marginBottom={1}>
      <AssistantMessage>
        <StreamingMarkdown>{streamingText}</StreamingMarkdown>
      </AssistantMessage>
    </Box>
  );
}

/** Live tool cards (one per concurrent tool). Subscribes to `activeTools`. */
function ActiveToolsRegion({ store }: { store: TuiStore }) {
  const activeTools = useStoreField(store, "activeTools");
  return (
    <>
      {activeTools.map((t) => (
        <ActiveToolCard key={t.id} name={t.name} detail={t.detail} />
      ))}
    </>
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
  if (!showHelp) return null;
  return <HelpPanel currentMode={permissionMode} onClose={() => store.setShowHelp(false)} />;
}

/** Bottom status bar. Subscribes to `busy` + token totals + permission mode. */
function StatusBar({ store }: { store: TuiStore }) {
  const { busy, permissionMode, tokensIn, tokensOut } = useStoreSelector(store, selectStatusBar);
  return (
    <Box>
      <Text dimColor>
        {busy ? "working… (Ctrl+C interrupt)" : "? shortcuts · ← agents · / commands"}
        {" · "}
        <Text color={modeColor(permissionMode)}>{permissionMode}</Text>
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
    if (result.action === "chat:cycleMode") {
      store.cyclePermissionMode();
    } else if (result.action === "help:toggle" && !store.getSnapshot().overlay) {
      // Show help panel only when not in an overlay (overlays have their own input).
      store.setShowHelp(true);
    }
  });
  return null;
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
      <TranscriptRegion store={store} expandedId={expandedId} />
      <StreamingRegion store={store} />
      <ActiveToolsRegion store={store} />
      <StatusLineRegion store={store} />
      <HelpRegion store={store} />
      <InteractionRegion
        store={store}
        commands={commands}
        onSubmit={onSubmit}
        editorMode={editorMode}
      />
      <StatusBar store={store} />
    </Box>
  );
}
