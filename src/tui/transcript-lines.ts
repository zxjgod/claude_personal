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
//
// P0-1: `verbose` mode (transcript viewer / Ctrl+O) shows FULL tool output
// (no 12-line preview cut) and FULL thinking text; the non-verbose mode keeps
// the preview window and renders thinking collapsed (P0-2). Rows also carry a
// `role: "user"` marker so the viewer can jump between prompts with { / }.
// ============================================================

import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import type { TranscriptItem } from "./store.js";
import { truncateVisual } from "./terminal-width.js";
import { palette } from "./theme.js";

const PREVIEW_LINES = 12;

export interface TranscriptRenderOptions {
  /** Verbose (transcript viewer): full tool output + full thinking. */
  verbose?: boolean;
}

/** One display row: plain text plus optional whole-row Ink styling. */
export interface TranscriptLine {
  text: string;
  /** Ink color for the row (undefined = default foreground). */
  color?: string;
  /** Dim the row (system notices, tool bodies). */
  dim?: boolean;
  /** Marks user-prompt rows ({ / } jump targets in the transcript viewer). */
  role?: "user";
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function truncate(value: string, max: number): string {
  // P3-15: column-aware truncation (CJK-safe).
  return truncateVisual(value, max);
}

/**
 * The collapsed one-line label for committed thinking (P0-2). SHARED by both
 * render paths — the <Static> row in App.tsx and this module's flat lines —
 * so they cannot drift apart. Duration is hidden when unknown (e.g. history
 * replayed by /resume) instead of showing a misleading "0s".
 */
export function collapsedThinkingLine(seconds: number | undefined, lineCount: number): string {
  return seconds === undefined
    ? t("ui.thinking.noSecs", { n: lineCount })
    : t("ui.thinking.collapsed", { s: seconds, n: lineCount });
}

/** One transcript item → its display rows. */
function itemLines(item: TranscriptItem, verbose: boolean): TranscriptLine[] {
  switch (item.kind) {
    case "user":
      // Role coloring: the user's turn is blue, matching the <Static> path.
      return [{ text: `> ${item.text}`, color: palette.user, role: "user" }];
    case "assistant": {
      const md = renderMarkdown(item.text).split("\n");
      // "● " on the first row, two-space indent on continuations (mirrors the
      // AssistantMessage bullet+column layout). Body stays default-colored.
      return md.map((l, i) => ({ text: i === 0 ? `● ${l}` : `  ${l}` }));
    }
    case "thought":
      return [{ text: `  Thought for ${item.seconds}s`, dim: true }];
    case "thinking_text": {
      const lines = item.text.split("\n");
      if (verbose) {
        // Transcript viewer: the full reasoning text.
        return lines.map((l) => ({ text: `  ${l}`, dim: true }));
      }
      // P0-2: collapsed to one line; the full text lives in the viewer.
      return [{ text: `  ${collapsedThinkingLine(item.seconds, lines.length)}`, dim: true }];
    }
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
      // P0-1: verbose mode (transcript viewer) shows everything; the compact
      // mode keeps the preview window.
      const limit = verbose ? Number.POSITIVE_INFINITY : PREVIEW_LINES;
      const isLong = all.length > limit;
      const shown = isLong ? all.slice(0, limit) : all;
      const body: TranscriptLine[] = shown.map((l, i) => ({
        text: i === 0 ? `  ⎿ ${l}` : `    ${l}`,
        dim: true,
      }));
      if (isLong) body.push({ text: `    … +${all.length - limit} lines`, dim: true });
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
  opts: TranscriptRenderOptions = {},
): TranscriptLine[] {
  const verbose = opts.verbose ?? false;
  const out: TranscriptLine[] = [];
  for (const item of transcript) {
    out.push(...itemLines(item, verbose));
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
