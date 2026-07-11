// ============================================================
// TUI Startup Banner — Claude mascot + welcome panel
// ============================================================
// Printed once to stdout *before* Ink takes over, so it scrolls into history
// above the live transcript and is never repainted. Faithfully mirrors the
// real Claude Code startup: one rounded box with the title on the top border,
// a centered left column ("Welcome back!", the orange block mascot, model +
// cwd) and a left-aligned right column ("Tips for getting started" +
// "What's new"), split by a vertical rule.
// ============================================================

import * as os from "node:os";
import chalk from "chalk";
import { graphemes, padAligned, terminalColumns, visualWidth } from "./terminal-width.js";

const ORANGE = chalk.rgb(215, 119, 87);
const ORANGE_DIM = chalk.rgb(150, 82, 60);

// The Claude mascot, drawn with Unicode block elements (matches the real CLI).
const MASCOT: string[] = ["▐▛███▜▌", "▝▜█████▛▘", "▘▘ ▝▝"];

export interface BannerInfo {
  version: string;
  model: string;
  provider: string;
  workspaceRoot: string;
}

interface Cell {
  text: string; // possibly ANSI-styled
  width: number; // visual width of the styled text
}

const cell = (text: string, width: number): Cell => ({ text, width });
const plainCell = (text: string): Cell => cell(text, visualWidth(text));

/** Collapse the home-dir prefix to "~" for a compact cwd display. */
function displayCwd(root: string): string {
  const home = os.homedir();
  if (home && root.toLowerCase().startsWith(home.toLowerCase())) {
    return "~" + root.slice(home.length);
  }
  return root;
}

/** Truncate styled text to `max` visual columns, appending "…" if clipped. */
function truncateVisual(text: string, max: number): Cell {
  if (visualWidth(text) <= max) return plainCell(text);
  let out = "";
  let w = 0;
  for (const { segment, width } of graphemes(text)) {
    if (w + width > max - 1) break;
    out += segment;
    w += width;
  }
  return cell(out + "…", w + 1);
}

/** Build the banner as an array of ready-to-print lines. */
export function renderBannerLines(info: BannerInfo): string[] {
  const cols = terminalColumns();
  const inner = Math.max(72, Math.min(cols - 2, 120));

  // Row layout: "│" + " " + leftCol + " │ " + rightCol + " " + "│"
  // So inner = 1 + leftW + 3 + rightW + 1.
  const leftW = Math.max(40, Math.round(inner * 0.42));
  const rightW = inner - leftW - 5;

  // --- Left column (centered) ---
  const modelLine = `${chalk.bold(info.model)} ${chalk.dim("·")} ${chalk.dim(info.provider)}`;
  const modelW = visualWidth(`${info.model} · ${info.provider}`);
  const cwd = displayCwd(info.workspaceRoot);

  const left: Cell[] = [
    cell("", 0),
    plainCell(chalk.bold("Welcome back!")),
    cell("", 0),
    ...MASCOT.map((m) => cell(ORANGE(m), visualWidth(m))),
    cell("", 0),
    cell(modelLine, modelW),
    cell(chalk.dim(truncateVisual(cwd, leftW).text), Math.min(visualWidth(cwd), leftW)),
  ];

  // --- Right column (left-aligned) ---
  const heading = (s: string): Cell => cell(ORANGE.bold(s), visualWidth(s));
  const note = (s: string): Cell => {
    const t = truncateVisual(s, rightW);
    return cell(chalk.dim(t.text), t.width);
  };

  const right: Cell[] = [
    heading("Tips for getting started"),
    note("Ask in natural language, or run /init to set up CLAUDE.md"),
    cell(ORANGE_DIM("─".repeat(rightW)), rightW),
    heading("What's new"),
    note("• Live tool streaming — Reads/Greps appear as they run"),
    note("• Concurrent sub-agent (Task) activity shown inline"),
    note("• Cursor editing in the input box (←/→, Home/End)"),
    note("• / + Enter runs the highlighted command"),
    cell(
      `${chalk.cyan("/release-notes")} ${chalk.dim("for more")}`,
      visualWidth("/release-notes for more"),
    ),
  ];

  // --- Top border with the title embedded ---
  const title = ` ${chalk.bold("Claude Code")} ${chalk.dim("v" + info.version)} `;
  const titleW = visualWidth(title);
  const lead = 3; // "───" before the title, matching the real CLI
  const top =
    ORANGE("╭" + "─".repeat(lead)) +
    title +
    ORANGE("─".repeat(Math.max(0, inner - lead - titleW))) +
    ORANGE("╮");
  const bottom = ORANGE("╰" + "─".repeat(inner) + "╯");

  // --- Assemble rows ---
  const height = Math.max(left.length, right.length);
  const out: string[] = [top];
  for (let i = 0; i < height; i++) {
    const l = left[i] ?? cell("", 0);
    const r = right[i] ?? cell("", 0);
    const lCol = padAligned(l.text, l.width, leftW, "center");
    const rCol = padAligned(r.text, r.width, rightW, "left");
    out.push(boxRow(` ${lCol} ${ORANGE_DIM("│")} ${rCol} `, inner));
  }
  out.push(bottom);
  out.push("");
  return out;
}

/** Print the banner to the given stream (default stdout). */
export function printBanner(info: BannerInfo, out: NodeJS.WriteStream = process.stdout): void {
  out.write(renderBannerLines(info).join("\n") + "\n");
}

/** Wrap a pre-built content string in the box's vertical borders. */
function boxRow(content: string, inner: number): string {
  const pad = Math.max(0, inner - visualWidth(content));
  return ORANGE("│") + content + " ".repeat(pad) + ORANGE("│");
}
