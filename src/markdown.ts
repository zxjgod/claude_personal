// ============================================================
// Markdown renderer — marked lexer → ANSI terminal output
// ============================================================
// Renders a complete markdown block to coloured terminal text. Bold/italic
// markers are consumed (so "**" never leaks), inline code and headings are
// coloured, lists get bullet/number prefixes, and tables are drawn with
// box-drawing borders.
//
// Reference: claude test/src/src/utils/markdown.ts (formatToken) and
// claude test/src/src/components/MarkdownTable.tsx.
// ============================================================

import chalk from "chalk";
import { marked, type Token, type Tokens } from "marked";
import { padAligned, stripAnsi, terminalColumns, visualWidth } from "./terminal-width.js";

const EOL = "\n";

// --- Table rendering (ported from MarkdownTable.tsx) ---

const SAFETY_MARGIN = 4;
const MIN_COLUMN_WIDTH = 3;
const MAX_ROW_LINES = 4;

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.trimEnd().split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const word of words) {
    const w = visualWidth(word);
    if (currentWidth + w > width && current.trim().length > 0) {
      lines.push(current.trimEnd());
      current = "";
      currentWidth = 0;
    }
    // Hard-break a single word longer than the column.
    if (w > width && /^\S+$/.test(word)) {
      let chunk = word;
      while (visualWidth(chunk) > width) {
        // Approximate: slice by characters (good enough for narrow columns).
        let take = "";
        for (const ch of chunk) {
          if (visualWidth(take + ch) > width) break;
          take += ch;
        }
        lines.push(take);
        chunk = chunk.slice(take.length);
      }
      current = chunk;
      currentWidth = visualWidth(chunk);
      continue;
    }
    current += word;
    currentWidth += w;
  }
  if (current.trim().length > 0 || lines.length === 0) {
    lines.push(current.trimEnd());
  }
  return lines.filter((l, i) => l.length > 0 || i === 0);
}

function renderTable(token: Tokens.Table): string {
  const terminalWidth = terminalColumns();

  const formatCell = (tokens: Token[] | undefined): string =>
    tokens?.map((t) => formatToken(t)).join("") ?? "";
  const plainText = (tokens: Token[] | undefined): string => stripAnsi(formatCell(tokens));
  const minWidthOf = (tokens: Token[] | undefined): number => {
    const words = plainText(tokens)
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (words.length === 0) return MIN_COLUMN_WIDTH;
    return Math.max(...words.map((w) => visualWidth(w)), MIN_COLUMN_WIDTH);
  };
  const idealWidthOf = (tokens: Token[] | undefined): number =>
    Math.max(visualWidth(plainText(tokens)), MIN_COLUMN_WIDTH);

  const minWidths = token.header.map((header, col) => {
    let m = minWidthOf(header.tokens);
    for (const row of token.rows) m = Math.max(m, minWidthOf(row[col]?.tokens));
    return m;
  });
  const idealWidths = token.header.map((header, col) => {
    let m = idealWidthOf(header.tokens);
    for (const row of token.rows) m = Math.max(m, idealWidthOf(row[col]?.tokens));
    return m;
  });

  const numCols = token.header.length;
  const borderOverhead = 1 + numCols * 3;
  const availableWidth = Math.max(
    terminalWidth - borderOverhead - SAFETY_MARGIN,
    numCols * MIN_COLUMN_WIDTH,
  );
  const totalMin = minWidths.reduce((s, w) => s + w, 0);
  const totalIdeal = idealWidths.reduce((s, w) => s + w, 0);

  let columnWidths: number[];
  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]!);
    const totalOverflow = overflows.reduce((s, o) => s + o, 0);
    columnWidths = minWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      return min + Math.floor((overflows[i]! / totalOverflow) * extraSpace);
    });
  } else {
    const scale = availableWidth / totalMin;
    columnWidths = minWidths.map((w) => Math.max(Math.floor(w * scale), MIN_COLUMN_WIDTH));
  }

  const rowLines = (cells: Array<{ tokens?: Token[] }>, isHeader: boolean): string[] => {
    const cellLines = cells.map((cell, col) =>
      wrapText(formatCell(cell.tokens), columnWidths[col]!),
    );
    const maxLines = Math.max(...cellLines.map((l) => l.length), 1);
    const offsets = cellLines.map((l) => Math.floor((maxLines - l.length) / 2));
    const result: string[] = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = "│";
      for (let col = 0; col < cells.length; col++) {
        const lines = cellLines[col]!;
        const idx = lineIdx - offsets[col]!;
        let cellText = idx >= 0 && idx < lines.length ? lines[idx]! : "";
        const align = isHeader ? "center" : (token.align?.[col] ?? "left");
        if (isHeader) cellText = chalk.bold.cyan(cellText);
        line += " " + padAligned(cellText, visualWidth(cellText), columnWidths[col]!, align) + " │";
      }
      result.push(line);
    }
    return result;
  };

  const borderLine = (type: "top" | "middle" | "bottom"): string => {
    const [left, mid, cross, right] = {
      top: ["┌", "─", "┬", "┐"],
      middle: ["├", "─", "┼", "┤"],
      bottom: ["└", "─", "┴", "┘"],
    }[type] as [string, string, string, string];
    let line = left;
    columnWidths.forEach((width, col) => {
      line += mid.repeat(width + 2);
      line += col < columnWidths.length - 1 ? cross : right;
    });
    return chalk.dim(line);
  };

  // Vertical (key/value) fallback for extra-narrow terminals.
  const maxRowLines = (() => {
    let m = 1;
    for (let i = 0; i < token.header.length; i++) {
      m = Math.max(m, wrapText(formatCell(token.header[i]!.tokens), columnWidths[i]!).length);
    }
    for (const row of token.rows) {
      for (let i = 0; i < row.length; i++) {
        m = Math.max(m, wrapText(formatCell(row[i]?.tokens), columnWidths[i]!).length);
      }
    }
    return m;
  })();

  const verticalFormat = (): string => {
    const out: string[] = [];
    const headers = token.header.map((h) => plainText(h.tokens));
    const sep = chalk.dim("─".repeat(Math.min(terminalWidth - 1, 40)));
    token.rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) out.push(sep);
      row.forEach((cell, col) => {
        const label = headers[col] || `Column ${col + 1}`;
        const value = formatCell(cell.tokens)
          .trimEnd()
          .replace(/\n+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        out.push(`${chalk.bold(label + ":")} ${value}`);
      });
    });
    return out.join(EOL);
  };

  if (maxRowLines > MAX_ROW_LINES) return verticalFormat();

  const tableLines: string[] = [];
  tableLines.push(borderLine("top"));
  tableLines.push(...rowLines(token.header, true));
  tableLines.push(borderLine("middle"));
  token.rows.forEach((row, rowIndex) => {
    tableLines.push(...rowLines(row, false));
    if (rowIndex < token.rows.length - 1) tableLines.push(borderLine("middle"));
  });
  tableLines.push(borderLine("bottom"));

  const maxLineWidth = Math.max(...tableLines.map((l) => visualWidth(stripAnsi(l))));
  if (maxLineWidth > terminalWidth - SAFETY_MARGIN) return verticalFormat();
  return tableLines.join(EOL);
}

// --- Token formatting (ported subset of formatToken) ---

const inlineCode = chalk.cyan;

function formatToken(
  token: Token,
  listDepth = 0,
  orderedNumber: number | null = null,
  parent: Token | null = null,
): string {
  switch (token.type) {
    case "strong":
      return chalk.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(""));
    case "em":
      return chalk.italic(
        (token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(""),
      );
    case "del":
      return chalk.strikethrough(
        (token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(""),
      );
    case "codespan":
      return inlineCode((token as Tokens.Codespan).text);
    case "code": {
      const code = (token as Tokens.Code).text;
      return (
        code
          .split(EOL)
          .map((l) => chalk.gray(l))
          .join(EOL) + EOL
      );
    }
    case "heading":
      return chalk.bold.cyan((token.tokens ?? []).map((t) => formatToken(t)).join("")) + EOL;
    case "hr":
      return chalk.dim("─".repeat(Math.min(terminalColumns() - 1, 60))) + EOL;
    case "blockquote": {
      const inner = (token.tokens ?? []).map((t) => formatToken(t)).join("");
      const bar = chalk.dim("▎");
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${line}` : line))
        .join(EOL);
    }
    case "list": {
      const list = token as Tokens.List;
      return list.items
        .map((item, index) =>
          formatToken(item, listDepth, list.ordered ? (list.start || 1) + index : null, list),
        )
        .join("");
    }
    case "list_item": {
      const indent = "  ".repeat(listDepth);
      const marker = orderedNumber === null ? chalk.dim("-") : chalk.dim(`${orderedNumber}.`);
      const inner = (token.tokens ?? [])
        .map((t) => formatToken(t, listDepth + 1, orderedNumber, token))
        .join("")
        .trimEnd();
      return `${indent}${marker} ${inner}${EOL}`;
    }
    case "paragraph":
      return (token.tokens ?? []).map((t) => formatToken(t, 0, null, token)).join("") + EOL;
    case "text": {
      const txt = token as Tokens.Text;
      if (txt.tokens && txt.tokens.length > 0) {
        return txt.tokens.map((t) => formatToken(t, listDepth, orderedNumber, parent)).join("");
      }
      return txt.text;
    }
    case "link": {
      const link = token as Tokens.Link;
      const text = (link.tokens ?? []).map((t) => formatToken(t)).join("");
      return chalk.cyan(text || link.href);
    }
    case "table":
      return renderTable(token as Tokens.Table) + EOL;
    case "space":
      return EOL;
    case "br":
      return EOL;
    case "escape":
      return (token as Tokens.Escape).text;
    case "html":
      return (token as Tokens.HTML).text;
    default:
      // Fall back to the raw text for any unhandled token type.
      return "raw" in token && typeof (token as { raw?: unknown }).raw === "string"
        ? (token as { raw: string }).raw
        : "";
  }
}

/**
 * Render a complete markdown block (one or more lines) to ANSI text.
 * Bold/italic markers are consumed; tables get box borders.
 */
export function renderMarkdown(content: string): string {
  const tokens = marked.lexer(content);
  return tokens
    .map((t) => formatToken(t))
    .join("")
    .replace(/\n+$/, "");
}

// Exported for tests.
export { formatToken, renderTable };
