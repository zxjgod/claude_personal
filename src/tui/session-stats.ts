// ============================================================
// Session Stats — cumulative token usage + best-effort cost
// ============================================================
// The agent loop emits per-call "usage" events. The CLI accumulates them
// here so /cost, /status, and /context can report session-wide totals that
// survive across turns (the per-turn counters in cli.ts reset each prompt).
//
// Cost is best-effort: pricing lives in the shared model-metadata table
// (single source of truth — the old local PRICING and CONTEXT_WINDOWS tables
// here were two of the three partial copies that drifted, e.g. Opus 4.6+
// priced at legacy $15/$75 and windowed at 200k instead of 1M). Unknown
// models report tokens only (cost = null) rather than guessing.
// ============================================================

import { type ModelPricing, modelContextWindow, modelPricing } from "../model-metadata.js";
import { providerPromptTokens } from "../token-estimator.js";

// Re-exported for existing importers of the old local interface.
export type { ModelPricing };

/** Look up pricing for a model id, or null if unknown. */
export function lookupPricing(model: string): ModelPricing | null {
  return modelPricing(model);
}

/** Look up the context-window size for a model id, or null if unknown. */
export function lookupContextWindow(model: string): number | null {
  return modelContextWindow(model);
}

/**
 * Estimate cost in USD for a token count under a model's pricing.
 * Returns null when the model isn't in the table.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = lookupPricing(model);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export class SessionStats {
  /** Provider-normalized prompt tokens: OpenAI input as-is, Anthropic plus cache. */
  private promptTokens = 0;
  /** Token counts pinned to the model that actually served each API call. */
  private costBuckets = new Map<string | null, { inputTokens: number; outputTokens: number }>();

  inputTokens = 0;
  outputTokens = 0;
  /** Number of LLM round-trips (API calls that reported usage). */
  apiCalls = 0;
  /** Number of tool executions observed this session. */
  toolCalls = 0;
  /** Cumulative tokens served from the prompt cache (12.3). */
  cacheReadTokens = 0;
  /** Cumulative tokens written to the prompt cache (12.3). */
  cacheCreationTokens = 0;
  /** Not readonly: /resume swaps the live session and reset() restarts the clock. */
  startedAt = Date.now();

  /**
   * Zero every counter and restart the clock. Called when /resume swaps the
   * live session (review fix: "统计状态泄漏") — without it /cost and /status
   * kept accumulating the PREVIOUS session's tokens/cost into the new one.
   */
  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.apiCalls = 0;
    this.toolCalls = 0;
    this.cacheReadTokens = 0;
    this.cacheCreationTokens = 0;
    this.promptTokens = 0;
    this.costBuckets.clear();
    this.startedAt = Date.now();
  }

  /**
   * Record one API call's token usage.
   *
   * `model` must be the model that actually served this call, so later model
   * switches cannot reprice its history. Legacy calls that omit it are priced
   * under the model passed to cost(). `provider` defaults to Anthropic's split
   * cache reporting for compatibility with existing cache-aware callers;
   * OpenAI-compatible callers should pass their provider explicitly.
   */
  addUsage(
    inputTokens: number,
    outputTokens: number,
    cache?: { read?: number; creation?: number },
    model?: string,
    provider = "anthropic",
  ): void {
    const cacheRead = cache?.read ?? 0;
    const cacheCreation = cache?.creation ?? 0;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.promptTokens += providerPromptTokens(
      {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
      provider,
    );
    this.apiCalls += 1;
    this.cacheReadTokens += cacheRead;
    this.cacheCreationTokens += cacheCreation;

    const bucketKey = model ?? null;
    const bucket = this.costBuckets.get(bucketKey) ?? { inputTokens: 0, outputTokens: 0 };
    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    this.costBuckets.set(bucketKey, bucket);
  }

  /**
   * Prompt-cache hit rate: cache reads / provider-normalized prompt tokens.
   * Anthropic cache reads and writes are outside input_tokens and both belong
   * in the denominator; OpenAI cached tokens are already inside input_tokens.
   * Returns null when there were no prompt tokens yet.
   */
  get cacheHitRate(): number | null {
    if (this.promptTokens === 0) return null;
    return this.cacheReadTokens / this.promptTokens;
  }

  /** Record that `n` tools executed (default 1). */
  addToolCalls(n = 1): void {
    this.toolCalls += n;
  }

  get totalTokens(): number {
    return this.promptTokens + this.outputTokens;
  }

  /**
   * Best-effort total session cost. Recorded model buckets always use their
   * own historical pricing; `model` prices only legacy calls made without one.
   * Returns null if any bucket has unknown pricing.
   */
  cost(model: string): number | null {
    if (this.costBuckets.size === 0) return estimateCost(model, 0, 0);

    let total = 0;
    for (const [bucketModel, bucket] of this.costBuckets) {
      const cost = estimateCost(bucketModel ?? model, bucket.inputTokens, bucket.outputTokens);
      if (cost === null) return null;
      total += cost;
    }
    return total;
  }

  /** Elapsed wall-clock since the session started, in ms. */
  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}

/** Format a USD amount with sensible precision for small numbers. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format an elapsed duration (ms) as e.g. "1m 23s" or "12s". */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}
