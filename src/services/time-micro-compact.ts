// ============================================================
// Time-Based Micro-Compact (F5 wiring)
// ============================================================
// Clears old tool-result content when the conversation has been idle beyond
// a configured threshold (default 60 minutes). Orthogonal to the context
// pipeline's COUNT-based microcompact (context-pipeline.ts Layer 3): this one
// fires on WALL-CLOCK idleness, at session load — a resumed stale session
// starts cheaper without any in-loop cost.
//
// Trigger input priority:
//   1. explicit lastActivityMs (the caller passes the session's updatedAt —
//      production messages carry no reliable timestamp field)
//   2. a `timestamp` field stamped on the last assistant message (kept for
//      compatibility with older callers/tests)
//
// Config: getMicroCompactConfig() (env: CCR_MICROCOMPACT_ENABLED,
// CCR_MICROCOMPACT_GAP_MINUTES, CCR_MICROCOMPACT_KEEP_RECENT).
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
 * Sessions may stamp messages with a capture time; the field lives outside the
 * core Message wire type, so reads go through this structural extension.
 */
type TimestampedMessage = Message & { timestamp?: number | string };

/**
 * Check if the time-based trigger should fire. An explicit `lastActivityMs`
 * (epoch) overrides per-message timestamps — the wiring at session load
 * passes the session's updatedAt, which is always present.
 */
function shouldTrigger(
  messages: Message[],
  lastActivityMs: number | undefined,
  config: MicroCompactConfig,
): boolean {
  if (!config.enabled) return false;

  let lastTime: number | undefined;
  if (typeof lastActivityMs === "number" && Number.isFinite(lastActivityMs)) {
    lastTime = lastActivityMs;
  } else {
    // Fall back to the most recent assistant message carrying a timestamp.
    let lastAssistant: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && (m as TimestampedMessage).timestamp !== undefined) {
        lastAssistant = m;
        break;
      }
    }
    if (!lastAssistant) return false;
    try {
      lastTime = new Date(
        (lastAssistant as TimestampedMessage).timestamp as number | string,
      ).getTime();
    } catch {
      return false;
    }
  }
  if (!lastTime || !Number.isFinite(lastTime)) return false;

  const gapMinutes = (Date.now() - lastTime) / 60_000;
  return gapMinutes >= config.gapThresholdMinutes;
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
 * Time-based micro-compact: clear old tool-result content when the
 * conversation has been idle beyond the configured threshold.
 *
 * Returns the original messages array (same reference) when no clearing
 * happens, so callers can cheaply detect "no change".
 */
export function microCompactByTime(
  messages: Message[],
  lastActivityMs?: number,
): MicroCompactResult {
  const config = getMicroCompactConfig();

  if (!shouldTrigger(messages, lastActivityMs, config)) {
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
