// ============================================================
// Background Prefetch — hide latency in the model stream (M36, kernel §9)
// ============================================================
// The model streams for 5–30s before a turn resolves. That window is free
// compute: kick off cheap, offline work the moment streaming starts so the
// NEXT turn is smarter without paying latency for it. Two prefetches:
//
//   - memory relevance: rank stored memories (.claude/memories.jsonl) against
//     the latest user text, surface the top few.
//   - skill discovery:  rank the skill catalog against the same text, surface
//     the few most relevant by name+description.
//
// Both are pure keyword-overlap rankers (no model call, no I/O beyond the
// already-loaded lists), so they finish in microseconds and are fully testable.
// The result is injected as a single <system-reminder> attachment before the
// next model call — background context, never an instruction.
// ============================================================

import type { ExtractedMemory } from "./memory-extract.js";
import type { SkillInfo } from "./skills.js";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "i",
  "you",
  "we",
  "do",
  "does",
  "how",
  "what",
  "why",
  "can",
  "should",
  "would",
  "please",
  "let",
  "me",
  "my",
  "your",
]);

/** Tokenize into lowercased, de-stopworded terms of length ≥ 3. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Overlap score: how many query terms appear in the candidate's terms. */
function overlap(query: Set<string>, candidate: Set<string>): number {
  let n = 0;
  for (const q of query) if (candidate.has(q)) n++;
  return n;
}

export interface RankedMemory {
  memory: ExtractedMemory;
  score: number;
}

/** Rank memories by keyword overlap with the query; drop zero-score, cap. */
export function rankMemories(
  query: string,
  memories: ExtractedMemory[],
  limit = 3,
): RankedMemory[] {
  const q = keywords(query);
  if (q.size === 0) return [];
  return memories
    .map((memory) => ({ memory, score: overlap(q, keywords(memory.text)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface RankedSkill {
  skill: SkillInfo;
  score: number;
}

/** Rank skills by keyword overlap of the query with name+description. */
export function rankSkills(query: string, skills: SkillInfo[], limit = 3): RankedSkill[] {
  const q = keywords(query);
  if (q.size === 0) return [];
  return skills
    .map((skill) => ({
      skill,
      score: overlap(q, keywords(`${skill.name} ${skill.description}`)),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface PrefetchResult {
  memories: RankedMemory[];
  skills: RankedSkill[];
}

/**
 * Render the prefetch into a single <system-reminder> attachment block, or null
 * when nothing relevant was found (so the loop injects nothing). Framed as
 * background context — the model decides whether it's useful.
 */
export function renderPrefetchAttachment(result: PrefetchResult): string | null {
  const lines: string[] = [];
  if (result.memories.length > 0) {
    lines.push("Possibly relevant memories (background context, may be stale):");
    for (const r of result.memories) lines.push(`- ${r.memory.text}`);
  }
  if (result.skills.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Skills that may fit this task (invoke via the Skill tool if useful):");
    for (const r of result.skills) lines.push(`- ${r.skill.name}: ${r.skill.description}`);
  }
  if (lines.length === 0) return null;
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
}

/**
 * Fire-once background prefetch (kernel §9). Construction kicks off the ranking
 * synchronously (it's cheap/pure) but exposes the result via a Promise so the
 * loop can treat it as async work started during streaming and consumed later.
 * A `provider` indirection keeps this module free of fs / registry imports so
 * it stays pure and testable; the loop wires the real sources.
 */
export interface PrefetchSources {
  query: string;
  memories: () => ExtractedMemory[];
  skills: () => SkillInfo[];
  limit?: number;
}

export function startPrefetch(sources: PrefetchSources): Promise<PrefetchResult> {
  return Promise.resolve().then(() => {
    let memories: RankedMemory[] = [];
    let skills: RankedSkill[] = [];
    // Best-effort: a failing source contributes nothing rather than throwing
    // into the loop.
    try {
      memories = rankMemories(sources.query, sources.memories(), sources.limit);
    } catch {
      memories = [];
    }
    try {
      skills = rankSkills(sources.query, sources.skills(), sources.limit);
    } catch {
      skills = [];
    }
    return { memories, skills };
  });
}
