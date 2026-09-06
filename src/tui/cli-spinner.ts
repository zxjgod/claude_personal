// ============================================================
// CLI Spinner — animated "thinking" status line
// ============================================================
// A no-React reimplementation of Claude Code's SpinnerWithVerb /
// SpinnerAnimationRow for the line-based CLI path. Renders a single in-place
// line of the form:
//
//   ✶ Whisking… (16s · ↑ 144 tokens)
//
// with a cycling spinner glyph, a colour-shimmer sweeping across the verb,
// elapsed seconds, and an estimated token count. The whole line is redrawn
// in place via \r + erase-to-EOL, so it never scrolls the terminal.
//
// The pure primitives (verbs, frames, colours, shimmer maths, formatters) live
// in `spinner-core.ts` and are shared with the Ink TUI status line; this file
// is the line-CLI renderer on top of them.
// ============================================================

import chalk from "chalk";
import {
  CLAUDE_ORANGE,
  CLAUDE_SHIMMER,
  computeGlimmerIndex,
  computeShimmerSegments,
  FRAME_MS,
  formatDuration,
  formatTokens,
  GLYPH_FRAME_MS,
  isReducedMotion,
  SHIMMER_INTERVAL_MS,
  SPINNER_FRAMES,
  SPINNER_VERBS,
  TEARDROP_ASTERISK,
  UP_ARROW,
  verbForTurn,
} from "./spinner-core.js";
import { terminalColumns, visualWidth } from "./terminal-width.js";

// Re-export the shared primitives so existing importers of `cli-spinner.js`
// (and its tests) keep working unchanged.
export { computeGlimmerIndex, computeShimmerSegments, formatDuration, formatTokens, SPINNER_VERBS };

// Show the timer/token suffix immediately (the reference gates it behind ~30s /
// verbose; we always show it so the elapsed clock is visible from the start).
const SHOW_SUFFIX_AFTER_MS = 0;

export type SpinnerMode = "thinking" | "tool" | "responding";

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
  private tokens = 0;
  private reducedMotion: boolean;
  private out: NodeJS.WriteStream;
  private active = false;

  constructor(opts: SpinnerOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.reducedMotion = opts.reducedMotion ?? (isReducedMotion() || !this.out.isTTY);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Begin animating. The verb is sampled ONCE per start (seeded by the turn's
   *  start time via verbForTurn) and held for the whole operation — the same
   *  official mount-once semantics the Ink StatusLine shows. */
  start(): void {
    if (this.active) return;
    // No-op on non-TTY: the caller prints plain status instead.
    if (!this.out.isTTY) return;
    this.active = true;
    this.startedAt = Date.now();
    this.elapsedBase = 0;
    this.tokens = 0;
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

  // NOTE: the mode is currently not reflected in the rendered output (the
  // write-only `mode` field was removed as dead state); kept as a no-op so
  // callers compiling against this API keep working.
  setMode(_mode: SpinnerMode): void {}

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
    const frame = Math.floor(elapsedMs / GLYPH_FRAME_MS) % SPINNER_FRAMES.length;
    const glyphChar = this.reducedMotion ? TEARDROP_ASTERISK : SPINNER_FRAMES[frame]!;
    const glyph = chalk.rgb(CLAUDE_ORANGE.r, CLAUDE_ORANGE.g, CLAUDE_ORANGE.b)(glyphChar);

    // Official semantics: ONE verb sampled per spinner mount (seeded by the
    // turn start — deterministic, not re-rolled per frame).
    const message = `${verbForTurn(this.startedAt)}…`;
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
    const suffix = parts.length > 0 ? chalk.dim(` (${parts.join(" · ")})`) : "";

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
    const hot = chalk.rgb(CLAUDE_SHIMMER.r, CLAUDE_SHIMMER.g, CLAUDE_SHIMMER.b);
    return base(before) + hot(shimmer) + base(after);
  }
}
