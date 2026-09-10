// ============================================================
// transcriptToLines — flatten transcript items to display rows (M25.2 · P3-16)
// ============================================================
// The full-screen ScrollView windows over a flat line array (see ScrollView's
// note on why line-based). This converts the store's TranscriptItem[] plus the
// in-flight streaming text into that flat array, mirroring the <Static> path's
// visual structure (● assistant, ⎿ tool result, etc.).
//
// Rows carry neutral text plus ANSI syntax/diff colors shared with ToolCard.
// Muted chrome stays separate so syntax is not dimmed in the history viewer.
//
// P0-1: `verbose` mode (transcript viewer / Ctrl+O) shows FULL tool output
// (no 12-line preview cut) and FULL thinking text; the non-verbose mode keeps
// the preview window and renders thinking collapsed (P0-2). Rows also carry a
// `role: "user"` marker so the viewer can jump between prompts with { / }.
// ============================================================

import chalk from "chalk";
import { BLACK_CIRCLE, TOOL_RESULT } from "./figures.js";
import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import type { TranscriptItem } from "./store.js";
import { truncateVisual } from "./terminal-width.js";
import { palette } from "./theme.js";
import { toolOutputLines } from "./tool-output.js";

const PREVIEW_LINES = 12;

export interface TranscriptRenderOptions {
  /** Verbose (transcript viewer): full tool output + full thinking. */
  verbose?: boolean;
  /** Batch D6 (viewer ctrl+e): collapse thinking to one-liners even in
   *  verbose mode — the official transcript:toggleShowAll "collapse" side.
   *  Tool output stays full; only thinking folds. */
  collapseThinking?: boolean;
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
function itemLines(
  item: TranscriptItem,
  verbose: boolean,
  opts: TranscriptRenderOptions,
): TranscriptLine[] {
  switch (item.kind) {
    case "user": {
      // Official: dim user turns with a "> " marker. A multi-line draft
      // (Ctrl+J / paste) flattens to ONE row per physical line: the pagers
      // window over this array 1:1 (ScrollView counts lines, not wrapped
      // rows), so an embedded "\n" inside a single row desyncs the viewport
      // math (sticky-bottom drift, clipped tail). "> " marks the first row;
      // "  " aligns continuations under it, mirroring the InputBox's own
      // prompt rows. Only the first row carries the role marker — { / }
      // prompt jumps target the turn head, not its tail.
      const rows = item.text.split("\n");
      return rows.map((l, i) =>
        i === 0
          ? { text: `> ${l}`, dim: true, role: "user" as const }
          : { text: `  ${l}`, dim: true },
      );
    }
    case "assistant": {
      // Official: plain assistant text carries NO bullet (⏺ belongs to tool
      // calls); rows render unindented at full width.
      const md = renderMarkdown(item.text).split("\n");
      return md.map((l) => ({ text: l, color: palette.text }));
    }
    case "thought":
      return [{ text: `  ${t("ui.thinking.thoughtFor", { s: item.seconds })}`, dim: true }];
    case "thinking_text": {
      const lines = item.text.split("\n");
      // D6 (ctrl+e): the collapsed side folds thinking to one-liners even in
      // verbose mode — tool output stays full either way.
      if (verbose && !opts.collapseThinking) {
        // Transcript viewer: the full reasoning text.
        return lines.map((l) => ({ text: `  ${l}`, dim: true }));
      }
      // P0-2: collapsed to one line; the full text lives in the viewer.
      return [{ text: `  ${collapsedThinkingLine(item.seconds, lines.length)}`, dim: true }];
    }
    case "notice":
      return [{ text: item.text, dim: true }];
    case "compact": {
      // Official CompactSummary rows for the flat-line pagers.
      const rows: TranscriptLine[] = [{ text: `${BLACK_CIRCLE} ${t("ui.compact.title")}` }];
      if (item.messages !== undefined)
        rows.push({
          text: `  ${TOOL_RESULT}  ${t("ui.compact.messages", { n: item.messages })}`,
          dim: true,
        });
      rows.push({
        text: `  ${TOOL_RESULT}  ${t("ui.compact.context", { snippet: truncate(item.summary, 120) })}`,
        dim: true,
      });
      return rows;
    }
    case "log":
      return item.lines.map((l) => ({ text: l }));
    case "tool": {
      const r = item.result;
      if (!r) return [];
      // Official head: `⏺ Name(detail)` — the head carries no accent tint
      // (the glyph's own success/error color is the signal).
      const dot = chalk.hex(r.error ? palette.error : palette.success)(BLACK_CIRCLE);
      const head = `${dot} ${capitalize(r.toolName)}${item.detail ? `(${truncate(item.detail, 100)})` : ""}`;
      if (r.error)
        return [{ text: head }, { text: `  ${TOOL_RESULT}  ${r.error}`, color: palette.error }];
      const all = toolOutputLines(r, item.detail);
      // P0-1: verbose mode (transcript viewer) shows everything; the compact
      // mode keeps the preview window.
      const limit = verbose ? Number.POSITIVE_INFINITY : PREVIEW_LINES;
      const isLong = all.length > limit;
      const shown = isLong ? all.slice(0, limit) : all;
      // Official branch geometry: two spaces + ⎿ + two spaces on the first
      // body row; continuation rows align under the content column (4 spaces).
      const body: TranscriptLine[] = shown.map((l, i) => ({
        text: i === 0 ? `  ${TOOL_RESULT}  ${l}` : `    ${l}`,
        color: palette.text,
      }));
      if (isLong)
        body.push({
          text: `    ${t("ui.tool.expandMoreShort", { n: all.length - limit })}`,
          dim: true,
        });
      return [{ text: head }, ...body];
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
    out.push(...itemLines(item, verbose, opts));
    if (item.kind === "assistant" || item.kind === "tool") out.push({ text: "" });
  }
  if (streamingThinking.trim()) {
    out.push(...streamingThinking.split("\n").map((l) => ({ text: `  ${l}`, dim: true })));
  }
  if (streamingText.trim()) {
    // Plain assistant text — no bullet (official rendering).
    const md = renderMarkdown(streamingText).split("\n");
    out.push(...md.map((l) => ({ text: l, color: palette.text })));
  }
  return out;
}
