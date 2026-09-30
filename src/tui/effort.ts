// ============================================================
// Effort — TUI rendering for the /effort slider
// ------------------------------------------------------------
// PRESENTATION LAYER. The tier DEFINITIONS and strategy logic live
// in the kernel module (src/effort.ts) — the agent loop and both
// provider adapters import from there, so core no longer depends on
// the UI. This file keeps only what actually paints the terminal
// (colors + slider layout) and re-exports the kernel surface for
// existing TUI/command call sites.
//
// Everything below the re-export block is display-only.
// ============================================================

import chalk from "chalk";
import { EFFORT_DESCRIPTIONS, EFFORT_GRADIENT, type EffortLevel } from "../effort.js";

// Re-export the kernel surface so `../tui/effort.js` keeps working for
// commands, tests and TUI components that legitimately want both halves.
export {
  anthropicEffort,
  DEFAULT_EFFORT,
  EFFORT_DEFINITIONS,
  EFFORT_DESCRIPTIONS,
  EFFORT_GRADIENT,
  EFFORT_LEVELS,
  type EffortDefinition,
  type EffortLevel,
  type EffortStrategy,
  effortInstruction,
  effortStrategy,
  getEffort,
  getEffortStrategy,
  modelSupportsReasoningEffort,
  openaiReasoningEffort,
  parseEffort,
  resolveEffortMaxTokens,
  STREAM_SAFE_MAX_OUTPUT_TOKENS,
  withEffortInstruction,
} from "../effort.js";

// --- Color helpers for the interactive slider (TUI) ---

/** Convert HSL (h∈[0,360), s/l∈[0,1]) to a #rrggbb hex string. */
export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Warm gradient color along the slider track: fraction 0 (Faster) is cool
 * cyan, fraction 1 (Smarter) is warm red. Higher effort = warmer.
 */
export function gradientColorAt(fraction: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  return hslToHex(190 - 190 * f, 0.8, 0.6);
}

/**
 * A cycling rainbow palette of `count` colors, shifted by `phase` degrees.
 * Uses the official voice-waveform HSL params (s=0.7, l=0.6) so the max-tier
 * flow matches Claude Code's rainbow. Animating `phase` makes it flow.
 */
export function rainbowColors(count: number, phase = 0): string[] {
  const n = Math.max(1, count);
  return Array.from({ length: count }, (_, i) => hslToHex((i / n) * 360 + phase, 0.7, 0.6));
}

/**
 * Render the effort slider for the `/effort` command, marking the active tier.
 * Faithful to the Claude Code layout: gradient tiers, a `┆` divider, then the
 * special `ultracode` tier with its sub-label.
 */
export function renderEffortSlider(active: EffortLevel): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${chalk.bold("Effort")}`);
  lines.push("");

  const cells = EFFORT_GRADIENT.map((lvl) => {
    const label = lvl === active ? chalk.cyan.bold(lvl) : chalk.gray(lvl);
    return label.padEnd(lvl === active ? 8 : 8);
  });
  const ultra = active === "ultracode" ? chalk.cyan.bold("ultracode") : chalk.gray("ultracode");

  lines.push(`    ${chalk.dim("Faster")}${" ".repeat(28)}${chalk.dim("Smarter")}`);
  lines.push(`    ${cells.join("")}${chalk.dim("┆ ")}${ultra}`);

  // Marker row: a ▲ under the active gradient tier, or under ultracode.
  const markerCells = EFFORT_GRADIENT.map((lvl) => (lvl === active ? "▲" : " ").padEnd(8));
  const ultraMarker = active === "ultracode" ? "▲" : "";
  lines.push(`    ${markerCells.join("")}${chalk.dim("  ")}${ultraMarker}`);

  lines.push("");
  lines.push(`  Current: ${chalk.cyan(active)} — ${chalk.gray(EFFORT_DESCRIPTIONS[active])}`);
  return lines.join("\n");
}
