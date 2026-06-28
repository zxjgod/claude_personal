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
