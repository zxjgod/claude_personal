import chalk from "chalk";
import type { ToolExecutionResult } from "../types.js";
import { highlightCode } from "./markdown.js";
import { sanitizeTerminalText, terminalColumns, visualWidth } from "./terminal-width.js";
import { palette } from "./theme.js";

export function toolOutputLines(result: ToolExecutionResult, detail = ""): string[] {
  // Edit results carry an absolute line number per changed line — render the
  // gutter, matching the Write preview below. Falls through to the plain diff
  // path when the metadata is absent (older sessions, replayed history).
  const diffLines = result.result?.metadata?.diffLines;
  if (diffLines && diffLines.length > 0) {
    const language = languageForPath(detail);
    // Grows past 4 only beyond line 9999 — wide enough for the largest row
    // number so every row keeps the same column count.
    const gutter = Math.max(GUTTER, ...diffLines.map((d) => String(d.line).length));
    return diffLines.map((d) => renderNumberedDiffLine(d, language, gutter));
  }
  const preview = result.result?.metadata?.codePreview;
  if (preview) {
    const code = highlightCode(preview.text, languageForPath(preview.filePath)).split("\n");
    const lines = [
      // The path is model-controlled (Write's filePath) and lands unstyled in
      // the line below — sanitize it like every other untrusted string.
      `${preview.totalLines} lines written to ${sanitizeTerminalText(preview.filePath)}`,
      ...code.map((line, i) => `${chalk.hex(palette.muted)(String(i + 1).padStart(4))} ${line}`),
    ];
    const omitted = preview.totalLines - code.length;
    if (omitted > 0) lines.push(chalk.hex(palette.muted)(`... +${omitted} lines`));
    if (preview.truncated) lines.push(chalk.hex(palette.muted)("... preview truncated"));
    return lines;
  }
  const language = languageForPath(detail);
  const isDiff = ["edit", "multi_edit", "multiedit"].includes(result.toolName.toLowerCase());
  return result.formatted.split("\n").map((rawLine) => {
    // Untrusted tool output — strip terminal control sequences (OSC52
    // clipboard writes, cursor moves, ...) before we add our own styling.
    const line = sanitizeTerminalText(rawLine);
    if (isDiff && /^[+-] /.test(line)) return renderDiffLine(line, language);
    if (line.startsWith("Error:")) return chalk.hex(palette.error)(line);
    return chalk.hex(palette.text)(line);
  });
}

export function languageForPath(filePath: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase() ?? "";
  return (
    (
      { tsx: "typescript", jsx: "javascript", ps1: "powershell", jsonc: "json" } as Record<
        string,
        string
      >
    )[extension] ?? extension
  );
}

/** Width of the line-number gutter, matching the Write preview's 4 columns. */
const GUTTER = 4;

/**
 * One changed line of an Edit result with its file line number in the gutter —
 * `padStart(4)` so the digits line up with the Write preview's numbering.
 */
export function renderNumberedDiffLine(
  d: { sign: "-" | "+"; text: string; line: number },
  language = "",
  gutterWidth = GUTTER,
): string {
  const added = d.sign === "+";
  const foreground = added ? palette.success : palette.error;
  const background = added ? palette.diffAddedBg : palette.diffRemovedBg;
  const gutter = chalk.hex(palette.muted)(String(d.line).padStart(gutterWidth));
  const rendered = `${gutter} ${chalk.hex(foreground)(sanitizeTerminalText(d.sign))} ${highlightCode(sanitizeTerminalText(d.text), language)}`;
  const width = Math.max(1, terminalColumns() - (gutterWidth + 1));
  return chalk.bgHex(background)(rendered + " ".repeat(Math.max(0, width - visualWidth(rendered))));
}

export function renderDiffLine(line: string, language = ""): string {
  const added = line.startsWith("+");
  const foreground = added ? palette.success : palette.error;
  const background = added ? palette.diffAddedBg : palette.diffRemovedBg;
  // stripAnsi() leaves ST-terminated OSC (…ESC\ ) and private CSI intact, so
  // use the full sanitizer before the text reaches highlightCode.
  const source = sanitizeTerminalText(line.slice(2));
  const rendered = chalk.hex(foreground)(line.slice(0, 2)) + highlightCode(source, language);
  const width = Math.max(1, terminalColumns() - 5);
  return chalk.bgHex(background)(rendered + " ".repeat(Math.max(0, width - visualWidth(rendered))));
}

/** #33: max diff-preview lines shown in the permission dialog before folding
 *  into a "…N more lines" notice. Shared by the builder below and the
 *  PermissionPrompt renderer so both agree on the cap. */
export const DIFF_PREVIEW_MAX = 20;

/**
 * Build a permission-dialog diff preview straight from the tool INPUT (#33) —
 * no disk reads, so the prompt stays instant and can't be fooled by
 * concurrent edits. Covers the edit family (edit / multi_edit / write);
 * returns undefined for anything else. Output stays within DIFF_PREVIEW_MAX
 * entries: on overflow the last entry is a plain-text fold notice carrying
 * the true remaining-line count.
 */
export function buildPermissionDiff(
  toolName: string,
  input?: Record<string, unknown>,
): string[] | undefined {
  if (!input) return undefined;
  const name = toolName.toLowerCase();
  const filePath = typeof input.filePath === "string" ? input.filePath : "";
  const language = languageForPath(filePath);
  const raw: string[] = [];
  const pushBlock = (removed: unknown, added: unknown) => {
    // Empty strings are skipped so an all-empty input yields no preview at
    // all (the edit schema rejects empty old_string upstream anyway).
    if (typeof removed === "string" && removed.length > 0) {
      for (const line of removed.split("\n")) raw.push(`- ${line}`);
    }
    if (typeof added === "string" && added.length > 0) {
      for (const line of added.split("\n")) raw.push(`+ ${line}`);
    }
  };
  if (name === "edit") {
    pushBlock(input.old_string, input.new_string);
  } else if (name === "multi_edit" || name === "multiedit") {
    if (!Array.isArray(input.edits)) return undefined;
    for (const edit of input.edits) {
      if (edit && typeof edit === "object") {
        const e = edit as Record<string, unknown>;
        pushBlock(e.old_string, e.new_string);
      }
    }
  } else if (name === "write") {
    pushBlock(undefined, input.content);
  } else {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  const overflows = raw.length > DIFF_PREVIEW_MAX;
  const shown = raw.slice(0, overflows ? DIFF_PREVIEW_MAX - 1 : DIFF_PREVIEW_MAX);
  const lines = shown.map((line) => renderDiffLine(line, language));
  if (overflows) lines.push(`  … ${raw.length - shown.length} more lines`);
  return lines;
}
