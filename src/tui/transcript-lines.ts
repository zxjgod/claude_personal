// ============================================================
// transcriptToLines — flatten transcript items to text rows (M25.2)
// ============================================================
// The full-screen ScrollView windows over a flat string[] (see ScrollView's
// note on why line-based). This converts the store's TranscriptItem[] plus the
// in-flight streaming text into that flat array, mirroring the <Static> path's
// visual structure (● assistant, ⎿ tool result, etc.) as plain text. Color is
// dropped here — the trade-off for exact windowed scrolling without per-node
// height measurement. The default (non-fullscreen) path keeps full color.
// ============================================================

import { renderMarkdown } from "./../markdown.js";
import type { TranscriptItem } from "./store.js";

const PREVIEW_LINES = 12;

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

/** One transcript item → its text rows. */
function itemLines(item: TranscriptItem): string[] {
  switch (item.kind) {
    case "user":
      return [`> ${item.text}`];
    case "assistant": {
      const md = renderMarkdown(item.text).split("\n");
      // "● " on the first row, two-space indent on continuations (mirrors the
      // AssistantMessage bullet+column layout).
      return md.map((l, i) => (i === 0 ? `● ${l}` : `  ${l}`));
    }
    case "thought":
      return [`  Thought for ${item.seconds}s`];
    case "notice":
      return [item.text];
    case "log":
      return item.lines;
    case "tool": {
      const r = item.result;
      if (!r) return [];
      const head = `● ${capitalize(r.toolName)}${item.detail ? `(${truncate(item.detail, 100)})` : ""}`;
      if (r.error) return [head, `  ⎿ ${r.error}`];
      const all = (r.formatted ?? "").split("\n");
      const isLong = all.length > PREVIEW_LINES;
      const shown = isLong ? all.slice(0, PREVIEW_LINES) : all;
      const body = shown.map((l, i) => (i === 0 ? `  ⎿ ${l}` : `    ${l}`));
      if (isLong) body.push(`    … +${all.length - PREVIEW_LINES} lines`);
      return [head, ...body];
    }
  }
}

/**
 * Flatten the transcript (+ optional live streaming text) into display rows.
 * A blank spacer row follows assistant/tool blocks to mirror the marginBottom
 * the <Static> path uses.
 */
export function transcriptToLines(transcript: TranscriptItem[], streamingText: string): string[] {
  const out: string[] = [];
  for (const item of transcript) {
    out.push(...itemLines(item));
    if (item.kind === "assistant" || item.kind === "tool") out.push("");
  }
  if (streamingText.trim()) {
    const md = renderMarkdown(streamingText).split("\n");
    out.push(...md.map((l, i) => (i === 0 ? `● ${l}` : `  ${l}`)));
  }
  return out;
}
