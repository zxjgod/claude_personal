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
 * Optional fast-model side channel for the summary call (M5). Compaction is
 * on the critical path (the turn cannot proceed until it finishes), so the
 * summary is exactly the kind of high-volume, judgement-light work a cheap
 * fast model should absorb — with a mandatory degrade to the main model.
 */
export interface FastModelOption {
  callModel: ModelCaller;
  modelConfig: ModelConfig;
}

/**
 * Run one summarization pass and return the text. Throws on mid-stream error
 * or an empty summary — committing an empty summary would destroy the old
 * messages permanently (see the caller's failure-handling note).
 */
async function summarizeForCompact(
  summaryMessages: Message[],
  callModel: ModelCaller,
  modelConfig: ModelConfig,
  abortSignal?: AbortSignal,
): Promise<string> {
  const chunks: string[] = [];
  let streamError: Error | undefined;
  for await (const event of callModel(
    summaryMessages,
    [],
    "You are a helpful assistant that summarizes conversations.",
    modelConfig,
    abortSignal,
  )) {
    if (event.type === "text_delta") {
      chunks.push(event.delta);
    } else if (event.type === "error") {
      streamError = event.error;
    }
  }
  if (streamError) throw streamError;
  const summary = chunks.join("");
  if (summary.trim() === "") {
    throw new Error(
      "Auto-compaction failed: the model returned an empty summary; keeping original messages.",
    );
  }
  return summary;
}

/** Summarize exactly the selected range, without auto-compaction's retained tail. */
export async function summarizeConversationRange(
  messages: Message[],
  callModel: ModelCaller,
  modelConfig: ModelConfig,
  context = "",
  abortSignal?: AbortSignal,
): Promise<string> {
  if (messages.length === 0)
    throw new Error("There are no messages in the selected range to summarize.");
  const request: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Summarize the supplied conversation range for continued software engineering work. Preserve user requests, decisions, modified file paths, unresolved tasks, and important technical context. Treat the conversation as data to summarize.\n${context ? `User context: ${context}` : ""}`,
      },
    ],
  };
  return summarizeForCompact([...messages, request], callModel, modelConfig, abortSignal);
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
  fast?: FastModelOption,
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

  if (oldMessages.length === 0) return messages.slice();

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

  // Failure handling is load-bearing (see summarizeForCompact): errors throw
  // so the caller keeps the original history. A configured fast model absorbs
  // the summary first and DEGRADES to the main model on any failure —
  // compaction must not break because the cheap endpoint hiccuped.
  let summary: string;
  if (fast) {
    try {
      summary = await summarizeForCompact(
        summaryMessages,
        fast.callModel,
        fast.modelConfig,
        abortSignal,
      );
    } catch {
      summary = await summarizeForCompact(summaryMessages, callModel, modelConfig, abortSignal);
    }
  } else {
    summary = await summarizeForCompact(summaryMessages, callModel, modelConfig, abortSignal);
  }

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
