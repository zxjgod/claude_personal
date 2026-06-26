// ============================================================
// Speculation — predictive tool prefetch (12.2 / M15.2)
// ============================================================
// After a search-like tool (grep/glob) returns file paths, the model very
// often follows up by Read-ing one or more of those files. We speculatively
// run those Reads in the background while the model is still generating its
// next turn, and cache the results. When the model then actually issues a
// matching Read, the agent loop serves it from cache — turning a cold tool
// round-trip into an instant hit.
//
// M15.2 refinements:
//   - Rank predicted files (grep: by match multiplicity; glob: by order)
//     instead of a flat first-N, so the most-likely follow-up is prefetched.
//   - Scale the prefetch cap DOWN as the candidate set grows: many files ⟹
//     low per-file hit probability ⟹ prefetch fewer, best-first.
//   - Skip files already Read this session (the model won't re-Read them).
//   - Surface hit/miss/prefetch stats so the cost/benefit is observable.
//
// Safety: only read-only, concurrency-safe tools are ever speculated, and a
// cache entry is consumed at most once. A miss costs nothing (the real tool
// just runs normally). Speculation is ON by default (M15.2); disable with
// --no-speculation / CCR_SPECULATION=0.
// ============================================================

import type { Tool, ToolContext, ToolResult } from "./types.js";

export interface SpeculationOptions {
  /** Base cap on files speculatively read per search result. Default 5. */
  maxPrefetch?: number;
}

/** A predicted tool call: which tool, what input. */
export interface PredictedCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** A ranked candidate path with its score (higher = more likely follow-up). */
export interface RankedPath {
  path: string;
  score: number;
}

/** Speculation cost/benefit snapshot for the `done` event (M15.2). */
export interface SpeculationStats {
  /** Prefetched calls actually consumed by the model. */
  hits: number;
  /** Real tool calls that found no speculative entry. */
  misses: number;
  /** Total background prefetches issued. */
  prefetched: number;
  /** Prefetched-but-never-consumed: wasted background Reads. */
  wasted: number;
  /** hits / prefetched, 0 when nothing prefetched. */
  hitRate: number;
}

/**
 * Rank candidate file paths by likelihood of being the model's next Read.
 *
 * - grep: a file that appears on multiple result lines is more likely the
 *   focus of investigation than one with a single hit. Score = distinct line
 *   occurrences; ties broken by first-seen order (ripgrep returns lines in
 *   file/relevance order, so earlier = more salient).
 * - glob: one path per line, no multiplicity signal; preserve input order
 *   (score = -index, so the first listed wins).
 *
 * Pure and order-preserving on ties — directly unit-testable.
 */
export function rankPaths(toolName: string, paths: string[]): RankedPath[] {
  const name = toolName.toLowerCase();
  if (name === "glob") {
    // No multiplicity signal; first-listed is most likely. Negative index so
    // sorting descending keeps the earliest first.
    return paths.map((path, index) => ({ path, score: -index }));
  }
  // grep (and default): tally occurrences per path, preserve first-seen order.
  const firstSeen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const p of paths) {
    if (!firstSeen.has(p)) firstSeen.set(p, firstSeen.size);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...firstSeen.entries()]
    .map(([path, seen]) => ({ path, score: counts.get(path) ?? 1 }))
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : (firstSeen.get(a.path) ?? 0) - (firstSeen.get(b.path) ?? 0),
    );
}

/**
 * Scale the prefetch cap down as the candidate set grows. With many candidate
 * files the model almost always narrows to one or two, so prefetching the full
 * baseMax wastes I/O and cache slots. The single top-ranked file is always
 * cheap and worth prefetching, so the floor is 1 for any non-empty set.
 *
 *   count = 0  → 0  (nothing to prefetch)
 *   count = 1  → 1
 *   count = 5  → round(5*6/10) = 3
 *   count = 20 → round(5*6/25) = 1
 *   count ≥ baseMax*6-5 → 1
 *
 * Never exceeds baseMax; never below 1 when count ≥ 1.
 */
export function effectiveCap(distinctFileCount: number, baseMax: number): number {
  if (distinctFileCount <= 0) return 0;
  if (baseMax <= 0) return 0;
  const raw = Math.round((baseMax * 6) / (distinctFileCount + 5));
  return Math.min(baseMax, Math.max(1, raw));
}

/**
 * Predict likely follow-up Read calls from a just-finished tool result.
 * Currently: grep/glob → Read each distinct file path found, ranked best-first
 * and capped by `effectiveCap`. Paths already read this session (alreadyRead)
 * are dropped before ranking, since the model won't re-Read them.
 * Returns [] when nothing sensible can be predicted.
 */
export function predictReads(
  toolName: string,
  result: ToolResult,
  options: SpeculationOptions = {},
  alreadyRead?: ReadonlySet<string>,
): PredictedCall[] {
  const baseMax = options.maxPrefetch ?? 5;
  const name = toolName.toLowerCase();
  if (name !== "grep" && name !== "glob") return [];
  if (result.error || !result.content) return [];

  const all = extractPaths(name, result.content);
  const ranked = rankPaths(name, all);
  const filtered = alreadyRead
    ? ranked.filter((r) => !alreadyRead.has(r.path))
    : ranked;
  const cap = effectiveCap(filtered.length, baseMax);
  return filtered
    .slice(0, cap)
    .map((r) => ({ toolName: "read", input: { filePath: r.path } }));
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
 * Format speculation stats as a single dim line for the transcript (M15.2).
 * Pure so the CLI and TUI share one tested formatter. Returns "" when nothing
 * was prefetched (nothing to report).
 */
export function formatSpeculationLine(stats: SpeculationStats): string {
  if (stats.prefetched <= 0) return "";
  const pct = Math.round(stats.hitRate * 100);
  return `[speculation: ${stats.hits}/${stats.prefetched} hits (${pct}%), ${stats.wasted} wasted]`;
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

  /** Cost/benefit snapshot for the `done` event (M15.2). */
  getStats(): SpeculationStats {
    const wasted = Math.max(0, this.prefetched - this.hits);
    return {
      hits: this.hits,
      misses: this.misses,
      prefetched: this.prefetched,
      wasted,
      hitRate: this.prefetched > 0 ? this.hits / this.prefetched : 0,
    };
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
