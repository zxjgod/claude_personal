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

import { graphemes, truncateVisual, visualWidth } from "./terminal-width.js";

// --- Verbs -------------------------------------------------------------------

/**
 * The full official verb list (spinnerVerbs.ts, 188 gerunds — extracted from
 * the official 2.1.202 bundle, per user decision 2026-09-06 to carry it over
 * verbatim). The official client SAMPLES ONE verb per spinner mount — no
 * rotation — so a turn shows e.g. "✻ Prestidigitating…" for its whole length.
 */
export const SPINNER_VERBS = [
  "Accomplishing",
  "Actioning",
  "Actualizing",
  "Architecting",
  "Baking",
  "Beaming",
  "Beboppin'",
  "Befuddling",
  "Billowing",
  "Blanching",
  "Bloviating",
  "Boogieing",
  "Boondoggling",
  "Booping",
  "Bootstrapping",
  "Brewing",
  "Bunning",
  "Burrowing",
  "Calculating",
  "Canoodling",
  "Caramelizing",
  "Cascading",
  "Catapulting",
  "Cerebrating",
  "Channeling",
  "Channelling",
  "Choreographing",
  "Churning",
  "Clauding",
  "Coalescing",
  "Cogitating",
  "Combobulating",
  "Composing",
  "Computing",
  "Concocting",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Crystallizing",
  "Cultivating",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Dilly-dallying",
  "Discombobulating",
  "Doing",
  "Doodling",
  "Drizzling",
  "Ebbing",
  "Effecting",
  "Elucidating",
  "Embellishing",
  "Enchanting",
  "Envisioning",
  "Fermenting",
  "Fiddle-faddling",
  "Finagling",
  "Flambéing",
  "Flibbertigibbeting",
  "Flowing",
  "Flummoxing",
  "Fluttering",
  "Forging",
  "Forming",
  "Frolicking",
  "Frosting",
  "Gallivanting",
  "Galloping",
  "Garnishing",
  "Generating",
  "Gesticulating",
  "Germinating",
  "Gitifying",
  "Grooving",
  "Gusting",
  "Harmonizing",
  "Hashing",
  "Hatching",
  "Herding",
  "Honking",
  "Hullaballooing",
  "Hyperspacing",
  "Ideating",
  "Imagining",
  "Improvising",
  "Incubating",
  "Inferring",
  "Infusing",
  "Ionizing",
  "Jitterbugging",
  "Julienning",
  "Kneading",
  "Leavening",
  "Levitating",
  "Lollygagging",
  "Manifesting",
  "Marinating",
  "Meandering",
  "Metamorphosing",
  "Misting",
  "Moonwalking",
  "Moseying",
  "Mulling",
  "Mustering",
  "Musing",
  "Nebulizing",
  "Nesting",
  "Newspapering",
  "Noodling",
  "Nucleating",
  "Orbiting",
  "Orchestrating",
  "Osmosing",
  "Perambulating",
  "Percolating",
  "Perusing",
  "Philosophising",
  "Photosynthesizing",
  "Pollinating",
  "Pondering",
  "Pontificating",
  "Pouncing",
  "Precipitating",
  "Prestidigitating",
  "Processing",
  "Proofing",
  "Propagating",
  "Puttering",
  "Puzzling",
  "Quantumizing",
  "Razzle-dazzling",
  "Razzmatazzing",
  "Recombobulating",
  "Reticulating",
  "Roosting",
  "Ruminating",
  "Sautéing",
  "Scampering",
  "Schlepping",
  "Scurrying",
  "Seasoning",
  "Shenaniganing",
  "Shimmying",
  "Simmering",
  "Skedaddling",
  "Sketching",
  "Slithering",
  "Smooshing",
  "Sock-hopping",
  "Spelunking",
  "Spinning",
  "Sprouting",
  "Stewing",
  "Sublimating",
  "Swirling",
  "Swooping",
  "Symbioting",
  "Synthesizing",
  "Tempering",
  "Thinking",
  "Thundering",
  "Tinkering",
  "Tomfoolering",
  "Topsy-turvying",
  "Transfiguring",
  "Transmuting",
  "Twisting",
  "Undulating",
  "Unfurling",
  "Unravelling",
  "Vibing",
  "Waddling",
  "Wandering",
  "Warping",
  "Whatchamacalliting",
  "Whirlpooling",
  "Whirring",
  "Whisking",
  "Wibbling",
  "Working",
  "Wrangling",
  "Zesting",
  "Zigzagging",
];

export function pickVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

/**
 * The turn's verb — official semantics: sample ONCE per spinner mount and keep
 * it for the whole turn (no cycling). Deterministic from the turn-start seed
 * so re-renders never re-roll it and tests can pin it; different turns still
 * land on different words via the hash.
 */
export function verbForTurn(seed = 0): string {
  const mixed = Math.abs(Math.floor(Math.floor(seed / 1000) * 2654435761) ^ 0x9e3779b9);
  return SPINNER_VERBS[mixed % SPINNER_VERBS.length]!;
}

/**
 * True when decorative animation should be disabled (CCR_REDUCED_MOTION=1).
 * One source of truth for every animated surface — the line-CLI spinner, the
 * Ink StatusLine glyph/shimmer, and the ToolCard status-dot blink — so the
 * preference is honored everywhere, not just where it happened to be checked.
 * (Purely informational updates like the elapsed clock still tick.)
 */
export function isReducedMotion(): boolean {
  return process.env.CCR_REDUCED_MOTION === "1";
}

// --- Glyph frames ------------------------------------------------------------

/**
 * The official particle charset, platform-forked exactly like the official
 * getDefaultCharacters(): darwin plays ✳, every other platform (Windows
 * included) substitutes `*` — ✳ renders poorly off macOS. Ghostty swaps ✽
 * for `*` too (its ✽ glyph sits slightly offset).
 */
export function defaultFrames(): string[] {
  if (process.env.TERM === "xterm-ghostty") return ["·", "✢", "✳", "✶", "✻", "*"];
  return process.platform === "darwin"
    ? ["·", "✢", "✳", "✶", "✻", "✽"]
    : ["·", "✢", "*", "✶", "✻", "✽"];
}

export const BASE_FRAMES = defaultFrames();
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

/** Stall-warning red the official glyph interpolates toward (rgb(171,43,63)). */
export const ERROR_RED: RGB = { r: 171, g: 43, b: 63 };
export const ERROR_RED_HEX = "#ab2b3f";

/** No token for this long ⇒ the glyph starts blending toward ERROR_RED. */
export const STALL_AFTER_MS = 3000;
/** Blend duration from pure orange to pure red once the stall kicks in. */
export const STALL_RAMP_MS = 2000;

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * The glyph color for a spinner that last saw activity `idleMs` ago — official
 * useStalledAnimation: stays claude orange for STALL_AFTER_MS, then ramps to
 * ERROR_RED over STALL_RAMP_MS. Pure so the Ink component stays a thin renderer
 * and the curve is unit-testable.
 */
export function stalledGlyphColor(idleMs: number): string {
  const t = Math.max(0, Math.min(1, (idleMs - STALL_AFTER_MS) / STALL_RAMP_MS));
  if (t === 0) return ORANGE_HEX;
  if (t === 1) return ERROR_RED_HEX;
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  const r = toHex(lerp(CLAUDE_ORANGE.r, ERROR_RED.r, t));
  const g = toHex(lerp(CLAUDE_ORANGE.g, ERROR_RED.g, t));
  const b = toHex(lerp(CLAUDE_ORANGE.b, ERROR_RED.b, t));
  return `#${r}${g}${b}`;
}

/** Status dot colors */
export const STATUS_GREEN = "#4EBA65"; // completed tool - Claude Code dark success green (rgb 78,186,101)
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

// --- Tips (D1) ----------------------------------------------------------------

/** Official-flavored usage tips shown under the spinner after it has been
 *  running a while. ids index the i18n table (`ui.tip.<id>`); zh ships its
 *  own translations so both locales read natively. */
export const SPINNER_TIP_IDS = [
  "queue",
  "rewind",
  "bash",
  "memory",
  "historySearch",
  "editor",
  "todos",
  "transcript",
  "atFiles",
  "stash",
  "help",
  "modelPicker",
  "compact",
  "todoList",
] as const;

/**
 * Pick the next un-shown tip for this session (official tipScheduler flavor,
 * simplified): random among the not-yet-seen ids, null once every tip has
 * played. `shown` is the caller's session set — mutate it in place on
 * success, or use `resetTipRotation` semantics by passing a fresh Set.
 */
export function nextTipId(shown: Set<string>): string | null {
  const pool = SPINNER_TIP_IDS.filter((id) => !shown.has(id));
  if (pool.length === 0) return null;
  const id = pool[Math.floor(Math.random() * pool.length)]!;
  shown.add(id);
  return id;
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
  // P3-15: column-aware so a CJK command/detail clips to real display width.
  return truncateVisual(value, max);
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
