// ============================================================
// App — root Ink component (9.1 / 9.2)
// ============================================================
// Subscribes to the TuiStore via useSyncExternalStore. Completed transcript
// items go in <Static> (printed once, scroll into history, never repainted —
// this is what makes streaming flicker-free). The live region below shows the
// in-progress assistant text + active tool + spinner. An overlay (permission /
// question) takes over input when present; otherwise the InputBox is active.
// ============================================================

import { Box, Static, Text } from "ink";
import { useSyncExternalStore } from "react";
import { renderMarkdown } from "./../markdown.js";
import { actionLabel } from "./../spinner-core.js";
import { EffortPrompt } from "./EffortPrompt.js";
import { type CommandInfo, InputBox } from "./InputBox.js";
import { PermissionPrompt, QuestionPrompt } from "./Prompts.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusLine } from "./StatusLine.js";
import type { StoreState, TranscriptItem, TuiStore } from "./store.js";
import { ActiveToolCard, CompletedToolCard } from "./ToolCard.js";

const ORANGE = "#d77757";

/**
 * Present-continuous status for the live status line (M23.3). While a tool is
 * running we show the concrete action ("Reading App.tsx", "Running npm test");
 * otherwise the phase word ("Thinking" / "Responding").
 */
function statusLabel(state: StoreState): string {
  if (state.activeTools.length === 1) {
    const t = state.activeTools[0]!;
    return actionLabel(t.name, t.detail);
  }
  if (state.activeTools.length > 1) {
    return `Running ${state.activeTools.length} tools`;
  }
  if (state.spinner === "responding") return "Responding";
  return "Thinking";
}

function TranscriptRow({ item, expanded }: { item: TranscriptItem; expanded: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text dimColor>{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box>
          <Text color={ORANGE}>●</Text>
          <Text> {renderMarkdown(item.text)}</Text>
        </Box>
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

export function App({
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
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <Box flexDirection="column">
      {/* Completed history — printed once, never repainted. */}
      <Static items={state.transcript}>
        {(item) => (
          <Box
            key={item.id}
            marginBottom={item.kind === "assistant" || item.kind === "tool" ? 1 : 0}
          >
            <TranscriptRow item={item} expanded={expandedId === item.id} />
          </Box>
        )}
      </Static>

      {/* Live region: streaming assistant text. Rendered as RAW text while it
          streams (M23.7) — markdown is parsed once at commit time (see the
          "assistant" transcript row), so we don't re-lex the whole block on
          every coalesced frame. */}
      {state.streamingText ? (
        <Box marginBottom={1}>
          <Text color={ORANGE}>●</Text>
          <Text> {state.streamingText}</Text>
        </Box>
      ) : null}

      {/* Live region: active tool cards (one per concurrent tool). */}
      {state.activeTools.map((t) => (
        <ActiveToolCard key={t.id} name={t.name} detail={t.detail} />
      ))}

      {/* Animated status line while thinking / responding (no active tool):
          orange glyph + shimmer label + live clock + real token count. */}
      {state.busy && state.activeTools.length === 0 && state.spinner !== "idle" ? (
        <StatusLine
          label={statusLabel(state)}
          startedAt={state.turnStartedAt}
          tokens={state.spinnerTokens}
        />
      ) : null}

      {/* Overlay takes over input when present. */}
      {state.overlay ? (
        state.overlay.kind === "permission" ? (
          <PermissionPrompt overlay={state.overlay} />
        ) : state.overlay.kind === "question" ? (
          <QuestionPrompt overlay={state.overlay} />
        ) : state.overlay.kind === "sessionPicker" ? (
          <SessionPicker overlay={state.overlay} />
        ) : state.overlay.kind === "providerPicker" ? (
          <ProviderPicker overlay={state.overlay} />
        ) : (
          <EffortPrompt overlay={state.overlay} />
        )
      ) : (
        <InputBox
          commands={commands}
          disabled={state.busy}
          onSubmit={onSubmit}
          editorMode={editorMode}
        />
      )}

      {/* Status bar (single line — no duplicate hint above). */}
      <Box>
        <Text dimColor>
          {state.busy
            ? "  working… (Ctrl+C to interrupt)"
            : "  ? for shortcuts · ← for agents · / for commands · @path to attach"}
        </Text>
        <Text dimColor>
          {"   "}
          {state.modelLabel} · {state.tokensIn}↑ {state.tokensOut}↓ tokens
        </Text>
      </Box>
    </Box>
  );
}
