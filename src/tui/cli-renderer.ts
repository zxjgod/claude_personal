// ============================================================
// CLI Renderer — terminal presentation helpers
// ============================================================
// Keeps CLI display logic out of cli.ts: block-buffered markdown output
// (bold/headings/tables rendered, never leaking "**"), tool progress/result
// rendering with ● / ⎿ glyphs, and the bordered permission menu.
//
// Symbols and layout mirror the real Claude Code screenshots in
// `claude code终端操作界面/`.
// ============================================================

import chalk from "chalk";
import type { SubAgentProgress, ToolExecutionResult } from "../types.js";
import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { terminalColumns, truncateVisual, visualWidth } from "./terminal-width.js";
import { toolOutputLines } from "./tool-output.js";
import { toolResultSummary } from "./tool-result-summary.js";

// Windows-safe glyphs (see constants/figures.ts in the reference source).
const BLACK_CIRCLE = "●"; // tool-start bullet (plain assistant text has none)
const BRANCH = "⎿"; // tool-result continuation
const CLAUDE_ORANGE = chalk.rgb(215, 119, 87);

/**
 * Buffers streamed assistant text and renders it as markdown at block
 * boundaries. While a block is still arriving it is held back; on a blank
 * line (paragraph break) or a closed code fence the whole block is rendered
 * through `renderMarkdown`, so "**bold**", headings, and tables never leak.
 */
export class StreamingRenderer {
  private buffer = "";
  private inCodeBlock = false;
  private wroteAnything = false;

  write(delta: string): void {
    this.buffer += delta;
    this.drainCompletedBlocks();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    this.renderBlock(this.buffer);
    this.buffer = "";
    this.inCodeBlock = false;
  }

  /** True once any assistant text has been emitted this turn. */
  get hasOutput(): boolean {
    return this.wroteAnything;
  }

  // Emit any blocks that are fully buffered (terminated by a blank line, or
  // a complete fenced code block). Keeps the trailing partial block buffered.
  private drainCompletedBlocks(): void {
    // Process line-by-line, tracking fence state, flushing on blank-line
    // boundaries that are NOT inside a code fence.
    let nlIndex = this.buffer.indexOf("\n");
    let pending = "";
    while (nlIndex !== -1) {
      const line = this.buffer.slice(0, nlIndex);
      const rest = this.buffer.slice(nlIndex + 1);
      pending += line + "\n";

      if (/^\s*```/.test(line)) {
        this.inCodeBlock = !this.inCodeBlock;
      }

      // A blank line outside a fence ends the current block.
      if (!this.inCodeBlock && line.trim() === "") {
        this.renderBlock(pending);
        pending = "";
      }
      this.buffer = rest;
      nlIndex = this.buffer.indexOf("\n");
    }
    // Re-buffer the unconsumed pending text (a block still in progress).
    this.buffer = pending + this.buffer;
  }

  private renderBlock(text: string): void {
    const trimmed = text.replace(/\n+$/, "");
    if (trimmed.trim() === "") {
      // Preserve paragraph spacing between blocks.
      if (this.wroteAnything) process.stdout.write("\n");
      return;
    }
    // Official: plain assistant text carries NO ● bullet (that glyph belongs
    // to tool calls) — matches the Ink path (transcript-lines.ts).
    process.stdout.write(renderMarkdown(trimmed) + "\n");
    this.wroteAnything = true;
  }
}

// --- Welcome screen ---

export function renderWelcome(info: {
  version: string;
  model: string;
  provider: string;
  workspaceRoot: string;
}): void {
  const width = Math.min(terminalColumns() - 1, 100);
  const title = ` ${CLAUDE_ORANGE("Claude Code Replica")} ${chalk.dim("v" + info.version)} `;
  const titleWidth = visualWidth(title);
  const dashes = Math.max(0, width - 2 - titleWidth);
  const top = CLAUDE_ORANGE("╭─") + title + CLAUDE_ORANGE("─".repeat(dashes)) + CLAUDE_ORANGE("╮");
  const bottom = CLAUDE_ORANGE("╰" + "─".repeat(width - 2) + "╯");

  const rows = [
    chalk.bold("  Welcome back!"),
    "",
    `  ${chalk.dim("Model:")}     ${chalk.cyan(info.model)} ${chalk.dim("(" + info.provider + ")")}`,
    `  ${chalk.dim("Workspace:")} ${chalk.dim(info.workspaceRoot)}`,
    "",
    `  ${chalk.dim("Tips:")} ${chalk.dim("type")} ${chalk.cyan("/")} ${chalk.dim("for commands,")} ${chalk.cyan("@path")} ${chalk.dim("to attach a file")}`,
  ];

  process.stdout.write(top + "\n");
  for (const row of rows) {
    process.stdout.write(welcomeBoxLine(row, width) + "\n");
  }
  process.stdout.write(bottom + "\n");
}

function welcomeBoxLine(content: string, width: number): string {
  const inner = width - 2;
  const pad = Math.max(0, inner - visualWidth(content));
  return CLAUDE_ORANGE("│") + content + " ".repeat(pad) + CLAUDE_ORANGE("│");
}

// --- Tool start / result ---

export function renderToolStart(name: string, input?: Record<string, unknown>): void {
  const detail = formatToolDetail(input);
  const title = detail
    ? `${chalk.bold(capitalize(name))}(${chalk.dim(detail)})`
    : chalk.bold(capitalize(name));
  process.stdout.write(`${CLAUDE_ORANGE(BLACK_CIRCLE)} ${title}\n`);
}

export function renderToolResult(result: ToolExecutionResult): void {
  const duration =
    typeof result.durationMs === "number" ? chalk.dim(` (${result.durationMs}ms)`) : "";

  if (result.error) {
    process.stdout.write(`  ${chalk.red(BRANCH)} ${chalk.red(result.error)}${duration}\n`);
    return;
  }

  // Read/Grep/Glob show a compact summary line ("Read N lines") instead of
  // dumping their raw output; every other tool shows a folded content preview.
  const summary = toolResultSummary(result);
  const rendered = summary ?? renderFormattedToolOutput(toolOutputLines(result).join("\n"));
  if (rendered) {
    process.stdout.write(`  ${chalk.dim(BRANCH)} ${indentContinuation(rendered)}${duration}\n`);
  } else {
    process.stdout.write(`  ${chalk.dim(BRANCH)}${duration}\n`);
  }
}

export function renderSubAgentActivity(event: SubAgentProgress): void {
  const prefix = chalk.dim(`    ${BRANCH} [${event.subagentName}]`);

  if (event.phase === "tool_use") {
    const detail = formatToolDetail(event.input);
    const title = detail
      ? `${chalk.bold(capitalize(event.toolName ?? "tool"))}(${chalk.dim(detail)})`
      : chalk.bold(capitalize(event.toolName ?? "tool"));
    process.stdout.write(`${prefix} ${title}\n`);
    return;
  }

  if (event.phase === "tool_results") {
    for (const result of event.results ?? []) {
      if (result.error) {
        process.stdout.write(
          `${prefix} ${chalk.bold(result.toolName)} ${chalk.red(result.error)}\n`,
        );
      } else {
        const dur =
          typeof result.durationMs === "number" ? chalk.dim(` (${result.durationMs}ms)`) : "";
        process.stdout.write(`${prefix} ${chalk.dim(result.toolName + dur)}\n`);
      }
    }
    return;
  }

  if (event.phase === "done") {
    process.stdout.write(`${prefix} ${chalk.dim("done")}\n`);
  }
}

// --- Permission prompt (text fallback; the interactive menu lives in cli.ts) ---

export function renderPermissionPrompt(
  toolName: string,
  input: Record<string, unknown>,
  riskHint?: string,
): void {
  const width = Math.min(terminalColumns() - 2, 100);
  const top = "┌" + "─".repeat(width - 2) + "┐";
  const bottom = "└" + "─".repeat(width - 2) + "┘";
  // P3-13: title/labels/hint come from i18n so this fallback speaks the same
  // language as the interactive menu and the Ink prompt (follows LANG).
  process.stdout.write("\n" + chalk.yellow(top) + "\n");
  process.stdout.write(boxLine(chalk.bold.yellow(t("ui.permission.title")), width) + "\n");
  process.stdout.write(boxLine("", width) + "\n");

  // Unknown tools: t() echoes the key back — detect that and use the generic
  // "{name} operation" label instead.
  const known = t(`ui.tool.${toolName}`);
  const header = known.startsWith("ui.tool.")
    ? t("ui.tool.fallback", { name: capitalize(toolName) })
    : known;
  process.stdout.write(boxLine("  " + chalk.bold(header), width) + "\n");
  process.stdout.write(boxLine("", width) + "\n");

  const detail = formatToolDetail(input);
  if (detail) {
    process.stdout.write(boxLine("  📄 " + detail, width) + "\n");
  }
  if (riskHint) {
    process.stdout.write(boxLine("", width) + "\n");
    const wrapped = wrapText(riskHint, width - 6);
    for (const line of wrapped) {
      process.stdout.write(boxLine("  " + chalk.yellow("⚠️ " + line), width) + "\n");
    }
  }
  process.stdout.write(chalk.dim(bottom) + "\n");
  process.stdout.write(chalk.dim(`  ${t("ui.permission.textHint")}\n`));
}

// Helper function to wrap text
function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (visualWidth(current + " " + word) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function boxLine(content: string, width: number): string {
  const inner = width - 4;
  const pad = Math.max(0, inner - visualWidth(content));
  return chalk.dim("│ ") + content + " ".repeat(pad) + chalk.dim(" │");
}

// --- Helpers ---

function renderFormattedToolOutput(text: string): string {
  const lines = text.split("\n");
  const MAX_LINES = 12;
  const clipped = lines.slice(0, MAX_LINES);
  const wasClipped = lines.length > MAX_LINES;

  const rendered = clipped.join("\n");

  if (wasClipped) {
    const extra = lines.length - MAX_LINES;
    // No expand affordance here: the line-based REPL has no key handler while
    // a turn runs, so an "(ctrl+r to expand)" hint would be a promise the
    // input loop can't keep (the Ink TUI implements it; this path cannot).
    return rendered + chalk.dim(`\n… +${extra} lines`);
  }
  return rendered;
}

// Indent every line after the first so it lines up under the ⎿ branch.
function indentContinuation(text: string): string {
  const lines = text.split("\n");
  return lines.map((line, i) => (i === 0 ? line : "    " + line)).join("\n");
}

function formatToolDetail(input?: Record<string, unknown>): string {
  if (!input) return "";
  if (typeof input.command === "string") return truncate(input.command, 120);
  if (typeof input.filePath === "string") return truncate(input.filePath, 120);
  if (typeof input.pattern === "string") return truncate(input.pattern, 120);
  if (typeof input.url === "string") return truncate(input.url, 120);
  return "";
}

function truncate(value: string, max: number): string {
  // P3-15: column-aware truncation (CJK paths/commands measured in display
  // columns — see truncateVisual).
  return truncateVisual(value, max);
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}
