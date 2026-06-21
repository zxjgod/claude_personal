// ============================================================
// effort-fx — frame builder for the /effort slider (M13.7)
// ============================================================
// Pure functions that render one animation frame of the effort slider to an
// array of ANSI strings (via chalk), so EffortPrompt only owns timing + input.
//
// Layout matches the official Claude Code slider: a full-width top divider,
// a left-indented "Effort" title, then a horizontally CENTERED track with a
// ▲ marker, a ┆ divider, and the ultracode tier.
//
// Two signature effects:
//   • max       → rainbow flowing/shimmering track + labels
//   • ultracode → purple energy burst: marker halo, an expanding ring along a
//                 bottom bar, edge glitch jitter, drifting circuit particles,
//                 a low-saturation purple wash, and breathing text glow.
// ============================================================

import chalk from "chalk";
import {
  EFFORT_GRADIENT,
  EFFORT_DESCRIPTIONS,
  gradientColorAt,
  rainbowColors,
  hslToHex,
  type EffortLevel,
} from "./../effort.js";

// --- Track geometry (track-local columns) ---
const GRAD_START = 4;
const STEP = 9;
// Marker column for each gradient tier (low..max).
const GRAD_MARKERS = EFFORT_GRADIENT.map((_, i) => GRAD_START + i * STEP); // 4,13,22,31,40
const DIVIDER_COL = GRAD_MARKERS[GRAD_MARKERS.length - 1]! + 7; // 47
const ULTRA_MARKER = DIVIDER_COL + 7; // 54
const TRACK_WIDTH = ULTRA_MARKER + 9; // 63 (tail past the ultracode label)

const ORDER: EffortLevel[] = [...EFFORT_GRADIENT, "ultracode"];

/** Marker column for a tier in track-local coordinates. */
function markerCol(level: EffortLevel): number {
  const gi = EFFORT_GRADIENT.indexOf(level as any);
  return gi >= 0 ? GRAD_MARKERS[gi]! : ULTRA_MARKER;
}

// --- Styled-cell buffer ---
interface Cell {
  ch: string;
  style?: (s: string) => string;
}
function blank(width: number): Cell[] {
  return Array.from({ length: width }, () => ({ ch: " " }));
}
function place(cells: Cell[], col: number, text: string, style?: (s: string) => string): void {
  for (let i = 0; i < text.length; i++) {
    const c = col + i;
    if (c >= 0 && c < cells.length) cells[c] = { ch: text[i]!, style };
  }
}
function render(cells: Cell[], leftPad: number): string {
  const out = cells.map((c) => (c.style ? c.style(c.ch) : c.ch)).join("");
  return " ".repeat(leftPad) + out;
}

// --- Deterministic per-frame jitter (smooth drift, no chaos) ---
function seeded(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const PARTICLES = ["·", "˙", "°", "*", "✦", "⋆", "•", "∴", "❖"];
const GLITCH = ["▏", "╎", "┊", "░", "▒"];

/** Purple shade that breathes with phase (low-saturation tech glow). */
function purple(phase: number, offset = 0, light = 0.58): string {
  const b = 0.5 + 0.5 * Math.sin((phase + offset) * (Math.PI / 180));
  return hslToHex(272 + 18 * Math.sin(phase / 40), 0.52, light - 0.16 + 0.16 * b);
}

/**
 * Build one frame. `cols` is the terminal width used to center the track.
 * Returns an array of ready-to-print lines (ANSI included).
 */
export function buildEffortFrame(opts: {
  active: EffortLevel;
  phase: number;
  cols: number;
}): string[] {
  const { active, phase, cols } = opts;
  const isMax = active === "max";
  const isUltra = active === "ultracode";
  const leftPad = Math.max(4, Math.floor((cols - TRACK_WIDTH) / 2));
  const lines: string[] = [];

  // Top: full-width divider.
  const divWidth = Math.max(40, Math.min(cols - 1, 124));
  lines.push(isUltra ? chalk.hex(purple(phase, 0, 0.5))("─".repeat(divWidth)) : chalk.dim("─".repeat(divWidth)));

  // Title (left-indented, like the reference).
  const titleGlow = isUltra ? chalk.hex(purple(phase, 90)).bold : chalk.bold.cyan;
  lines.push("  " + titleGlow("Effort"));
  lines.push("");

  // Ultracode: a drifting circuit-particle row above the track.
  if (isUltra) lines.push(particleRow(phase, leftPad, 1));

  // Faster … Smarter ends, aligned to the gradient span.
  const ends = blank(TRACK_WIDTH);
  place(ends, GRAD_START, "Faster", chalk.dim);
  place(ends, DIVIDER_COL - "Smarter".length, "Smarter", chalk.dim);
  lines.push(render(ends, leftPad));

  // Track row.
  lines.push(trackRow(active, phase, leftPad, isMax, isUltra));

  // Labels row.
  lines.push(labelRow(active, phase, leftPad, isMax, isUltra));

  // ultracode sublabel, centered under the ultracode marker.
  const sub = blank(TRACK_WIDTH);
  const subText = "xhigh + workflows";
  place(sub, ULTRA_MARKER - Math.floor(subText.length / 2), subText, isUltra ? chalk.hex(purple(phase, 140)) : chalk.dim);
  lines.push(render(sub, leftPad));

  // Ultracode: expanding ring bar + lower particle row + bottom edge.
  if (isUltra) {
    lines.push("");
    lines.push(ringBar(phase, leftPad));
    lines.push(particleRow(phase + 180, leftPad, 2));
  }

  lines.push("");

  // Description of the active tier.
  const descStyle = isUltra ? chalk.hex(purple(phase, 60)).bold : isMax ? chalk.bold : chalk.bold.cyan;
  lines.push("  " + descStyle(active) + chalk.dim(" — " + EFFORT_DESCRIPTIONS[active]));

  lines.push("  " + chalk.dim("←/→ to adjust · Enter to confirm · Esc to cancel"));
  return lines;
}

// --- Row builders ---

function trackRow(active: EffortLevel, phase: number, leftPad: number, isMax: boolean, isUltra: boolean): string {
  const cells = blank(TRACK_WIDTH);
  const activeCol = markerCol(active);

  for (let c = 0; c < TRACK_WIDTH; c++) {
    if (c === DIVIDER_COL) {
      cells[c] = { ch: "┆", style: isUltra ? chalk.hex(purple(phase, c)) : chalk.dim };
      continue;
    }
    const inGrad = c < DIVIDER_COL;
    const frac = inGrad ? c / (DIVIDER_COL - 1) : (c - DIVIDER_COL) / (TRACK_WIDTH - DIVIDER_COL);
    let style: (s: string) => string;
    if (isUltra) {
      // Whole track washed purple; brighter near the marker (halo).
      const dist = Math.abs(c - ULTRA_MARKER);
      const halo = dist <= 3 ? 0.72 - dist * 0.04 : 0.5;
      style = chalk.hex(purple(phase, c * 6, halo));
    } else if (isMax) {
      const cols = rainbowColors(TRACK_WIDTH, phase);
      style = chalk.hex(cols[c]!);
    } else {
      style = chalk.hex(gradientColorAt(inGrad ? frac : 1));
    }
    cells[c] = { ch: "─", style };
  }

  // Marker ▲ on the active tier (halo ✦ around it for ultracode).
  if (isUltra) {
    place(cells, ULTRA_MARKER - 1, "✦", chalk.hex(purple(phase, 30, 0.78)));
    place(cells, ULTRA_MARKER, "▲", chalk.hex(purple(phase, 0, 0.82)).bold);
    place(cells, ULTRA_MARKER + 1, "✦", chalk.hex(purple(phase, 60, 0.78)));
  } else if (isMax) {
    place(cells, activeCol, "▲", chalk.hex(rainbowColors(TRACK_WIDTH, phase)[activeCol]!).bold);
  } else {
    place(cells, activeCol, "▲", chalk.hex(gradientColorAt(activeCol / (DIVIDER_COL - 1))).bold);
  }
  return render(cells, leftPad);
}

function labelRow(active: EffortLevel, phase: number, leftPad: number, isMax: boolean, isUltra: boolean): string {
  const cells = blank(TRACK_WIDTH);
  EFFORT_GRADIENT.forEach((lvl, i) => {
    const col = GRAD_MARKERS[i]! - Math.floor(lvl.length / 2);
    const on = active === lvl;
    let style: (s: string) => string;
    if (isMax && on) {
      const cols = rainbowColors(lvl.length, phase);
      // Per-character rainbow for the active "max" label.
      for (let k = 0; k < lvl.length; k++) place(cells, col + k, lvl[k]!, chalk.hex(cols[k]!).bold);
      return;
    }
    style = on ? chalk.hex(gradientColorAt(GRAD_MARKERS[i]! / (DIVIDER_COL - 1))).bold : chalk.gray;
    place(cells, col, lvl, style);
  });

  // ultracode label.
  const ul = "ultracode";
  const ucol = ULTRA_MARKER - Math.floor(ul.length / 2);
  if (isUltra) {
    const cols = rainbowColors(ul.length, phase * 1.5); // brisker shimmer
    for (let k = 0; k < ul.length; k++) {
      // Blend rainbow toward purple so it reads as a purple-tech glow.
      const c = k % 2 === 0 ? cols[k]! : purple(phase, k * 30, 0.66);
      place(cells, ucol + k, ul[k]!, chalk.hex(c).bold);
    }
  } else {
    place(cells, ucol, ul, chalk.gray);
  }
  return render(cells, leftPad);
}

/** A drifting row of purple circuit particles around the panel (ultracode). */
function particleRow(phase: number, leftPad: number, band: number): string {
  const width = TRACK_WIDTH;
  const cells = blank(width);
  const count = 10;
  for (let i = 0; i < count; i++) {
    const r = seeded(i * 7.3 + band * 100);
    // Slow horizontal drift with phase; wrap around the width.
    const col = Math.floor((r * width + phase * (0.15 + 0.05 * (i % 3))) % width);
    const twinkle = Math.sin((phase + i * 40) * (Math.PI / 180)) > -0.2;
    if (!twinkle) continue;
    const ch = PARTICLES[Math.floor(seeded(i + band) * PARTICLES.length)]!;
    place(cells, col, ch, chalk.hex(purple(phase, i * 25, 0.5 + 0.2 * r)));
  }
  // Edge glitch jitter at both ends.
  const g = GLITCH[Math.floor(seeded(phase) * GLITCH.length)]!;
  if (seeded(phase + band) > 0.45) place(cells, 0, g, chalk.hex(purple(phase, 0, 0.4)));
  if (seeded(phase + band + 9) > 0.45) place(cells, width - 1, g, chalk.hex(purple(phase, 90, 0.4)));
  return render(cells, leftPad);
}

/** A ring of purple light expanding outward from center along a bottom bar. */
function ringBar(phase: number, leftPad: number): string {
  const width = TRACK_WIDTH;
  const cells = blank(width);
  const center = Math.floor(width / 2);
  const radius = (phase / 6) % (width / 2 + 4); // expands, then resets
  for (let c = 0; c < width; c++) {
    const dist = Math.abs(c - center);
    const onRing = Math.abs(dist - radius) < 1.5;
    const inside = dist < radius;
    if (onRing) {
      cells[c] = { ch: "━", style: chalk.hex(purple(phase, c * 4, 0.8)).bold };
    } else if (inside) {
      cells[c] = { ch: "─", style: chalk.hex(purple(phase, c * 4, 0.46)) };
    } else {
      cells[c] = { ch: "─", style: chalk.hex(purple(phase, c, 0.3)) };
    }
  }
  return render(cells, leftPad);
}

/** Tier order for arrow-key navigation. */
export { ORDER };
