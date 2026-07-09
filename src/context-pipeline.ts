// ============================================================
// Context Pipeline — light-to-heavy compaction (M31, kernel §6)
// ============================================================
// Run before every model call. Each layer is cheaper than the next and may
// reclaim enough headroom that the heavier layers below it never run:
//
//   1. getMessagesAfterCompactBoundary — physically drop pre-boundary history
//   2. applyToolResultBudget           — cap total tool-result bytes (cache-safe)
//   3. microcompact                   — count-based whole-block eviction of old results
//   4. contextCollapse (CollapseStore) — recoverable stash of evicted content
//   5. autoCompact                     — LLM summary + compact_boundary (in agent-loop)
//
// Layers 1–3 are pure, synchronous, and cache-friendly: they never touch recent
// turns and never inspect tool-result *content* (so the prompt-cache prefix
// stays byte-stable for as long as possible). Only autoCompact (layer 5) calls
// the model. Token accounting uses the last reported `usage` plus an estimate of
// what was appended since (see agent-loop), not a full re-tokenize each turn.
// ============================================================

import type { Message } from "./types.js";

/**
 * Marker embedded in the summary system message autoCompact produces. Layer 1
 * finds the LAST message carrying it and discards everything before — so once a
 * summary exists, the pre-summary history is physically gone from the window.
 */
export const COMPACT_BOUNDARY_MARKER = "[CONVERSATION SUMMARY]";

/** Short stub left in place of an evicted tool result (kept tiny, content-free). */
export function evictionStub(toolName: string | undefined, chars: number): string {
  return `[evicted: ${toolName ?? "tool"} result, ${chars} chars — older context trimmed to save space]`;
}

// ============================================================
// Layer 1 — compact boundary
// ============================================================

/**
 * Drop every message before the last compaction boundary. A boundary is a
 * `system` message whose content starts with COMPACT_BOUNDARY_MARKER. Returns
 * the original array (same reference) when no boundary exists, so callers can
 * cheaply detect "nothing changed".
 */
export function getMessagesAfterCompactBoundary(messages: Message[]): Message[] {
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "system" && m.content.startsWith(COMPACT_BOUNDARY_MARKER)) {
      boundary = i;
      break;
    }
  }
  if (boundary <= 0) return messages;
  return messages.slice(boundary);
}

// ============================================================
// Layer 4 — collapse store (recoverable stash)
// ============================================================

/**
 * A recoverable store of content that layers 2/3 trimmed or evicted, keyed by
 * tool_call_id. Lets the original be restored (e.g. /rewind, or a tool the model
 * re-requests). Kept deliberately minimal — the richer projection/folding *view*
 * belongs to the TUI, not the loop.
 */
export class CollapseStore {
  private original = new Map<string, string>();

  /** Stash the original content for an id (first write wins — never overwrite). */
  collapse(toolCallId: string, content: string): void {
    if (!this.original.has(toolCallId)) {
      this.original.set(toolCallId, content);
    }
  }

  /** Recover stashed content, or undefined if nothing was collapsed for this id. */
  restore(toolCallId: string): string | undefined {
    return this.original.get(toolCallId);
  }

  get size(): number {
    return this.original.size;
  }
}

// ============================================================
// Layer 2 — tool-result byte budget
// ============================================================

export interface ToolResultBudgetOptions {
  /** Total char ceiling across ALL tool results. Default 100_000. */
  maxTotalChars?: number;
  /** Most-recent tool results never trimmed by this layer. Default 4. */
  keepRecent?: number;
  /** Chars kept at the head of a trimmed result. Default 600. */
  headChars?: number;
  /** Chars kept at the tail of a trimmed result. Default 400. */
  tailChars?: number;
  /** Optional store: trimmed originals are stashed for recovery. */
  store?: CollapseStore;
}

export interface PipelineLayerResult {
  messages: Message[];
  /** How many tool results this layer touched. */
  changed: number;
  /** Approx chars removed. */
  charsSaved: number;
}

/**
 * Layer 2: keep the SUM of tool-result chars under `maxTotalChars` by
 * head/tail-trimming the OLDEST oversized results first, until either under
 * budget or only `keepRecent` recent results remain. Light and cache-safe — it
 * does not summarize or reorder, just clips bulky old blocks in place.
 */
export function applyToolResultBudget(
  messages: Message[],
  options: ToolResultBudgetOptions = {},
): PipelineLayerResult {
  const maxTotalChars = options.maxTotalChars ?? 100_000;
  const keepRecent = options.keepRecent ?? 4;
  const headChars = options.headChars ?? 600;
  const tailChars = options.tailChars ?? 400;

  // Indices of tool results, oldest first.
  const toolIdx: number[] = [];
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string") {
      toolIdx.push(i);
      total += m.content.length;
    }
  }

  if (total <= maxTotalChars) {
    return { messages, changed: 0, charsSaved: 0 };
  }

  // Protect the most-recent `keepRecent` tool results from this layer.
  const trimmable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  const out = messages.slice();
  let changed = 0;
  let charsSaved = 0;

  for (const i of trimmable) {
    if (total <= maxTotalChars) break;
    const m = out[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const content = m.content;
    if (content.length <= headChars + tailChars) continue; // not worth trimming

    options.store?.collapse(m.tool_call_id, content);
    const head = content.slice(0, headChars);
    const tail = content.slice(content.length - tailChars);
    const removed = content.length - head.length - tail.length;
    const trimmed = `${head}\n[... ${removed} chars trimmed to fit context budget ...]\n${tail}`;
    out[i] = { ...m, content: trimmed };
    total -= content.length - trimmed.length;
    charsSaved += content.length - trimmed.length;
    changed++;
  }

  return { messages: changed > 0 ? out : messages, changed, charsSaved };
}

// ============================================================
// Layer 3 — microcompact (evict whole old tool-result blocks)
// ============================================================

export interface MicrocompactOptions {
  /** Most-recent tool results to keep intact. Default 8. */
  keepRecentToolResults?: number;
  /** Only evict a result if it is at least this many chars. Default 1000. */
  minEvictChars?: number;
  /** Optional store: evicted originals are stashed for recovery. */
  store?: CollapseStore;
}

/**
 * Layer 3: replace the CONTENT of old tool-result blocks with a tiny stub,
 * keeping the message (and its tool_call_id pairing) so the API invariant holds.
 * Unlike layer 2 it does not keep a head/tail excerpt — it drops the whole body.
 * Never inspects content, so it is cache-safe and cheap. Keeps the most recent
 * `keepRecentToolResults` results untouched.
 */
export function microcompact(
  messages: Message[],
  options: MicrocompactOptions = {},
): PipelineLayerResult {
  const keepRecent = options.keepRecentToolResults ?? 8;
  const minEvictChars = options.minEvictChars ?? 1000;

  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIdx.push(i);
  }
  const evictable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  if (evictable.length === 0) return { messages, changed: 0, charsSaved: 0 };

  const out = messages.slice();
  let changed = 0;
  let charsSaved = 0;
  for (const i of evictable) {
    const m = out[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const stub = evictionStub(m.name, m.content.length);
    // Already evicted (idempotent) or too small to bother.
    if (m.content.startsWith("[evicted:") || m.content.length < minEvictChars) continue;
    options.store?.collapse(m.tool_call_id, m.content);
    charsSaved += m.content.length - stub.length;
    out[i] = { ...m, content: stub };
    changed++;
  }

  return { messages: changed > 0 ? out : messages, changed, charsSaved };
}

// ============================================================
// Orchestrator — run the cheap layers, then decide on the heavy one
// ============================================================

export interface PreparedContext {
  /** Messages after the cheap layers (1–3) ran. */
  messages: Message[];
  /** Human-readable summaries of layers that reclaimed space (for `compacted` events). */
  notes: string[];
  /** True when, after the cheap layers, the context is still over the soft threshold. */
  needsAutoCompact: boolean;
}

export interface PrepareCheapLayersOptions {
  /** estimate tokens of a message array (injected so the loop owns the heuristic). */
  estimateTokens: (messages: Message[]) => number;
  /** Soft threshold (tokens) above which autoCompact (layer 5) should run. */
  threshold: number;
  /** Optional collapse store threaded into layers 2/3 for recoverability. */
  store?: CollapseStore;
  /** Override layer-2 budget options. */
  budget?: ToolResultBudgetOptions;
  /** Override layer-3 microcompact options. */
  micro?: MicrocompactOptions;
}

/**
 * Run the cheap, synchronous, cache-friendly layers (1→3) in order and report
 * whether the heavy LLM summarization (layer 5) is still needed. Layer ordering
 * matters: boundary-drop first (may make budgeting unnecessary), then byte
 * budget (light trim), then microcompact (whole-block eviction). Each only runs
 * far enough to get under threshold isn't attempted here — the cheap layers are
 * always safe to run fully; the expensive decision is just "is autoCompact still
 * required after all of them".
 */
export function prepareCheapLayers(
  messages: Message[],
  opts: PrepareCheapLayersOptions,
): PreparedContext {
  const notes: string[] = [];
  let msgs = messages;

  // Layer 1: drop pre-boundary history.
  const afterBoundary = getMessagesAfterCompactBoundary(msgs);
  if (afterBoundary !== msgs) {
    const dropped = msgs.length - afterBoundary.length;
    msgs = afterBoundary;
    notes.push(`Dropped ${dropped} message(s) before the last compaction boundary`);
  }

  // Only bother with the trimming layers if we're over threshold — under it,
  // keep the prompt byte-stable for the cache.
  if (opts.estimateTokens(msgs) > opts.threshold) {
    // Layer 2: byte budget.
    const budgeted = applyToolResultBudget(msgs, { store: opts.store, ...opts.budget });
    if (budgeted.changed > 0) {
      msgs = budgeted.messages;
      notes.push(
        `Trimmed ${budgeted.changed} old tool result(s) (~${Math.ceil(budgeted.charsSaved / 4)} tokens)`,
      );
    }

    // Layer 3: count-based microcompact (evict whole old tool-result blocks).
    const countBased = microcompact(msgs);
    if (countBased.changed > 0) {
      msgs = countBased.messages;
      notes.push(
        `Count-based microcompact evicted ${countBased.changed} old tool result(s) (~${Math.ceil(countBased.charsSaved / 4)} tokens)`,
      );
    }
    if (opts.estimateTokens(msgs) > opts.threshold) {
      const micro = microcompact(msgs, { store: opts.store, ...opts.micro });
      if (micro.changed > 0) {
        msgs = micro.messages;
        notes.push(
          `Evicted ${micro.changed} old tool result(s) (~${Math.ceil(micro.charsSaved / 4)} tokens)`,
        );
      }
    }
  }

  return {
    messages: msgs,
    notes,
    needsAutoCompact: opts.estimateTokens(msgs) > opts.threshold,
  };
}
