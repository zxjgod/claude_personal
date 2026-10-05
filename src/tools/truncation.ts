// ============================================================
// Tool Result Spill — bound model-facing result size (M30)
// ============================================================
// Replaces per-tool hard truncation (e.g. Bash's old 30k char cut) with a
// uniform "spill to disk" pass. When a tool's model-facing text exceeds its
// `maxResultSizeChars`, the FULL text is written to a workspace file and the
// model receives a preview (head + tail) plus the path — which it can `Read`
// to recover the rest. The UI still renders the full `formatted` result; only
// the model's history copy is bounded, keeping the context window small while
// losing nothing.
//
// Design notes:
//   - The spill file lives under `.ccr/tool-results/` INSIDE the workspace so
//     the model's read tool (workspace-confined) can open it. `.ccr/` is
//     dot-prefixed, so Glob (dot:false) and ripgrep (hidden-skip) ignore it,
//     and it is gitignored.
//   - Read sets maxResultSizeChars = Infinity, so a Read result never spills —
//     otherwise "Read → spill → Read the spill" would loop forever.
//   - Write failures NEVER throw or lose the turn: we fall back to an in-memory
//     head+tail truncation so the model still gets a bounded, usable result.
//   - CRITICAL FIX (P0-1): truncation now happens at API call time, NOT in
//     STEP 6. The message history and session snapshot always store the FULL
//     result. This ensures resume after a spill correctly restores the full
//     tool output for the next model call.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Default cap on model-facing result chars. Matches the old Bash hard-truncate
 * threshold so behavior is familiar; tools opt out (Read) or tighten as needed.
 */
export const DEFAULT_MAX_RESULT_CHARS = 30_000;

/** Max chars kept from the start of an oversized result in the preview. */
const HEAD_CHARS = 12_000;
/** Max chars kept from the end of an oversized result in the preview. */
const TAIL_CHARS = 4_000;

/** Workspace-relative directory where spilled results are written. */
export const SPILL_DIR = path.join(".ccr", "tool-results");

export interface SpillOptions {
  /** Per-tool cap; results longer than this spill. Defaults to DEFAULT_MAX_RESULT_CHARS. */
  maxChars?: number;
  /** Tool name — used in the spill filename and the model-facing notice. */
  toolName: string;
  /** Absolute workspace root; the spill file is written under it. */
  workspaceRoot: string;
  /** Session id — namespaces spill files so concurrent sessions don't collide. */
  sessionId: string;
}

/**
 * Build a head+tail preview joined by an elision marker noting the spill target.
 * Head/tail lengths are capped by both the fixed limits and the budget (~60% /
 * ~20% of it) so the preview is always meaningfully shorter than both the
 * budget and the original — never longer, even for a result only slightly over
 * a small cap.
 */
function preview(content: string, budget: number, note: string): string {
  const headLen = Math.min(HEAD_CHARS, Math.max(1, Math.floor(budget * 0.6)));
  const tailLen = Math.min(TAIL_CHARS, Math.max(1, Math.floor(budget * 0.2)));
  const head = content.slice(0, headLen);
  const tail = content.slice(content.length - tailLen);
  return `${head}\n\n[... result truncated — ${note} ...]\n\n${tail}`;
}

/**
 * P0-1 Fix: Truncate a tool result text for the API call, returning a
 * preview if it exceeds maxChars. This is called at API-call time (in the
 * adapters), NOT when storing results in message history.
 *
 * Unlike spillIfLarge, this never writes to disk — it is a pure in-memory
 * truncation. The full `formatted` text is returned when under budget.
 *
 * Used by: llm-adapter.ts, anthropic-adapter.ts (truncate tool result content
 * in the messages array before sending to the LLM API).
 */
export function truncateToolResult(
  content: string,
  maxChars: number,
): { truncated: false } | { truncated: true; preview: string; originalLength: number } {
  if (content.length <= maxChars) {
    return { truncated: false };
  }
  return {
    truncated: true,
    preview: preview(
      content,
      maxChars,
      `result too long (${content.length} chars), shown head + tail only`,
    ),
    originalLength: content.length,
  };
}

/**
 * Return the model-facing text for a tool result, spilling to disk when it
 * exceeds `maxChars`. Pure passthrough when under budget or when maxChars is
 * Infinity. Never throws: on a write error it degrades to an in-memory
 * head+tail truncation.
 *
 * NOTE: This function is kept for backward compatibility with any external
 * callers that still want a spill-to-disk path. For the agent loop's message
 * history, see the note in the file header — the loop now stores the FULL
 * result and the adapters call truncateToolResult() at API time instead.
 */
export function spillIfLarge(formatted: string, opts: SpillOptions): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_RESULT_CHARS;
  if (formatted.length <= maxChars) {
    return formatted;
  }

  const totalChars = formatted.length;
  try {
    const dir = path.join(opts.workspaceRoot, SPILL_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = opts.toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    // sessionId comes from --session-id (caller-controlled CLI input) and is
    // not validated upstream — sanitize it like toolName so a traversal value
    // ("../../escape") cannot spill outside the tool-results directory.
    const safeSession = opts.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = path.join(dir, `${safeSession}-${safeName}-${stamp}.txt`);
    fs.writeFileSync(filePath, formatted, "utf-8");
    return preview(
      formatted,
      maxChars,
      `full ${totalChars}-char result written to ${filePath}; use the read tool on that path to view it in full`,
    );
  } catch {
    // Disk spill failed (read-only fs, blocked path, quota…). Degrade to an
    // in-memory truncation so the model still gets a bounded, usable result
    // rather than losing the turn.
    return preview(
      formatted,
      maxChars,
      `result too long (${totalChars} chars), shown head + tail only`,
    );
  }
}
