// ============================================================
// CLI Spinner — animated "thinking" status line
// ============================================================
// A no-React reimplementation of Claude Code's SpinnerWithVerb /
// SpinnerAnimationRow. Renders a single in-place line of the form:
//
//   ✶ Whisking… (16s · ↑ 144 tokens)
//
// with a cycling spinner glyph, a colour-shimmer sweeping across the verb,
// elapsed seconds, and an estimated token count. The whole line is redrawn
// in place via \r + erase-to-EOL, so it never scrolls the terminal.
//
// Reference: claude test/src/src/components/Spinner/* and
// claude test/src/src/bridge/bridgeStatusUtil.ts (shimmer maths).
// ============================================================

import chalk from "chalk";
import { graphemes, visualWidth, terminalColumns } from "./terminal-width.js";

// --- Constants (mirrored from the reference implementation) ---

// A curated subset of the ~190 gerunds in spinnerVerbs.ts.
export const SPINNER_VERBS = [
  "Accomplishing",
  "Architecting",
  "Baking",
  "Brewing",
  "Calculating",
  "Cerebrating",
  "Churning",
  "Clauding",
  "Cogitating",
  "Computing",
  "Concocting",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Crunching",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Distilling",
  "Forging",
  "Generating",
  "Herding",
  "Ideating",
  "Imagining",
  "Incubating",
  "Inferring",
  "Manifesting",
  "Marinating",
  "Mulling",
  "Musing",
  "Noodling",
  "Percolating",
  "Pondering",
  "Processing",
  "Puzzling",
  "Reticulating",
  "Ruminating",
  "Schlepping",
  "Simmering",
  "Sketching",
  "Spelunking",
  "Spinning",
  "Stewing",
  "Swirling",
  "Synthesizing",
  "Thinking",
  "Tinkering",
  "Whisking",
  "Working",
  "Wrangling",
];

// Spinner glyph frames (official particle charset), played forwards then backwards.
const BASE_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...BASE_FRAMES, ...[...BASE_FRAMES].reverse()];

const TEARDROP_ASTERISK = "✻";
const UP_ARROW = "↑";

// Claude orange + a lighter shimmer variant (theme.ts: claude / claudeShimmer).
const CLAUDE_ORANGE: RGB = { r: 215, g: 119, b: 87 };
const CLAUDE_SHIMMER: RGB = { r: 245, g: 149, b: 117 };

const FRAME_MS = 80;
const SHIMMER_INTERVAL_MS = 150;
// Show the timer/token suffix only after the turn has run a little while,
// matching the reference (which gates it behind ~30s / verbose).
const SHOW_SUFFIX_AFTER_MS = 0;

export type SpinnerMode = "thinking" | "tool" | "responding";

interface RGB {
  r: number;
  g: number;
  b: number;
}

// --- Shimmer maths (ported from bridgeStatusUtil.ts) ---

export function computeGlimmerIndex(tick: number, messageWidth: number): number {
  const cycleLength = messageWidth + 20;
  return messageWidth + 10 - (tick % cycleLength);
}

export function computeShimmerSegments(
  text: string,
  glimmerIndex: number,
): { before: string; shimmer: string; after: string } {
  const messageWidth = visualWidth(text);
  const shimmerStart = glimmerIndex - 1;
  const shimmerEnd = glimmerIndex + 1;

  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return { before: text, shimmer: "", after: "" };
  }

  const clampedStart = Math.max(0, shimmerStart);
  let colPos = 0;
  let before = "";
  let shimmer = "";
  let after = "";
  for (const { segment, width } of graphemes(text)) {
    if (colPos + width <= clampedStart) {
      before += segment;
    } else if (colPos > shimmerEnd) {
      after += segment;
    } else {
      shimmer += segment;
    }
    colPos += width;
  }
  return { before, shimmer, after };
}

// --- Formatting helpers ---

/** Format a duration in ms as the spinner's short form (e.g. "16s", "2m 5s"). */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

/** Format a token count with thousands separators (e.g. 1234 → "1.2k"). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function pickVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

// --- Spinner ---

export interface SpinnerOptions {
  /** Force-disable animation (also auto-disabled on non-TTY). */
  reducedMotion?: boolean;
  /** Stream sink (defaults to process.stdout). */
  out?: NodeJS.WriteStream;
}

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private elapsedBase = 0;
  private verb = pickVerb();
  private mode: SpinnerMode = "thinking";
  private tokens = 0;
  private reducedMotion: boolean;
  private out: NodeJS.WriteStream;
  private active = false;

  constructor(opts: SpinnerOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.reducedMotion =
      opts.reducedMotion ??
      (process.env.CCR_REDUCED_MOTION === "1" || !this.out.isTTY);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Begin animating. Picks a fresh verb each turn. */
  start(): void {
    if (this.active) return;
    // No-op on non-TTY: the caller prints plain status instead.
    if (!this.out.isTTY) return;
    this.active = true;
    this.verb = pickVerb();
    this.startedAt = Date.now();
    this.elapsedBase = 0;
    this.tokens = 0;
    this.mode = "thinking";
    this.render(0);
    if (!this.reducedMotion) {
      this.timer = setInterval(() => this.tick(), FRAME_MS);
      // Don't keep the event loop alive solely for the spinner.
      this.timer.unref?.();
    }
  }

  /** Update live token estimate (called as text streams in). */
  update(info: { tokens?: number }): void {
    if (typeof info.tokens === "number") {
      this.tokens = Math.max(this.tokens, info.tokens);
    }
  }

  setMode(mode: SpinnerMode): void {
    this.mode = mode;
  }

  /** Stop animating and erase the line. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.out.isTTY) {
      this.out.write("\r\x1b[K");
    }
  }

  /** Elapsed milliseconds since start. */
  elapsedMs(): number {
    return this.elapsedBase + (this.startedAt ? Date.now() - this.startedAt : 0);
  }

  private tick(): void {
    const t = this.elapsedMs();
    this.render(t);
  }

  private render(elapsedMs: number): void {
    if (!this.out.isTTY) return;
    const frame = Math.floor(elapsedMs / 120) % SPINNER_FRAMES.length;
    const glyphChar = this.reducedMotion
      ? TEARDROP_ASTERISK
      : SPINNER_FRAMES[frame]!;
    const glyph = chalk.rgb(
      CLAUDE_ORANGE.r,
      CLAUDE_ORANGE.g,
      CLAUDE_ORANGE.b,
    )(glyphChar);

    const message = `${this.verb}…`;
    const verbText = this.reducedMotion
      ? chalk.rgb(CLAUDE_ORANGE.r, CLAUDE_ORANGE.g, CLAUDE_ORANGE.b)(message)
      : this.renderShimmer(message, elapsedMs);

    // Suffix: (Ns · ↑ N tokens) — drop parts that don't fit the terminal.
    const parts: string[] = [];
    if (elapsedMs >= SHOW_SUFFIX_AFTER_MS) {
      parts.push(formatDuration(elapsedMs));
      if (this.tokens > 0) {
        parts.push(`${UP_ARROW} ${formatTokens(this.tokens)} tokens`);
      }
    }
    let suffix = parts.length > 0 ? chalk.dim(` (${parts.join(" · ")})`) : "";

    let line = `${glyph} ${verbText}${suffix}`;
    // If the line would overflow, drop the suffix.
    if (visualWidth(line) > terminalColumns() - 1) {
      line = `${glyph} ${verbText}`;
    }
    this.out.write(`\r\x1b[K${line}`);
  }

  private renderShimmer(message: string, elapsedMs: number): string {
    const width = visualWidth(message);
    const tick = Math.floor(elapsedMs / SHIMMER_INTERVAL_MS);
    const glimmer = computeGlimmerIndex(tick, width);
    const { before, shimmer, after } = computeShimmerSegments(message, glimmer);
    const base = chalk.rgb(CLAUDE_ORANGE.r, CLAUDE_ORANGE.g, CLAUDE_ORANGE.b);
    const hot = chalk.rgb(
      CLAUDE_SHIMMER.r,
      CLAUDE_SHIMMER.g,
      CLAUDE_SHIMMER.b,
    );
    return base(before) + hot(shimmer) + base(after);
  }
}
