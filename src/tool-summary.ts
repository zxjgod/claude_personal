// ============================================================
// Tool-Result Summary — hide latency in the model stream (M36, kernel §9)
// ============================================================
// Kernel §9 lists three things kicked off during the model's 5–30s streaming
// window so the NEXT turn is cheaper without paying latency: memory prefetch,
// skill discovery (both in prefetch.ts), and — this module — a FAST-MODEL
// summary of the PREVIOUS tool batch (the kernel uses Haiku, ~1s).
//
// The idea: after a batch of tools runs, their raw output sits in the history,
// often large (a grep dump, a file read). While the model streams its next
// turn, a cheap fast model condenses that batch into a few lines. The summary
// is then injected as a `<system-reminder>` so the model has an at-a-glance
// digest alongside (not instead of) the full results.
//
// Design, matching prefetch.ts:
//   - This module is PURE + provider-injected. It never imports the LLM adapter
//     or fs; the loop passes a `summarize` callback (the fast-model call). That
//     keeps it fully testable with a fake summarizer.
//   - Fire-and-poll: the loop starts the summary after a tool batch, then
//     consumes it NON-BLOCKINGLY at the next turn boundary. If it isn't ready,
//     the loop moves on — latency hiding must never add latency.
//   - A size threshold gates it: tiny batches aren't worth a model round-trip.
// ============================================================

import type { ToolExecutionResult } from "./types.js";

/** One tool's contribution to the batch digest (what the summarizer sees). */
export interface ToolDigestEntry {
  toolName: string;
  /** True when the tool failed (kernel marks these for the model). */
  isError: boolean;
  /** Byte size of the model-facing output — the cost the summary offsets. */
  bytes: number;
  /** Leading slice of the output, so the summarizer has something to compress. */
  snippet: string;
}

export interface ToolBatchDigest {
  entries: ToolDigestEntry[];
  /** Total model-facing bytes across the batch. */
  totalBytes: number;
}

/** Default: only summarize a batch whose combined output exceeds this (bytes). */
export const DEFAULT_SUMMARY_MIN_BYTES = 2000;
/** Cap each entry's snippet so the summary prompt itself stays small. */
export const SUMMARY_SNIPPET_CHARS = 600;

/** Model-facing text for a result (mirrors the loop's modelContent ?? formatted). */
function modelText(r: ToolExecutionResult): string {
  return r.modelContent ?? r.formatted ?? "";
}

/**
 * Build a compact digest of a finished tool batch. Pure — no I/O. Snippets are
 * truncated so the summary prompt can't itself blow up the context.
 */
export function buildToolBatchDigest(results: ToolExecutionResult[]): ToolBatchDigest {
  const entries: ToolDigestEntry[] = [];
  let totalBytes = 0;
  for (const r of results) {
    const text = modelText(r);
    const bytes = Buffer.byteLength(text, "utf8");
    totalBytes += bytes;
    entries.push({
      toolName: r.toolName,
      isError: !!r.isError,
      bytes,
      snippet:
        text.length > SUMMARY_SNIPPET_CHARS ? `${text.slice(0, SUMMARY_SNIPPET_CHARS)}…` : text,
    });
  }
  return { entries, totalBytes };
}

/**
 * Whether a batch is worth summarizing. Small batches (a single short result)
 * aren't worth a model round-trip — the raw output is already cheap to read.
 */
export function shouldSummarizeBatch(
  digest: ToolBatchDigest,
  minBytes: number = DEFAULT_SUMMARY_MIN_BYTES,
): boolean {
  return digest.entries.length > 0 && digest.totalBytes >= minBytes;
}

/**
 * Build the fast-model prompt that condenses a batch digest into a few lines.
 * Kept terse: the fast model is cheap but we still pay per token, and the goal
 * is a glanceable digest, not a second analysis.
 */
export function buildSummaryPrompt(digest: ToolBatchDigest): string {
  const lines: string[] = [
    "Summarize the results of these tool calls in 1–3 short lines.",
    "State what was found or done and any errors. Do not restate the raw output.",
    "",
  ];
  for (const e of digest.entries) {
    const tag = e.isError ? "ERROR" : "ok";
    lines.push(`### ${e.toolName} (${tag}, ${e.bytes}B)`);
    lines.push(e.snippet || "(empty)");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Wrap a finished summary as the single <system-reminder> attachment the loop
 * injects. Returns null for an empty summary so the loop injects nothing.
 */
export function renderSummaryAttachment(summary: string | null): string | null {
  const text = summary?.trim();
  if (!text) return null;
  return [
    "<system-reminder>",
    "Digest of the previous tool batch (background context — the full results",
    "remain above; this is a glanceable summary, not a replacement):",
    text,
    "</system-reminder>",
  ].join("\n");
}

/** The fast-model call the loop injects. Returns the summary text, or null. */
export type ToolBatchSummarizer = (prompt: string) => Promise<string | null>;

export interface ToolSummarySources {
  results: ToolExecutionResult[];
  summarize: ToolBatchSummarizer;
  /** Override the size gate (bytes). */
  minBytes?: number;
}

/**
 * Fire-and-poll a fast-model summary of a finished tool batch (kernel §9).
 * Returns null IMMEDIATELY (no summary needed) when the batch is below the size
 * gate; otherwise returns a Promise that resolves to the rendered attachment
 * (or null if the summarizer yields nothing / throws). The loop starts this
 * during a stream and consumes it non-blockingly next turn — a rejecting or
 * slow summarizer never blocks or breaks the loop.
 */
export function startToolSummary(sources: ToolSummarySources): Promise<string | null> | null {
  const digest = buildToolBatchDigest(sources.results);
  if (!shouldSummarizeBatch(digest, sources.minBytes)) return null;
  const prompt = buildSummaryPrompt(digest);
  return Promise.resolve()
    .then(() => sources.summarize(prompt))
    .then((summary) => renderSummaryAttachment(summary))
    .catch(() => null);
}
