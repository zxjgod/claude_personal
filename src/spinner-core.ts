// ============================================================
// Spinner core — shared spinner primitives (M23.1)
// ============================================================
// The pure, framework-agnostic pieces of Claude Code's working-status spinner:
// the gerund verbs, the particle glyph frames, the Claude-orange/shimmer
// colours, the shimmer-sweep maths, and the duration/token formatters. Both the
// line-based CLI spinner (`cli-spinner.ts`, redraws a single \r line) and the
// Ink TUI (`tui/StatusLine.tsx` + `tui/SpinnerGlyph.tsx`) import from here so
// there is one source of truth for glyphs, timing, and formatting.
//
// No React, no chalk, no stdout — just data + pure functions. Reference:
// claude test/src/src/components/Spinner/* and bridge/bridgeStatusUtil.ts.
// ============================================================

import { graphemes, visualWidth } from "./terminal-width.js";

// --- Verbs -------------------------------------------------------------------

/** A curated subset of the ~190 gerunds in the reference's spinnerVerbs.ts. */
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

export function pickVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

/** How long each thinking verb stays on screen before the next one (ms). */
export const VERB_CYCLE_MS = 3500;

/**
 * Deterministic cycling verb for the thinking status line. Instead of a fixed
 * "Thinking", the label rotates through SPINNER_VERBS every VERB_CYCLE_MS — the
 * playful gerunds ("Cogitating", "Pondering"…) the reference shows while the
 * model works.
 *
 * It's a pure function of elapsed time + a per-turn `seed` (pass the turn start
 * time) rather than random-per-render: the status line re-renders ~12×/s for
 * its clock/shimmer, and re-rolling the verb each of those frames would make it
 * flicker illegibly. Deriving the index from `floor(elapsed / cycle)` keeps the
 * verb stable within its window and advances exactly once per window; the seed
 * mixes in so different turns don't all start on the same word.
 */
export function verbAt(elapsedMs: number, seed = 0): string {
  const step = Math.floor(Math.max(0, elapsedMs) / VERB_CYCLE_MS);
  // Cheap integer hash of (seed, step) → spreads consecutive steps across the
  // list instead of walking it in order (which would look like a slow scroll).
  const mixed = Math.abs(Math.floor(seed / 1000) * 2654435761 + step * 40503);
  return SPINNER_VERBS[mixed % SPINNER_VERBS.length]!;
}

// --- Glyph frames ------------------------------------------------------------

/** Official particle charset (✳ omitted by preference), played forwards then backwards. */
export const BASE_FRAMES = ["·", "✢", "✶", "✻", "✽"];
export const SPINNER_FRAMES = [...BASE_FRAMES, ...[...BASE_FRAMES].reverse()];

export const TEARDROP_ASTERISK = "✻";
export const UP_ARROW = "↑";

/** The glyph advances one frame every 120ms (reference cadence). */
export const GLYPH_FRAME_MS = 120;
/** The line is redrawn (animation tick) ~12.5×/s in the CLI spinner. */
export const FRAME_MS = 80;
/** The shimmer sweep advances one column every 150ms. */
export const SHIMMER_INTERVAL_MS = 150;

/** Particle glyph for a given elapsed time (ms). */
export function glyphAt(elapsedMs: number): string {
  const frame = Math.floor(Math.max(0, elapsedMs) / GLYPH_FRAME_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame]!;
}

// --- Colours -----------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// Claude orange + a lighter shimmer variant (theme.ts: claude / claudeShimmer).
export const CLAUDE_ORANGE: RGB = { r: 215, g: 119, b: 87 };
export const CLAUDE_SHIMMER: RGB = { r: 245, g: 149, b: 117 };

/** Hex forms for Ink's `color` prop. */
export const ORANGE_HEX = "#d77757";
export const SHIMMER_HEX = "#f59575";

/** Status dot colors */
export const STATUS_GREEN = "#9ece6a"; // AI idle / completed - success green
export const STATUS_GRAY = "#666666"; // Tool executing - gray
export const STATUS_GRAY_BRIGHT = "#999999"; // Tool executing flash - lighter gray

// --- Shimmer maths (ported from bridgeStatusUtil.ts) -------------------------

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

// --- Formatting --------------------------------------------------------------

/** Format a duration in ms as the spinner's short form (e.g. "16s", "2m 5s"). */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

/** Format a token count with a k suffix (e.g. 1234 → "1.2k"). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// --- Concrete action labels (M23.3) ------------------------------------------

/** Last path segment (handles both / and \ separators). */
function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function host(url: string): string {
  const m = url.match(/^[a-z]+:\/\/([^/]+)/i);
  return m ? m[1]! : url;
}

function clip(value: string, max = 40): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

/**
 * Turn a tool name + its display detail into a concrete present-continuous
 * status, e.g. ("read", "src/tui/App.tsx") → "Reading App.tsx",
 * ("bash", "npm test") → "Running npm test". Falls back to "Capitalized name"
 * for unknown tools.
 */
export function actionLabel(name: string, detail = ""): string {
  const key = name.toLowerCase();
  const target = detail.trim();
  switch (key) {
    case "read":
      return target ? `Reading ${basename(target)}` : "Reading";
    case "write":
      return target ? `Writing ${basename(target)}` : "Writing";
    case "edit":
    case "notebookedit":
      return target ? `Editing ${basename(target)}` : "Editing";
    case "bash":
      return target ? `Running ${clip(target)}` : "Running";
    case "glob":
    case "grep":
      return target ? `Searching ${clip(target)}` : "Searching";
    case "websearch":
      return target ? `Searching ${clip(target)}` : "Searching";
    case "webfetch":
      return target ? `Fetching ${host(target)}` : "Fetching";
    case "task":
    case "agent":
      return "Delegating";
    default: {
      const cap = key.length === 0 ? key : key[0]!.toUpperCase() + key.slice(1);
      return target ? `${cap} ${clip(basename(target))}` : cap;
    }
  }
}
