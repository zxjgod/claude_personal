// ============================================================
// History replay — Message[] → transcript items (for /resume)
// ============================================================
// Converts a saved conversation (the internal Message[] format) into the
// TranscriptItem shape the TUI renders. This is what makes a resumed session
// show its full prior history (user turns, assistant replies, tool calls +
// results) on screen so the user can scroll back through it.
//
// It is a pure data transform — no fs, no LLM, no tokens. The agent loop's
// `messages` array is the source of truth; this only re-presents it visually.
//
// Pairing model: an assistant message carries `tool_calls`; the matching
// outputs arrive as later `role:"tool"` messages keyed by `tool_call_id`. We
// pre-index those results, then emit one "tool" transcript item per tool_call
// with its result inlined (so the standalone tool messages are not re-emitted).
// ============================================================

import type { Message, ToolExecutionResult } from "./../types.js";
import type { TranscriptItem } from "./store.js";

/** Transcript item without the store-assigned numeric id. */
export type ReplayItem = Omit<TranscriptItem, "id">;

/** Pull the display detail (filePath/command/…) out of a tool_call's args. */
function argDetail(argsJson: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return "";
  }
  for (const k of ["command", "filePath", "file_path", "path", "pattern", "url", "query"]) {
    const v = parsed[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * Convert a saved conversation into transcript items for replay.
 *
 * Skips `system` messages (compaction summaries / injected context) — the
 * replay shows the human-facing turns only: user, assistant, tool.
 */
export function messagesToTranscript(messages: Message[]): ReplayItem[] {
  // Index tool results by their call id so each assistant tool_call can inline
  // the output it produced.
  const toolResultById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool") toolResultById.set(m.tool_call_id, m.content ?? "");
  }

  const items: ReplayItem[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "user": {
        const text = m.content
          .map((b) => (b.type === "text" ? b.text : "[image]"))
          .join("")
          .trim();
        if (text) items.push({ kind: "user", text } as ReplayItem);
        break;
      }
      case "assistant": {
        const text = (m.content ?? "").trim();
        if (text) items.push({ kind: "assistant", text } as ReplayItem);
        for (const tc of m.tool_calls ?? []) {
          const name = tc.function.name;
          const detail = argDetail(tc.function.arguments);
          const hasResult = toolResultById.has(tc.id);
          const formatted = hasResult ? toolResultById.get(tc.id)! : "(no result recorded)";
          const result: ToolExecutionResult = {
            toolName: name,
            formatted,
            result: { content: formatted },
          };
          items.push({ kind: "tool", name, detail, result } as ReplayItem);
        }
        break;
      }
      // role:"tool" outputs are inlined into their assistant tool_call above;
      // role:"system" is intentionally not replayed.
      case "tool":
      case "system":
        break;
    }
  }

  return items;
}

/** Short snippet of the first user message — used as a picker preview line. */
export function firstUserPreview(messages: Message[], maxLen = 72): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    return text.length <= maxLen ? text : text.slice(0, maxLen - 1) + "…";
  }
  return "";
}
