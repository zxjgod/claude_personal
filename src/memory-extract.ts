// ============================================================
// Memory extraction + store (M19.3)
// ============================================================
// Pulls durable, cross-session "memories" (facts / preferences / what changed)
// out of a session and persists them to a structured, append-only store at
//   <workspace>/.claude/memories.jsonl
//
// Two extraction paths:
//   - extractMemoriesHeuristic(): offline, rule-based, zero token cost. Always
//     available; this is what /memory extract runs.
//   - extractMemoriesWithModel(): optional single side-call to the model for a
//     higher-quality pass. Only used when explicitly invoked.
//
// The store is intentionally separate from CLAUDE.md: auto-extracted notes
// don't churn the hand-curated project memory file. /memory lists both.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Message, ModelCaller, ModelConfig } from "./types.js";
import type { FileChange } from "./change-tracker.js";

export type MemorySource = "heuristic" | "model" | "manual";

export interface ExtractedMemory {
  id: string;
  /** ISO 8601 capture time. */
  ts: string;
  source: MemorySource;
  text: string;
  tags?: string[];
}

/** Input fields a caller supplies; id/ts default if omitted. */
export interface MemoryInput {
  source: MemorySource;
  text: string;
  tags?: string[];
  id?: string;
  ts?: string;
}

// Durable-intent prefixes: lines that read like a standing instruction or fact
// worth remembering across sessions.
const INTENT_RE = /^(remember|always|never|prefer|from now on|note that|keep in mind|make sure)\b/i;

/** Extract the plain text of a user message (concatenated text blocks). */
function userText(message: Message): string {
  if (message.role !== "user") return "";
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Normalize a memory's text for dedupe (lowercase, collapse whitespace). */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Rule-based, offline extraction. Scans user messages for durable-intent lines
 * and summarizes files changed this session. Returns memories WITHOUT writing
 * them — the caller decides whether to persist.
 */
export function extractMemoriesHeuristic(
  messages: Message[],
  changes: FileChange[] = [],
): ExtractedMemory[] {
  const out: ExtractedMemory[] = [];
  const seen = new Set<string>();
  const stampBase = new Date().toISOString();

  const push = (text: string, tags?: string[]) => {
    const key = normalize(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      id: crypto.randomUUID(),
      ts: stampBase,
      source: "heuristic",
      text: text.trim(),
      tags,
    });
  };

  // Durable-intent lines from user prompts.
  for (const message of messages) {
    const text = userText(message);
    if (!text) continue;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (INTENT_RE.test(line)) push(line, ["preference"]);
    }
  }

  // A single summary of files touched this session.
  if (changes.length > 0) {
    const files = changes
      .slice(0, 10)
      .map((c) => `${c.kind === "created" ? "+" : "~"}${c.path}`)
      .join(", ");
    const more = changes.length > 10 ? ` (+${changes.length - 10} more)` : "";
    push(`Files changed this session: ${files}${more}`, ["changes"]);
  }

  return out;
}

/**
 * Optional model-assisted extraction. Makes a single side-call asking the model
 * to surface durable facts/preferences as a JSON array of strings. Falls back
 * to [] on any error or unparseable response — never throws.
 */
export async function extractMemoriesWithModel(
  messages: Message[],
  callModel: ModelCaller,
  modelConfig: ModelConfig,
): Promise<ExtractedMemory[]> {
  const transcript = messages
    .map((m) => {
      if (m.role === "user") return `USER: ${userText(m)}`;
      if (m.role === "assistant") return `ASSISTANT: ${m.content ?? ""}`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 12000);

  const prompt: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "From the conversation below, extract durable facts and preferences worth " +
            "remembering in future sessions (project conventions, the user's stated " +
            "preferences, key decisions). Respond with ONLY a JSON array of short " +
            "strings, no prose. If nothing is worth remembering, respond with [].\n\n" +
            transcript,
        },
      ],
    },
  ];

  let text = "";
  try {
    for await (const event of callModel(prompt, [], "", modelConfig)) {
      if (event.type === "text_delta") text += event.delta;
    }
  } catch {
    return [];
  }

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const ts = new Date().toISOString();
  return parsed
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => ({
      id: crypto.randomUUID(),
      ts,
      source: "model" as const,
      text: s.trim(),
    }));
}

/**
 * Append-only structured memory store backed by .claude/memories.jsonl.
 * One JSON object per line. Dedupes by normalized text against what's already
 * on disk so repeated /memory extract runs don't pile up duplicates.
 */
export class MemoryStore {
  private filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, ".claude", "memories.jsonl");
  }

  get path(): string {
    return this.filePath;
  }

  /** All stored memories, oldest first. Tolerates malformed lines. */
  list(): ExtractedMemory[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const out: ExtractedMemory[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.text === "string") {
          out.push(parsed as ExtractedMemory);
        }
      } catch {
        // Skip a corrupt/partial line.
      }
    }
    return out;
  }

  /**
   * Append memories not already present (by normalized text). Returns the
   * memories actually written (after dedupe).
   */
  append(memories: MemoryInput[]): ExtractedMemory[] {
    if (memories.length === 0) return [];

    const existing = new Set(this.list().map((m) => normalize(m.text)));
    const toWrite: ExtractedMemory[] = [];
    for (const m of memories) {
      const key = normalize(m.text);
      if (!key || existing.has(key)) continue;
      existing.add(key);
      toWrite.push({
        id: m.id ?? crypto.randomUUID(),
        ts: m.ts ?? new Date().toISOString(),
        source: m.source,
        text: m.text.trim(),
        tags: m.tags,
      });
    }
    if (toWrite.length === 0) return [];

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lines = toWrite.map((m) => JSON.stringify(m)).join("\n");
    fs.appendFileSync(this.filePath, `${lines}\n`, "utf-8");
    return toWrite;
  }
}
