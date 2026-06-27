// ============================================================
// Context Snip — importance-aware compression (12.1)
// ============================================================
// A cheap, lossless-ish pre-pass that runs BEFORE the LLM-summarizing
// autoCompact. Instead of throwing away whole turns, it trims the bulkiest,
// oldest tool results in place — keeping a head + tail excerpt with a clear
// "snipped" marker — while leaving recent turns and all non-tool messages
// untouched. This buys a lot of token headroom without losing the structure
// of the conversation, and often avoids triggering full compaction at all.
//
// Importance heuristic (what we protect):
//   - The most recent `keepRecent` messages — never snipped.
//   - Non-tool messages (user/assistant/system) — never snipped.
//   - Small tool results (under `minSnipChars`) — not worth snipping.
// Everything else (large, old tool results) is trimmed to head + tail.
// ============================================================

import type { Message } from "./types.js";

export interface SnipOptions {
  /** Messages at the tail that are never touched. Default 10. */
  keepRecent?: number;
  /** Only snip tool results at least this many chars. Default 2000. */
  minSnipChars?: number;
  /** Chars to keep from the start of a snipped result. Default 600. */
  headChars?: number;
  /** Chars to keep from the end of a snipped result. Default 400. */
  tailChars?: number;
}

export interface SnipResult {
  messages: Message[];
  /** How many tool results were trimmed. */
  snippedCount: number;
  /** Approx chars removed (sum over trimmed results). */
  charsSaved: number;
}

const DEFAULTS: Required<SnipOptions> = {
  keepRecent: 10,
  minSnipChars: 2000,
  headChars: 600,
  tailChars: 400,
};

/**
 * Trim large, old tool results in place. Pure: returns a new array and never
 * mutates the input messages. Messages other than oversized old tool results
 * are passed through by reference.
 */
export function snipContext(messages: Message[], options: SnipOptions = {}): SnipResult {
  const opts = { ...DEFAULTS, ...options };
  const cutoff = Math.max(0, messages.length - opts.keepRecent);

  let snippedCount = 0;
  let charsSaved = 0;

  const out = messages.map((msg, i) => {
    // Protect recent messages and everything that isn't a tool result.
    if (i >= cutoff || msg.role !== "tool") return msg;

    const content = msg.content;
    if (typeof content !== "string" || content.length < opts.minSnipChars) {
      return msg;
    }
    // Already snipped (idempotent) — skip.
    if (content.includes(SNIP_MARKER)) return msg;

    const head = content.slice(0, opts.headChars);
    const tail = content.slice(content.length - opts.tailChars);
    const removed = content.length - head.length - tail.length;
    if (removed <= 0) return msg;

    snippedCount++;
    charsSaved += removed;

    return {
      ...msg,
      content: `${head}\n${SNIP_MARKER} (${removed} chars from an old "${msg.name ?? "tool"}" result) ${SNIP_MARKER}\n${tail}`,
    };
  });

  return { messages: out, snippedCount, charsSaved };
}

export const SNIP_MARKER = "[…snipped…]";
