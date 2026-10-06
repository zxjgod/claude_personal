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
import {
  graphemes,
  sanitizeTerminalText,
  terminalColumns,
  truncateVisual,
  visualWidth,
} from "./terminal-width.js";
import { currentTheme, palette } from "./theme.js";
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
  backgroundColor?: string;
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

/** Physical, padded rows shared by the transcript and the history viewer. */
export function userMessageLines(
  item: Extract<TranscriptItem, { kind: "user" }>,
): TranscriptLine[] {
  const width = Math.max(3, terminalColumns() - 1);
  const marker = item.bash ? "! " : item.memory ? "# " : "> ";
  const rows: string[] = [];
  for (const line of sanitizeTerminalText(item.text).split("\n")) {
    let row = rows.length === 0 ? marker : "  ";
    let cells = 2;
    for (const glyph of graphemes(line.replace(/\t/g, "    "))) {
      if (cells + glyph.width > width) {
        rows.push(row);
        row = "  ";
        cells = 2;
      }
      row += glyph.segment;
      cells += glyph.width;
    }
    rows.push(row);
  }
  return rows.map((text, i) => ({
    text: text + " ".repeat(Math.max(0, width - visualWidth(text))),
    color: palette.userText,
    backgroundColor: palette.userBackground,
    ...(i === 0 ? { role: "user" as const } : {}),
  }));
}

/** One transcript item → its display rows. */
function itemLines(
  item: TranscriptItem,
  verbose: boolean,
  opts: TranscriptRenderOptions,
): TranscriptLine[] {
  switch (item.kind) {
    case "user":
      return userMessageLines(item);
    case "assistant": {
      const md = renderMarkdown(item.text).split("\n");
      return md.map((l, i) => ({
        text: `${i === 0 ? `${BLACK_CIRCLE} ` : "  "}${l}`,
        color: palette.text,
      }));
    }
    case "thought":
      return [{ text: `  ${t("ui.thinking.thoughtFor", { s: item.seconds })}`, dim: true }];
    case "thinking_text": {
      const lines = item.text.split("\n");
      // D6 (ctrl+e): the collapsed side folds thinking to one-liners even in
      // verbose mode — tool output stays full either way. The reasoning text is
      // model-authored and skips renderMarkdown, so sanitize it here.
      if (verbose && !opts.collapseThinking) {
        // Transcript viewer: the full reasoning text.
        return lines.map((l) => ({ text: `  ${sanitizeTerminalText(l)}`, dim: true }));
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
      // Tool name (server-controlled for MCP) and the detail argument are
      // model-controlled; the error body is raw tool output. None of them pass
      // through renderMarkdown, so sanitize here.
      const head = `${dot} ${capitalize(sanitizeTerminalText(r.toolName))}${
        item.detail ? `(${truncate(sanitizeTerminalText(item.detail), 100)})` : ""
      }`;
      if (r.error)
        return [
          { text: head },
          { text: `  ${TOOL_RESULT}  ${sanitizeTerminalText(r.error)}`, color: palette.error },
        ];
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
 * #34 item-level render cache: transcript items are immutable once pushed
 * (the store is append-only), so a committed item's rendered rows can never
 * change except with the render options or the active theme. Keying a
 * WeakMap by item identity turns "re-flatten ALL history on every append"
 * (O(N²) markdown renders over a session) into O(new items) per update.
 * The theme name is part of the variant key so /theme invalidates naturally;
 * entries die with their items (WeakMap), no manual eviction needed.
 * The terminal WIDTH is part of the key too (fourth-round review): rendered
 * rows are width-dependent (markdown tables and diff background fill size
 * themselves to terminalColumns()), so a resize used to freeze the whole
 * committed history at the old width — overflowing backgrounds, viewport
 * desync — with no way for old entries to ever re-render.
 */
const ITEM_LINES_CACHE = new WeakMap<TranscriptItem, Map<string, TranscriptLine[]>>();

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
  const variant = `${verbose ? 1 : 0}|${opts.collapseThinking ? 1 : 0}|${currentTheme()}|${terminalColumns()}`;
  const out: TranscriptLine[] = [];
  for (const item of transcript) {
    let variants = ITEM_LINES_CACHE.get(item);
    if (!variants) {
      variants = new Map();
      ITEM_LINES_CACHE.set(item, variants);
    }
    let rows = variants.get(variant);
    if (!rows) {
      rows = itemLines(item, verbose, opts);
      variants.set(variant, rows);
    }
    out.push(...rows);
    if (["user", "assistant", "tool", "thought", "thinking_text"].includes(item.kind))
      out.push({ text: "" });
  }
  if (streamingThinking.trim()) {
    out.push(
      ...streamingThinking
        .split("\n")
        .map((l) => ({ text: `  ${sanitizeTerminalText(l)}`, dim: true })),
    );
  }
  if (streamingText.trim()) {
    const md = renderMarkdown(streamingText).split("\n");
    out.push(
      ...md.map((l, i) => ({
        text: `${i === 0 ? `${BLACK_CIRCLE} ` : "  "}${l}`,
        color: palette.text,
      })),
    );
  }
  return out;
}
