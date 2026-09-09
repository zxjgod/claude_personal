// ============================================================
// Prompt cache break detection (Phase C — ported from claude-code)
// ============================================================
// The #1 cost driver in a prompt-cached session is a silent cache break: the
// model still answers, but the cached prefix stops hitting and every turn is
// re-billed at full price. This module detects those breaks and attributes
// WHY, so the cause can be fixed instead of guessed.
//
// Technique (two phases):
//   1. recordPromptState() — before each call, hash the cacheable system
//      prefix + per-tool schemas + model + effort, and diff against the
//      previous call to name WHAT changed (system / tools / model / effort).
//   2. checkResponseForCacheBreak() — after each call, compare cache_read
//      tokens against the previous call. A drop of >5% AND >2000 tokens is a
//      break; the pending diff explains it (or it's TTL / server-side).
// ============================================================

import { DYNAMIC_BOUNDARY } from "./system-prompt.js";
import type { Tool } from "./types.js";

const MIN_CACHE_MISS_TOKENS = 2_000;
const BREAK_FRACTION = 0.95; // flag when cache_read < 95% of previous

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i); // hash * 33 ^ c
  }
  return hash >>> 0;
}

/** The cacheable prefix is everything ABOVE the dynamic boundary. */
function stablePrefix(systemPrompt: string): string {
  const idx = systemPrompt.indexOf(DYNAMIC_BOUNDARY);
  return idx === -1 ? systemPrompt : systemPrompt.slice(0, idx);
}

function toolHash(name: string, description: string, inputSchema: unknown): number {
  return djb2Hash(`${name}\n${description}\n${JSON.stringify(inputSchema)}`);
}

export interface PromptStateSnapshot {
  /** Full system prompt; the stable prefix is extracted internally. */
  systemPrompt: string;
  tools: Tool[];
  model: string;
  effort?: string;
}

interface PendingChanges {
  systemPromptChanged: boolean;
  toolSchemasChanged: boolean;
  modelChanged: boolean;
  effortChanged: boolean;
  addedTools: string[];
  removedTools: string[];
  changedToolSchemas: string[];
  previousModel: string;
  newModel: string;
}

interface State {
  systemHash: number;
  toolsHash: number;
  perToolHashes: Record<string, number>;
  toolNames: string[];
  model: string;
  effort: string;
  callCount: number;
  pendingChanges: PendingChanges | null;
  prevCacheRead: number | null;
}

const defaultScope = {};
let states = new WeakMap<object, State>();

/** Record the pre-call prompt/tool state and diff against the previous call. */
export function recordPromptState(
  snapshot: PromptStateSnapshot,
  scope: object = defaultScope,
): void {
  let state = states.get(scope);
  const system = stablePrefix(snapshot.systemPrompt);
  const systemHash = djb2Hash(system);
  const toolNames = snapshot.tools.map((t) => t.name);
  const toolsHash = djb2Hash(
    snapshot.tools.map((t) => toolHash(t.name, t.promptDescription, t.inputSchema)).join("\n"),
  );
  const perToolHashes: Record<string, number> = {};
  for (const t of snapshot.tools) {
    perToolHashes[t.name] = toolHash(t.name, t.promptDescription, t.inputSchema);
  }
  const model = snapshot.model;
  const effort = snapshot.effort ?? "default";

  if (!state) {
    state = {
      systemHash,
      toolsHash,
      perToolHashes,
      toolNames,
      model,
      effort,
      callCount: 1,
      pendingChanges: null,
      prevCacheRead: null,
    };
    states.set(scope, state);
    return;
  }

  state.callCount++;
  const systemPromptChanged = systemHash !== state.systemHash;
  const toolSchemasChanged = toolsHash !== state.toolsHash;
  const modelChanged = model !== state.model;
  const effortChanged = effort !== state.effort;

  const prevSet = new Set(state.toolNames);
  const newSet = new Set(toolNames);
  const addedTools = toolNames.filter((n) => !prevSet.has(n));
  const removedTools = state.toolNames.filter((n) => !newSet.has(n));
  const changedToolSchemas: string[] = [];
  if (toolSchemasChanged) {
    for (const name of toolNames) {
      if (prevSet.has(name) && perToolHashes[name] !== state.perToolHashes[name]) {
        changedToolSchemas.push(name);
      }
    }
  }

  if (systemPromptChanged || toolSchemasChanged || modelChanged || effortChanged) {
    state.pendingChanges = {
      systemPromptChanged,
      toolSchemasChanged,
      modelChanged,
      effortChanged,
      addedTools,
      removedTools,
      changedToolSchemas,
      previousModel: state.model,
      newModel: model,
    };
  } else {
    state.pendingChanges = null;
  }

  state.systemHash = systemHash;
  state.toolsHash = toolsHash;
  state.perToolHashes = perToolHashes;
  state.toolNames = toolNames;
  state.model = model;
  state.effort = effort;
}

export interface CacheBreakReport {
  reason: string;
  changes: string[];
}

/** After the call, detect a cache break and attribute its root cause. */
export function checkResponseForCacheBreak(
  cacheReadTokens: number,
  // Reserved for future attribution (creation-side breaks); not yet consulted.
  _cacheCreationTokens: number,
  scope: object = defaultScope,
): CacheBreakReport | null {
  const state = states.get(scope);
  if (!state) return null;
  const prevCacheRead = state.prevCacheRead;
  state.prevCacheRead = cacheReadTokens;

  if (prevCacheRead === null) return null; // first call — no baseline

  const tokenDrop = prevCacheRead - cacheReadTokens;
  if (cacheReadTokens >= prevCacheRead * BREAK_FRACTION || tokenDrop < MIN_CACHE_MISS_TOKENS) {
    state.pendingChanges = null;
    return null;
  }

  const changes = state.pendingChanges;
  state.pendingChanges = null;

  const parts: string[] = [];
  if (changes?.modelChanged) {
    parts.push(`model changed (${changes.previousModel} → ${changes.newModel})`);
  }
  if (changes?.systemPromptChanged) parts.push("system prompt changed");
  if (changes?.toolSchemasChanged) {
    const added = changes.addedTools.length;
    const removed = changes.removedTools.length;
    if (added > 0 || removed > 0) {
      parts.push(`tools changed (+${added}/-${removed})`);
    } else {
      parts.push(`tool schema changed (${changes.changedToolSchemas.join(", ") || "unknown"})`);
    }
  }
  if (changes?.effortChanged) parts.push("effort changed");

  const reason =
    parts.length > 0
      ? parts.join(", ")
      : "prompt unchanged — likely TTL expiry or server-side eviction";

  return { reason, changes: parts };
}

/** Test/util: reset tracking state. */
export function resetPromptCacheState(): void {
  states = new WeakMap();
}
