// ============================================================
// Auto-Compaction — LLM-based context summarization (M31)
// ============================================================
// Provides context compression when the conversation exceeds the token threshold.
// Uses the model to summarize old messages, preserving recent context.
// ============================================================

import { COMPACT_BOUNDARY_MARKER } from "./context-pipeline.js";
import type { Message, ModelCaller, ModelConfig } from "./types.js";

/**
 * Find a safe split index in messages that avoids splitting mid-conversation.
 * Used by auto-compaction to preserve recent conversation context.
 */
export function findSafeSplitIndex(messages: Message[], tailSize: number): number {
  // Keep at least tailSize messages, but never split in the middle of a
  // tool-result → tool-call pair. Walk backwards from the tail and stop at
  // the first assistant turn that has no unpaired tool result.
  let split = Math.max(0, messages.length - tailSize);
  while (split > 0) {
    const prev = messages[split - 1];
    if (prev?.role === "assistant") {
      // Check if this assistant message has tool results that would be orphaned
      const hasOrphanedToolResult = messages[split]?.role === "tool";
      if (!hasOrphanedToolResult) break;
    }
    split--;
  }
  return split;
}

/**
 * The text of the most recent user message — the query the background
 * prefetch ranks memories/skills against. Concatenates the message's text
 * blocks; returns "" when there is no user message or it carries only images.
 */
export function latestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      return m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}

/**
 * Summarize old messages and rebuild the context window.
 * The summary is tagged with COMPACT_BOUNDARY_MARKER so the pipeline's
 * layer 1 (getMessagesAfterCompactBoundary) can physically drop everything
 * before it on subsequent turns.
 */
export async function autoCompact(
  messages: Message[],
  callModel: ModelCaller,
  modelConfig: ModelConfig,
  abortSignal?: AbortSignal,
): Promise<Message[]> {
  const TAIL_SIZE = 20;
  // Find a safe split point. Slicing at a fixed offset can leave the tail
  // starting with an orphan tool result whose assistant (with tool_calls)
  // landed in oldMessages — the provider rejects that ("tool message must
  // follow tool_calls"). Move the boundary earlier until the tail no longer
  // begins with a tool message.
  const splitIndex = findSafeSplitIndex(messages, TAIL_SIZE);

  const oldMessages = messages.slice(0, splitIndex);
  const tailMessages = messages.slice(splitIndex);

  if (oldMessages.length === 0) return messages;

  // Summarize old messages
  const summaryPrompt = `Summarize the conversation so far. Include:
1. What the user asked for (the main task)
2. Key decisions made
3. Files that were modified (with paths)
4. What still needs to be done
5. Any important context for continuing the work

Be concise but complete. This summary will replace the old messages
so the conversation can continue with a fresh context window.`;

  const summaryMessages: Message[] = [
    ...oldMessages,
    { role: "user", content: [{ type: "text", text: summaryPrompt }] },
  ];

  // Call model without tools for summarization
  const chunks: string[] = [];
  for await (const event of callModel(
    summaryMessages,
    [],
    "You are a helpful assistant that summarizes conversations.",
    modelConfig,
    abortSignal,
  )) {
    if (event.type === "text_delta") {
      chunks.push(event.delta);
    }
  }
  const summary = chunks.join("");

  // Rebuild: system summary + tail. The summary is tagged with
  // COMPACT_BOUNDARY_MARKER so the pipeline's layer 1
  // (getMessagesAfterCompactBoundary) can physically drop everything before it
  // on subsequent turns.
  return [
    {
      role: "system",
      content: `${COMPACT_BOUNDARY_MARKER}\n${summary}`,
    },
    ...tailMessages,
  ];
}
