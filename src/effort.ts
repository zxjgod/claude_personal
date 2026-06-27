// ============================================================
// Reasoning Effort — the /effort tiers (mirrors Claude Code)
// ============================================================
// Claude Code exposes a reasoning-effort slider that trades speed for depth:
//   low → medium → high → xhigh → max   (Faster ──▶ Smarter)
// plus a separate "ultracode" tier == xhigh reasoning + workflows.
//
// The tier is stored on `modelConfig.options.effort` and consumed by the
// provider adapters: the native Anthropic path passes it through as
// `output_config.effort`; OpenAI-compatible reasoning models map it to
// `reasoning_effort` (clamped to the values that API accepts).
// ============================================================

import chalk from "chalk";

/** Ordered effort tiers, low (fastest) → max (smartest). */
export const EFFORT_GRADIENT = ["low", "medium", "high", "xhigh", "max"] as const;

/** All selectable tiers, including the special `ultracode`. */
export const EFFORT_LEVELS = [...EFFORT_GRADIENT, "ultracode"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Claude Code's default sits at `high`. */
export const DEFAULT_EFFORT: EffortLevel = "high";

/** One-line description per tier, mirroring the Claude Code slider semantics. */
export const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Fastest responses, minimal reasoning",
  medium: "Balanced speed and reasoning",
  high: "Thorough reasoning (default)",
  xhigh: "Extra reasoning for hard problems",
  max: "Maximum reasoning, slowest",
  ultracode: "xhigh + workflows (prefer multi-agent orchestration)",
};

/** Narrow an arbitrary string to a valid tier, or null if unrecognized. */
export function parseEffort(value: string): EffortLevel | null {
  const v = value.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : null;
}

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

/** Read the active tier off a config's options bag (falls back to default). */
export function getEffort(options?: Record<string, unknown>): EffortLevel {
  const raw = options?.effort;
  return typeof raw === "string" && parseEffort(raw) ? (raw as EffortLevel) : DEFAULT_EFFORT;
}

/**
 * Map a tier to the native Anthropic `output_config.effort` value. The opus
 * models accept the full gradient; `ultracode` maps to `xhigh` per its
 * definition ("xhigh + workflows" — the workflow part is behavioral).
 */
export function anthropicEffort(effort: EffortLevel): string {
  return effort === "ultracode" ? "xhigh" : effort;
}

/**
 * Map a tier to an OpenAI-compatible `reasoning_effort`. That API only accepts
 * low/medium/high, so everything at or above `high` clamps to `high`.
 */
export function openaiReasoningEffort(effort: EffortLevel): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

/**
 * Heuristic: does this model honor `reasoning_effort`? Only reasoning-capable
 * models do; sending it to a plain chat model can 400 on strict providers.
 */
export function modelSupportsReasoningEffort(provider: string, model: string): boolean {
  if (provider === "openai") {
    return /^(o\d|gpt-5|gpt-4\.\d-?(o|reason))/i.test(model) || /reason|think/i.test(model);
  }
  // DeepSeek reasoner, Qwen/GLM thinking variants, etc.
  return /reason|think|r1|qwq/i.test(model);
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
