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

/**
 * Two-character Chinese function words that carry no retrieval signal. Only
 * matters for the bigram fallback (the segmenter already emits whole words);
 * kept conservative — content-bearing words like 问题/文件 are NOT here.
 */
const CJK_STOPWORDS = new Set([
  "我们",
  "你们",
  "他们",
  "它们",
  "什么",
  "怎么",
  "怎样",
  "如何",
  "可以",
  "一下",
  "这个",
  "那个",
  "一个",
  "一些",
  "没有",
  "不是",
  "就是",
  "还是",
  "而且",
  "然后",
  "所以",
  "但是",
  "因为",
  "如果",
  "的话",
  "现在",
  "时候",
]);

/** Word segmenter for CJK runs. Feature-detected: older runtimes fall back. */
let zhSegmenter: Intl.Segmenter | null = null;
try {
  zhSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
} catch {
  zhSegmenter = null;
}

/**
 * Split a run of CJK characters into word tokens of length ≥ 2. Prefers
 * Intl.Segmenter word boundaries; when unavailable, falls back to bigrams —
 * overlapping pairs still capture enough compound-word signal for overlap
 * scoring because query and candidate text degrade the same way.
 */
function cjkTokens(run: string): string[] {
  const out: string[] = [];
  if (zhSegmenter) {
    try {
      for (const seg of zhSegmenter.segment(run)) {
        const word = seg.segment.trim();
        if (word.length >= 2 && !CJK_STOPWORDS.has(word)) out.push(word);
      }
      return out;
    } catch {
      // Segmenter misbehaving — degrade to bigrams rather than dropping the text.
    }
  }
  for (let i = 0; i + 1 < run.length; i++) {
    const bigram = run.slice(i, i + 2);
    if (!CJK_STOPWORDS.has(bigram)) out.push(bigram);
  }
  return out;
}

/** ASCII terms and CJK ideograph runs (incl. Extension A), in one pass. */
const TOKEN_RE = /[a-z0-9]+|[\u3400-\u9fff]+/g;

/**
 * Tokenize into lowercased, de-stopworded terms. ASCII terms keep the classic
 * rule (length ≥ 3, English stopwords); CJK runs go through word segmentation
 * (bigram fallback) — without this, `split(/[^a-z0-9]+/)` treats every Chinese
 * character as a separator and Chinese queries produce an EMPTY term set,
 * silently disabling memory/skill injection for CJK sessions.
 */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN_RE)) {
    const raw = match[0];
    if (raw.codePointAt(0)! >= 0x3400) {
      for (const token of cjkTokens(raw)) out.add(token);
    } else if (raw.length >= 3 && !STOPWORDS.has(raw)) {
      out.add(raw);
    }
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
