// ============================================================
// transcriptToLines — flatten transcript items to display rows (M25.2 · P3-16)
// ============================================================
// The full-screen ScrollView windows over a flat line array (see ScrollView's
// note on why line-based). This converts the store's TranscriptItem[] plus the
// in-flight streaming text into that flat array, mirroring the <Static> path's
// visual structure (● assistant, ⎿ tool result, etc.).
//
// P3-16: rows now carry a role COLOR (user blue, tool head orange, tool body
// and system notices dim, errors red) so the pager/full-screen view reads like
// the colored default path instead of a wall of monochrome text. Still one
// color per row — exact windowing stays intact (no per-node measurement).
// ============================================================

import { renderMarkdown } from "./markdown.js";
import type { TranscriptItem } from "./store.js";
import { truncateVisual } from "./terminal-width.js";
import { palette } from "./theme.js";

const PREVIEW_LINES = 12;

/** One display row: plain text plus optional whole-row Ink styling. */
export interface TranscriptLine {
  text: string;
  /** Ink color for the row (undefined = default foreground). */
  color?: string;
  /** Dim the row (system notices, tool bodies). */
  dim?: boolean;
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function truncate(value: string, max: number): string {
  // P3-15: column-aware truncation (CJK-safe).
  return truncateVisual(value, max);
}

/** One transcript item → its display rows. */
function itemLines(item: TranscriptItem): TranscriptLine[] {
  switch (item.kind) {
    case "user":
      // Role coloring: the user's turn is blue, matching the <Static> path.
      return [{ text: `> ${item.text}`, color: palette.user }];
    case "assistant": {
      const md = renderMarkdown(item.text).split("\n");
      // "● " on the first row, two-space indent on continuations (mirrors the
      // AssistantMessage bullet+column layout). Body stays default-colored.
      return md.map((l, i) => ({ text: i === 0 ? `● ${l}` : `  ${l}` }));
    }
    case "thought":
      return [{ text: `  Thought for ${item.seconds}s`, dim: true }];
    case "thinking_text":
      // Reasoning content: dim, like the committed thinking row in <Static>.
      return item.text.split("\n").map((l) => ({ text: `  ${l}`, dim: true }));
    case "notice":
      return [{ text: item.text, dim: true }];
    case "log":
      return item.lines.map((l) => ({ text: l }));
    case "tool": {
      const r = item.result;
      if (!r) return [];
      // Head row carries the orange ● accent; the ⎿ body rows go dim so the
      // block reads like the colored default path at a glance.
      const head = `● ${capitalize(r.toolName)}${item.detail ? `(${truncate(item.detail, 100)})` : ""}`;
      if (r.error)
        return [
          { text: head, color: palette.accent },
          { text: `  ⎿ ${r.error}`, color: palette.error },
        ];
      const all = (r.formatted ?? "").split("\n");
      const isLong = all.length > PREVIEW_LINES;
      const shown = isLong ? all.slice(0, PREVIEW_LINES) : all;
      const body: TranscriptLine[] = shown.map((l, i) => ({
        text: i === 0 ? `  ⎿ ${l}` : `    ${l}`,
        dim: true,
      }));
      if (isLong) body.push({ text: `    … +${all.length - PREVIEW_LINES} lines`, dim: true });
      return [{ text: head, color: palette.accent }, ...body];
    }
  }
}

/**
 * Flatten the transcript (+ optional live streaming text) into display rows.
 * A blank spacer row follows assistant/tool blocks to mirror the marginBottom
 * the <Static> path uses.
 */
export function transcriptToLines(
  transcript: TranscriptItem[],
  streamingText: string,
  streamingThinking = "",
): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const item of transcript) {
    out.push(...itemLines(item));
    if (item.kind === "assistant" || item.kind === "tool") out.push({ text: "" });
  }
  if (streamingThinking.trim()) {
    out.push(...streamingThinking.split("\n").map((l) => ({ text: `  ${l}`, dim: true })));
  }
  if (streamingText.trim()) {
    const md = renderMarkdown(streamingText).split("\n");
    out.push(...md.map((l, i) => ({ text: i === 0 ? `● ${l}` : `  ${l}` })));
  }
  return out;
}
