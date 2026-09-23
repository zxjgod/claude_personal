// ============================================================
// Provider Profiles — saved API endpoint presets (/provider)
// ============================================================
// Lets the user keep several API configs (a relay/中转站, DeepSeek, Kimi, …)
// in `.claude/providers.json` and hot-swap between them mid-session via the
// `/provider` command — no `.env` edit, no restart.
//
// Each backend the user switches between is OpenAI-compatible, so a profile is
// just the (provider, baseURL, apiKey, model) tuple. Switching mutates the live
// ModelConfig in place (Object.assign), and since the REPL/TUI/agent loop all
// hold the same reference and the caller reads config fields at call time, the
// next turn picks up the new endpoint automatically.
//
// Security: the file holds plaintext API keys, so it is gitignored. A committed
// `.claude/providers.json.example` documents the shape.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProviderConfig } from "./llm-adapter.js";
import type { ModelConfig } from "./types.js";

/** One saved API endpoint preset. Only `name` is required. */
export interface ProviderProfile {
  /** Display name / lookup key (e.g. "中转站A", "deepseek"). */
  name: string;
  /** Provider family; defaults to "openai" when omitted. */
  provider?: ModelConfig["provider"];
  /** OpenAI-compatible base URL; falls back to the provider default. */
  baseURL?: string;
  /** API key for this endpoint; falls back to the current key when omitted. */
  apiKey?: string;
  /** Model id; falls back to the provider default. */
  model?: string;
}

const VALID_PROVIDERS: ReadonlyArray<ModelConfig["provider"]> = [
  "anthropic",
  "openai",
  "deepseek",
  "qwen",
  "moonshot",
  "zhipu",
  "custom",
];

/** Absolute path to the workspace's provider-profiles file. */
export function providersFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "providers.json");
}

/**
 * Read and validate `.claude/providers.json`. Best-effort: a missing file,
 * unparseable JSON, or a malformed shape yields `[]` rather than throwing.
 * Entries without a string `name` are skipped; an unknown `provider` is dropped
 * (so it falls back to "openai" on apply).
 */
export function loadProviderProfiles(workspaceRoot: string): ProviderProfile[] {
  let raw: string;
  try {
    raw = fs.readFileSync(providersFilePath(workspaceRoot), "utf-8");
  } catch {
    return []; // no file → no profiles
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // malformed JSON → treat as no profiles
  }

  const list = (parsed as { profiles?: unknown })?.profiles;
  if (!Array.isArray(list)) return [];

  const profiles: ProviderProfile[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.trim() === "") continue;
    const provider =
      typeof e.provider === "string" &&
      VALID_PROVIDERS.includes(e.provider as ModelConfig["provider"])
        ? (e.provider as ModelConfig["provider"])
        : undefined;
    profiles.push({
      name: e.name,
      provider,
      baseURL: typeof e.baseURL === "string" ? e.baseURL : undefined,
      apiKey: typeof e.apiKey === "string" ? e.apiKey : undefined,
      model: typeof e.model === "string" ? e.model : undefined,
    });
  }
  return profiles;
}

/**
 * Find a profile by name: exact (case-insensitive) match wins; otherwise a
 * unique case-insensitive prefix match. Returns undefined when nothing matches
 * or a prefix is ambiguous (multiple hits).
 */
export function findProfile(
  profiles: ProviderProfile[],
  name: string,
): ProviderProfile | undefined {
  const q = name.trim().toLowerCase();
  if (!q) return undefined;
  const exact = profiles.find((p) => p.name.toLowerCase() === q);
  if (exact) return exact;
  const prefix = profiles.filter((p) => p.name.toLowerCase().startsWith(q));
  return prefix.length === 1 ? prefix[0] : undefined;
}

/**
 * Apply a profile to the live ModelConfig, mutating it in place so every holder
 * of the reference (REPL, TUI, agent loop) sees the change. Missing fields fall
 * back to provider defaults (via resolveProviderConfig); a missing apiKey reuses
 * the current key. maxTokens/temperature/options are preserved.
 */
export function applyProfile(modelConfig: ModelConfig, profile: ProviderProfile): void {
  const resolved = resolveProviderConfig({
    provider: profile.provider ?? "openai",
    apiKey: profile.apiKey ?? modelConfig.apiKey,
    model: profile.model,
    baseURL: profile.baseURL,
    maxTokens: modelConfig.maxTokens,
    temperature: modelConfig.temperature,
    options: modelConfig.options,
  });
  Object.assign(modelConfig, resolved);
}

/**
 * Resolve the optional FAST model config (M5) — the cheap side-channel for
 * high-volume, judgement-light model work (tool-batch digests, compaction
 * summaries, web extraction, memory extraction).
 *
 * Source: CCR_FAST_MODEL, formatted "provider/model" (e.g. "deepseek/deepseek-chat")
 * or just "model" (current provider/endpoint). Returns null when unset or
 * unparseable — callers then use their normal (main) model config.
 *
 * SAME provider (or bare model): inherits apiKey/baseURL/options from the
 * main config, so a cheap model hosted on the same (possibly relay) endpoint
 * needs no extra setup.
 *
 * CROSS provider: the main config's baseURL/apiKey point at the MAIN
 * provider's endpoint — inheriting them would send fast-model requests to
 * the wrong host with the wrong key. The target provider's defaults are
 * resolved instead, requiring its own credentials via
 * CCR_FAST_MODEL_API_KEY (optional CCR_FAST_MODEL_BASE_URL override for
 * private/relay endpoints). Without a key this returns null (main-model
 * fallback) rather than building a config that can only 401.
 */
export function resolveFastModelConfig(modelConfig: ModelConfig): ModelConfig | null {
  const raw = process.env.CCR_FAST_MODEL?.trim();
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash === 0) return null; // "/model" — missing provider segment
  const provider = (
    slash > 0 ? raw.slice(0, slash) : modelConfig.provider
  ) as ModelConfig["provider"];
  const model = slash > 0 ? raw.slice(slash + 1) : raw;
  if (!model) return null;
  if (slash > 0 && !VALID_PROVIDERS.includes(provider)) return null;
  if (provider === modelConfig.provider) {
    return { ...modelConfig, provider, model };
  }
  const apiKey = process.env.CCR_FAST_MODEL_API_KEY?.trim();
  if (!apiKey) return null;
  return resolveProviderConfig({
    provider,
    apiKey,
    model,
    baseURL: process.env.CCR_FAST_MODEL_BASE_URL?.trim() || undefined,
    maxTokens: modelConfig.maxTokens,
    temperature: modelConfig.temperature,
    // options deliberately NOT inherited: gateway routing belongs to the
    // main provider's endpoint.
  });
}
