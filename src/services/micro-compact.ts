// ============================================================
// Time-Based Micro-Compact
// ============================================================
// Clears old tool result content when the conversation has been idle for a
// configured threshold (default 60 minutes). This reclaims context space
// without summarization, and runs BEFORE autoCompact is triggered.
//
// Design:
// - Triggers on time gap, not token count (orthogonal to autoCompact threshold)
// - Only clears compactable tools (read/bash/grep/glob/web_*/edit/write)
// - Keeps the most recent N results untouched
// - Replaces content with a short cleared marker
// - Idempotent: won't re-clear already-cleared results
//
// Integrates into context-pipeline.ts as Layer 3 (after budget, before autoCompact).
// ============================================================

import type { Message } from "../types.js";
import { getMicroCompactConfig, type MicroCompactConfig } from "./micro-compact-config.js";

/** Marker replacing cleared tool result content. */
export const CLEARED_MESSAGE = "[Old tool result content cleared]";

export interface MicroCompactResult {
  messages: Message[];
  /** How many tool results were cleared this pass. */
  cleared: number;
  /** Estimated tokens saved (rough: content.length / 4). */
  tokensSaved: number;
}

/**
 * Check if the time-based trigger should fire: gap since last assistant
 * message exceeds the configured threshold.
 */
function shouldTrigger(messages: Message[], config: MicroCompactConfig): boolean {
  if (!config.enabled) return false;

  // Find the most recent assistant message with a timestamp (iterate backwards for compat)
  let lastAssistant: Message | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && (m as any).timestamp !== undefined) {
      lastAssistant = m;
      break;
    }
  }

  if (!lastAssistant) return false;

  const timestamp = (lastAssistant as any).timestamp;
  if (!timestamp) return false;

  try {
    const lastTime = new Date(timestamp).getTime();
    if (!Number.isFinite(lastTime)) return false;

    const gapMinutes = (Date.now() - lastTime) / 60_000;
    return gapMinutes >= config.gapThresholdMinutes;
  } catch {
    // Invalid timestamp format
    return false;
  }
}

/**
 * Collect tool_call_ids for all compactable tools, in encounter order.
 * Used to determine which tool results are eligible for clearing.
 */
function collectCompactableToolIds(messages: Message[], compactableTools: Set<string>): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (compactableTools.has(call.function.name)) {
          ids.push(call.id);
        }
      }
    }
  }
  return ids;
}

/**
 * Rough token estimation for saved content (4 chars ≈ 1 token).
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Time-based micro-compact: clear old tool result content when the
 * conversation has been idle beyond the configured threshold.
 *
 * Returns the original messages array (same reference) when no clearing
 * happens, so callers can cheaply detect "no change".
 */
export function microCompact(messages: Message[]): MicroCompactResult {
  const config = getMicroCompactConfig();

  if (!shouldTrigger(messages, config)) {
    return { messages, cleared: 0, tokensSaved: 0 };
  }

  const compactableIds = collectCompactableToolIds(messages, config.compactableTools);

  // Keep the most recent N results (floor at 1 to never clear everything)
  const keepRecent = Math.max(1, config.keepRecent);
  const keepSet = new Set(compactableIds.slice(-keepRecent));
  const clearSet = new Set(compactableIds.filter((id) => !keepSet.has(id)));

  if (clearSet.size === 0) {
    return { messages, cleared: 0, tokensSaved: 0 };
  }

  let tokensSaved = 0;
  const result: Message[] = messages.map((msg) => {
    if (msg.role !== "tool" || !clearSet.has(msg.tool_call_id)) {
      return msg;
    }

    // Already cleared (idempotent) — skip
    if (msg.content === CLEARED_MESSAGE) {
      return msg;
    }

    // Clear content
    tokensSaved += estimateTokens(msg.content);
    return {
      ...msg,
      content: CLEARED_MESSAGE,
    };
  });

  return {
    messages: result,
    cleared: clearSet.size,
    tokensSaved,
  };
}
