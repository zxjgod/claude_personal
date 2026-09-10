import chalk from "chalk";
import type { ToolExecutionResult } from "../types.js";
import { highlightCode } from "./markdown.js";
import { stripAnsi, terminalColumns, visualWidth } from "./terminal-width.js";
import { palette } from "./theme.js";

export function toolOutputLines(result: ToolExecutionResult, detail = ""): string[] {
  const preview = result.result?.metadata?.codePreview;
  if (preview) {
    const code = highlightCode(preview.text, languageForPath(preview.filePath)).split("\n");
    const lines = [
      `${preview.totalLines} lines written to ${preview.filePath}`,
      ...code.map((line, i) => `${chalk.hex(palette.muted)(String(i + 1).padStart(4))} ${line}`),
    ];
    const omitted = preview.totalLines - code.length;
    if (omitted > 0) lines.push(chalk.hex(palette.muted)(`... +${omitted} lines`));
    if (preview.truncated) lines.push(chalk.hex(palette.muted)("... preview truncated"));
    return lines;
  }
  const language = languageForPath(detail);
  const isDiff = ["edit", "multi_edit", "multiedit"].includes(result.toolName.toLowerCase());
  return result.formatted.split("\n").map((line) => {
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

export function renderDiffLine(line: string, language = ""): string {
  const added = line.startsWith("+");
  const foreground = added ? palette.success : palette.error;
  const background = added ? palette.diffAddedBg : palette.diffRemovedBg;
  const source = stripAnsi(line.slice(2));
  const rendered = chalk.hex(foreground)(line.slice(0, 2)) + highlightCode(source, language);
  const width = Math.max(1, terminalColumns() - 5);
  return chalk.bgHex(background)(rendered + " ".repeat(Math.max(0, width - visualWidth(rendered))));
}
