// ============================================================
// Speculation — predictive tool prefetch (12.2)
// ============================================================
// After a search-like tool (grep/glob) returns file paths, the model very
// often follows up by Read-ing one or more of those files. We speculatively
// run those Reads in the background while the model is still generating its
// next turn, and cache the results. When the model then actually issues a
// matching Read, the agent loop serves it from cache — turning a cold tool
// round-trip into an instant hit.
//
// Safety: only read-only, concurrency-safe tools are ever speculated, and a
// cache entry is consumed at most once. A miss costs nothing (the real tool
// just runs normally). Speculation is OFF unless the caller enables it.
// ============================================================

import type { Tool, ToolContext, ToolResult } from "./types.js";

export interface SpeculationOptions {
  /** Max number of files to speculatively read per search result. Default 5. */
  maxPrefetch?: number;
}

/** A predicted tool call: which tool, what input. */
export interface PredictedCall {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Predict likely follow-up Read calls from a just-finished tool result.
 * Currently: grep/glob → Read each distinct file path found (capped).
 * Returns [] when nothing sensible can be predicted.
 */
export function predictReads(
  toolName: string,
  result: ToolResult,
  options: SpeculationOptions = {},
): PredictedCall[] {
  const max = options.maxPrefetch ?? 5;
  const name = toolName.toLowerCase();
  if (name !== "grep" && name !== "glob") return [];
  if (result.error || !result.content) return [];

  const paths = extractPaths(name, result.content);
  const seen = new Set<string>();
  const out: PredictedCall[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ toolName: "read", input: { filePath: p } });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Pull file paths out of a grep/glob result body. Glob emits one path per
 * line; grep emits "path:line:match" (ripgrep) or "path:match". We take the
 * portion before the first ":" on grep lines, the whole line for glob.
 */
function extractPaths(toolName: string, content: string): string[] {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const paths: string[] = [];
  for (const line of lines) {
    // Skip obvious non-path lines (headers, "No files found", counts).
    if (line.startsWith("[") || line.toLowerCase().startsWith("no ")) continue;
    if (toolName === "glob") {
      paths.push(line);
    } else {
      // grep: "relative/path.ts:42:  matched text"
      const m = line.match(/^([^:]+):\d+:/) || line.match(/^([^:]+):/);
      if (m) paths.push(m[1]);
    }
  }
  return paths;
}

/** Stable cache key for a tool + input pair. */
export function specKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName.toLowerCase()}::${JSON.stringify(input, Object.keys(input).sort())}`;
}

/**
 * A small, single-use cache of speculatively executed tool results, keyed by
 * tool+input. Lives for one agent-loop run. Tracks hit/miss counts for
 * observability.
 */
export class SpeculationCache {
  private readonly enabled: boolean;
  private readonly pending = new Map<string, Promise<ToolResult>>();
  hits = 0;
  misses = 0;
  prefetched = 0;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Kick off prefetches for a batch of predicted calls. The matching tools are
   * looked up from `tools`; only read-only + concurrency-safe ones run. Errors
   * are swallowed into a normal error ToolResult (a bad guess never throws).
   */
  prefetch(
    predictions: PredictedCall[],
    tools: Tool[],
    context: ToolContext,
  ): void {
    if (!this.enabled) return;
    for (const pred of predictions) {
      const key = specKey(pred.toolName, pred.input);
      if (this.pending.has(key)) continue;
      const tool = tools.find((t) => t.name === pred.toolName);
      if (!tool || !tool.isReadOnly() || !tool.isConcurrencySafe()) continue;
      this.prefetched++;
      const p = Promise.resolve()
        .then(() => tool.call(pred.input, context))
        .catch((e) => ({
          content: "",
          error: e instanceof Error ? e.message : String(e),
        }) as ToolResult);
      this.pending.set(key, p);
    }
  }

  /**
   * Consume a cached result for a tool+input if one was speculated. Returns
   * the ToolResult (awaiting the in-flight prefetch) or null on a miss. Each
   * key is served at most once.
   */
  async take(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult | null> {
    if (!this.enabled) return null;
    const key = specKey(toolName, input);
    const p = this.pending.get(key);
    if (!p) {
      this.misses++;
      return null;
    }
    this.pending.delete(key);
    this.hits++;
    return await p;
  }
}
