// ============================================================
// Model Metadata — single source of truth for per-model facts
// ============================================================
// Context windows, output caps, capability flags (effort / adaptive thinking /
// OpenAI-style reasoning) and rough pricing, keyed by lowercase model-id
// substring (or prefix). Previously these facts were scattered across three
// partial tables (session-stats PRICING, session-stats CONTEXT_WINDOWS,
// effort.ts regexes) and two hardcoded agent-loop thresholds that ignored the
// model entirely (Top10 follow-up: 分册01 §6-7 / 分册02 §6-5).
//
// Consumers:
//   - anthropic-adapter: gate output_config.effort and adaptive thinking
//     (sending effort to Sonnet 4.5 / Haiku 4.5 is a hard 400);
//   - llm-adapter: OpenAI reasoning models require max_completion_tokens
//     (max_tokens is a 400 on the o-series);
//   - agent-loop: compaction threshold / hard limit derived from the real
//     context window instead of the 150k/200k magic numbers;
//   - session-stats: pricing + the /context gauge window.
//
// Data freshness: Anthropic rows verified against the claude-api skill's
// current-models table (2026-06 cache: Fable 5 / Opus 4.8 / Sonnet 5 / Haiku
// 4.5). Third-party rows are best-effort like the old tables — unknown models
// return null and every consumer falls back to its prior default.
//
// Ordering rule: MORE SPECIFIC match strings first (the first hit wins), e.g.
// "claude-opus-4-8" before "claude-opus".
// ============================================================

/** USD per 1M tokens. Rough guide for local cost display, not billing. */
export interface ModelPricing {
  input: number;
  output: number;
}

export interface ModelMetadata {
  /** Lowercase substring matched against the model id (first hit wins). */
  match: string;
  /** When true, `match` is anchored to the START of the model id instead. */
  prefix?: boolean;
  /** Total context window in tokens. */
  contextWindow: number;
  /** Maximum output tokens per response (streaming ceilings included). */
  maxOutput: number;
  /** Accepts Anthropic `output_config.effort` (400 on Sonnet 4.5/Haiku 4.5). */
  supportsEffort?: boolean;
  /** Accepts Anthropic `thinking: {type:"adaptive"}` (Opus 4.6+, Sonnet 4.6+). */
  supportsThinking?: boolean;
  /** OpenAI-style reasoning model: requires `max_completion_tokens`, rejects
   *  `temperature`, streams reasoning via `delta.reasoning_content`. */
  isReasoning?: boolean;
  pricing?: ModelPricing;
}

const MODEL_METADATA: readonly ModelMetadata[] = [
  // --- Anthropic (verified against the claude-api skill model table) ---
  {
    match: "claude-fable-5",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsEffort: true,
    supportsThinking: true, // always-on; the param must be omitted or adaptive
    pricing: { input: 10, output: 50 },
  },
  {
    match: "claude-mythos-5",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsEffort: true,
    supportsThinking: true,
    pricing: { input: 10, output: 50 },
  },
  {
    match: "claude-opus-4-8",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsEffort: true,
    supportsThinking: true,
    pricing: { input: 5, output: 25 },
  },
  {
    match: "claude-opus-4-7",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsEffort: true,
    supportsThinking: true,
    pricing: { input: 5, output: 25 },
  },
  {
    match: "claude-opus-4-6",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsEffort: true,
    supportsThinking: true,
    pricing: { input: 5, output: 25 },
  },
  {
    match: "claude-opus-4-5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsEffort: true,
    // Adaptive thinking arrived with 4.6; 4.5 uses the legacy budget form, so
    // the adapter omits `thinking` rather than risk a 400.
    pricing: { input: 5, output: 25 },
  },
  {
    // Legacy Opus (4.1 / 4 — ids carrying the "claude-opus" substring; the
    // dated claude-3-opus-* ids have their own row below).
    match: "claude-opus",
    contextWindow: 200_000,
    maxOutput: 32_000,
    pricing: { input: 15, output: 75 },
  },
  {
    match: "claude-sonnet-5",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsEffort: true,
    supportsThinking: true,
    pricing: { input: 3, output: 15 },
  },
  {
    match: "claude-sonnet-4-6",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsEffort: true,
    supportsThinking: true,
    pricing: { input: 3, output: 15 },
  },
  {
    // Sonnet 4.5: effort is a documented 400; adaptive thinking unsupported.
    match: "claude-sonnet-4-5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricing: { input: 3, output: 15 },
  },
  {
    // Dated legacy ids (claude-3-7-sonnet-20250219 etc.) do NOT contain the
    // "claude-sonnet" substring — they need their own rows or the lookup
    // returns null and the adapters' maxOutput clamp silently no-ops
    // (LLM_MAX_TOKENS=32000 would go out raw and 400 on an 8K-output model).
    match: "claude-3-7-sonnet",
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricing: { input: 3, output: 15 },
  },
  {
    match: "claude-3-5-sonnet",
    contextWindow: 200_000,
    maxOutput: 8_192,
    pricing: { input: 3, output: 15 },
  },
  {
    // Generic legacy Sonnet (claude-sonnet-4-20250514 and friends — ids that
    // DO carry the "claude-sonnet" substring).
    match: "claude-sonnet",
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricing: { input: 3, output: 15 },
  },
  {
    // Haiku 4.5: effort is a documented 400.
    match: "claude-haiku-4-5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricing: { input: 1, output: 5 },
  },
  {
    match: "claude-3-5-haiku",
    contextWindow: 200_000,
    maxOutput: 8_192,
    pricing: { input: 0.8, output: 4 },
  },
  {
    match: "claude-3-haiku",
    contextWindow: 200_000,
    maxOutput: 4_096,
    pricing: { input: 0.25, output: 1.25 },
  },
  {
    match: "claude-3-opus",
    contextWindow: 200_000,
    maxOutput: 4_096,
    pricing: { input: 15, output: 75 },
  },
  {
    match: "claude-haiku",
    contextWindow: 200_000,
    maxOutput: 8_192,
    pricing: { input: 0.8, output: 4 },
  },

  // --- OpenAI ---
  { match: "gpt-5", contextWindow: 400_000, maxOutput: 128_000, isReasoning: true },
  {
    match: "gpt-4o-mini",
    contextWindow: 128_000,
    maxOutput: 16_384,
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    match: "gpt-4o",
    contextWindow: 128_000,
    maxOutput: 16_384,
    pricing: { input: 2.5, output: 10 },
  },
  // Review follow-up: the bare `gpt-4` row is an 8K-window substring match, so
  // every longer-context 4.x variant must be listed BEFORE it (first hit
  // wins) — otherwise gpt-4-turbo/4.1/4.5 are judged 8K windows and the
  // derived compaction threshold fires every ~7K tokens.
  {
    match: "gpt-4.1",
    contextWindow: 1_047_576,
    maxOutput: 32_768,
    pricing: { input: 2, output: 8 },
  },
  {
    match: "gpt-4.5",
    contextWindow: 128_000,
    maxOutput: 16_384,
    pricing: { input: 75, output: 150 },
  },
  {
    match: "gpt-4-turbo",
    contextWindow: 128_000,
    maxOutput: 4_096,
    pricing: { input: 10, output: 30 },
  },
  {
    match: "gpt-4-32k",
    contextWindow: 32_768,
    maxOutput: 8_192,
    pricing: { input: 60, output: 120 },
  },
  { match: "gpt-4", contextWindow: 8_192, maxOutput: 8_192, pricing: { input: 30, output: 60 } },
  { match: "gpt-3.5", contextWindow: 16_385, maxOutput: 4_096 },
  // o-series: prefix-anchored so unrelated ids containing "o1" don't match.
  // o1-mini BEFORE o1 (fourth-round review): its max_completion_tokens cap is
  // 65,536 — inheriting the o1 row's 100k let an explicitly raised
  // LLM_MAX_TOKENS send an over-cap request that OpenAI rejects with a 400.
  { match: "o1-mini", prefix: true, contextWindow: 200_000, maxOutput: 65_536, isReasoning: true },
  { match: "o1", prefix: true, contextWindow: 200_000, maxOutput: 100_000, isReasoning: true },
  { match: "o3", prefix: true, contextWindow: 200_000, maxOutput: 100_000, isReasoning: true },
  { match: "o4", prefix: true, contextWindow: 200_000, maxOutput: 100_000, isReasoning: true },

  // --- Third-party OpenAI-compatible (best-effort, as the old tables were) ---
  {
    match: "deepseek-reasoner",
    contextWindow: 64_000,
    maxOutput: 64_000,
    isReasoning: true,
    pricing: { input: 0.27, output: 1.1 },
  },
  {
    match: "deepseek",
    contextWindow: 64_000,
    maxOutput: 8_192,
    pricing: { input: 0.27, output: 1.1 },
  },
  { match: "qwen", contextWindow: 131_072, maxOutput: 8_192, pricing: { input: 0.5, output: 1.5 } },
  {
    match: "moonshot",
    contextWindow: 128_000,
    maxOutput: 8_192,
    pricing: { input: 0.6, output: 2.5 },
  },
];

/** The default Anthropic model id — one constant instead of three literals. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

/** Look up metadata for a model id (case-insensitive), or null if unknown. */
export function lookupModelMetadata(model: string | undefined): ModelMetadata | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const entry of MODEL_METADATA) {
    if (entry.prefix ? m.startsWith(entry.match) : m.includes(entry.match)) return entry;
  }
  return null;
}

/** Context window in tokens, or null when the model is unknown. */
export function modelContextWindow(model: string | undefined): number | null {
  return lookupModelMetadata(model)?.contextWindow ?? null;
}

/** Max output tokens, or null when unknown. */
export function modelMaxOutput(model: string | undefined): number | null {
  return lookupModelMetadata(model)?.maxOutput ?? null;
}

/**
 * Does the model accept Anthropic's `output_config.effort`? Unknown models
 * answer false (fail-closed: an unsupported effort is a hard 400, while a
 * missing effort just uses the API default).
 */
export function modelSupportsEffort(model: string | undefined): boolean {
  return lookupModelMetadata(model)?.supportsEffort === true;
}

/**
 * Does the model accept `thinking: {type:"adaptive"}`? Unknown → false
 * (omitting thinking is always safe; sending adaptive to a model that lacks
 * it is a 400).
 */
export function modelSupportsAdaptiveThinking(model: string | undefined): boolean {
  return lookupModelMetadata(model)?.supportsThinking === true;
}

/**
 * OpenAI-style reasoning model (o-series / gpt-5 / deepseek-reasoner): the
 * OpenAI-compatible request must use `max_completion_tokens` (plain
 * `max_tokens` is a 400 on the o-series) and `temperature` must be omitted.
 */
export function isOpenAIReasoningModel(model: string | undefined): boolean {
  return lookupModelMetadata(model)?.isReasoning === true;
}

/** Pricing for a model id, or null if unknown (callers show tokens only). */
export function modelPricing(model: string | undefined): ModelPricing | null {
  return lookupModelMetadata(model)?.pricing ?? null;
}
