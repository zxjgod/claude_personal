// ============================================================
// effort-fx — frame builder for the /effort slider (M13.7)
// ============================================================
// Pure functions that render one animation frame to an array of ANSI
// strings (via chalk). EffortPrompt owns only timing + key input.
//
// Layout (identical row count for ALL tiers — no vertical shift):
//   0 divider   1 "Effort"   2 blank   3 Faster…Smarter
//   4 track     5 labels     6 sublabel  7 blank
//   8 description   9 hint
//
// Signature effects:
//   • max       → official rainbow flow (hueToRgb sweep) on track + label
//   • ultracode → full-panel dynamic violet pixel gradient, layered; vertical
//                 block glitch jitter (column strips offset); a soft violet
//                 bloom glow; and a fade-in diffusion when first switched to.
//                 Painted as a BACKGROUND wash over rows 0–7, so no rows are
//                 added and nothing shifts.
// ============================================================

import chalk from "chalk";
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_GRADIENT,
  type EffortLevel,
  gradientColorAt,
  hslToHex,
  rainbowColors,
} from "./../effort.js";

// --- Track geometry (track-local columns) ---
const GRAD_START = 4;
const STEP = 9;
const GRAD_MARKERS = EFFORT_GRADIENT.map((_, i) => GRAD_START + i * STEP); // 4,13,22,31,40
const DIVIDER_COL = GRAD_MARKERS[GRAD_MARKERS.length - 1]! + 7; // 47
const ULTRA_MARKER = DIVIDER_COL + 7; // 54
const TRACK_WIDTH = ULTRA_MARKER + 9; // 63

const ORDER: EffortLevel[] = [...EFFORT_GRADIENT, "ultracode"];

/** Marker column (track-local) for a tier. */
function markerCol(level: EffortLevel): number {
  const gi = EFFORT_GRADIENT.indexOf(level as any);
  return gi >= 0 ? GRAD_MARKERS[gi]! : ULTRA_MARKER;
}

// --- Cell grid ---
interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}
function row(width: number): Cell[] {
  return Array.from({ length: width }, () => ({ ch: " " }));
}
function put(cells: Cell[], col: number, text: string, attrs: Partial<Cell> = {}): void {
  for (let i = 0; i < text.length; i++) {
    const c = col + i;
    if (c >= 0 && c < cells.length) cells[c] = { ch: text[i]!, ...attrs };
  }
}
function paint(cell: Cell): string {
  let c = chalk as any;
  if (cell.bg) c = c.bgHex(cell.bg);
  if (cell.fg) c = c.hex(cell.fg);
  if (cell.bold) c = c.bold;
  if (cell.dim) c = c.dim;
  return c === chalk ? cell.ch : c(cell.ch);
}
function renderRow(cells: Cell[]): string {
  return cells.map(paint).join("");
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Vivid, "heavy" cyber-violet: electric indigo (≈262°) at high saturation so
// the field reads as a rich neon violet rather than a washed grey-purple.
// `light` drives ripple crests/troughs; `hueShift` spreads indigo↔magenta.
function violet(light: number, hueShift = 0): string {
  return hslToHex(262 + hueShift, 0.95, clamp(light, 0.12, 0.62));
}

/** Deterministic [0,1) hash for the glitch jitter (stable within a frame). */
function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Build one frame. `cols` centers the panel in the terminal.
 * `fade` (0→1) is the entrance-diffusion progress for ultracode (1 = settled).
 */
export function buildEffortFrame(opts: {
  active: EffortLevel;
  phase: number;
  cols: number;
  fade?: number;
}): string[] {
  const { active, phase, cols } = opts;
  const fade = clamp(opts.fade ?? 1, 0, 1);
  const isMax = active === "max";
  const isUltra = active === "ultracode";

  const canvasW = Math.min(Math.max(cols - 1, 60), 120);
  const leftPad = Math.max(2, Math.floor((canvasW - TRACK_WIDTH) / 2));
  // Lavender foreground so text stays readable on the purple wash.
  const LAV = "#d8c8ee";

  // Rectangle bounds for the violet field. Left/right go FULL WIDTH (edge to
  // edge). Top starts BELOW the divider white line (row 0), so the field's top
  // edge sits under it; bottom is the blank row before the text.
  const rectL = 0;
  const rectR = canvasW - 1;
  const RECT_TOP = 1;
  const RECT_BOTTOM = 7;

  const grid: Cell[][] = [];
  const newRow = () => {
    const r = row(canvasW);
    grid.push(r);
    return r;
  };

  // 0 — divider (white line). Full width, same dim style for every tier; the
  //     ultracode violet field starts on the row below, so this stays clean.
  const dv = newRow();
  for (let c = 0; c < canvasW; c++) dv[c] = { ch: "─", dim: true };

  // 1 — title.
  const tr = newRow();
  put(tr, 2, "Effort", isUltra ? { fg: "#c9b6ee", bold: true } : { fg: "#36c6e0", bold: true });

  // 2 — blank.
  newRow();

  // 3 — Faster … Smarter, aligned to the track ends.
  const fr = newRow();
  put(fr, leftPad, "Faster", { dim: !isUltra, fg: isUltra ? LAV : undefined });
  put(fr, leftPad + TRACK_WIDTH - "Smarter".length, "Smarter", {
    dim: !isUltra,
    fg: isUltra ? LAV : undefined,
  });

  // 4 — track.
  const trk = newRow();
  const rainbow = isMax ? rainbowColors(TRACK_WIDTH, phase) : null;
  for (let c = 0; c < TRACK_WIDTH; c++) {
    const abs = leftPad + c;
    if (c === DIVIDER_COL) {
      trk[abs] = { ch: "┆", fg: isUltra ? LAV : undefined, dim: !isUltra && !isMax };
      continue;
    }
    const inGrad = c < DIVIDER_COL;
    let fg: string;
    if (isUltra) fg = LAV;
    else if (rainbow) fg = rainbow[c]!;
    else fg = gradientColorAt(inGrad ? c / (DIVIDER_COL - 1) : 1);
    trk[abs] = { ch: "─", fg };
  }
  // Single ▲ marker — identical placement for every tier (no gap).
  const mAbs = leftPad + markerCol(active);
  const mFg = isUltra
    ? "#f1e9ff"
    : rainbow
      ? rainbow[markerCol(active)]!
      : gradientColorAt(markerCol(active) / (DIVIDER_COL - 1));
  trk[mAbs] = { ch: "▲", fg: mFg, bold: true };

  // 5 — labels.
  const lr = newRow();
  EFFORT_GRADIENT.forEach((lvl, i) => {
    const start = leftPad + GRAD_MARKERS[i]! - Math.floor(lvl.length / 2);
    const on = active === lvl;
    if (isMax && on) {
      const cols = rainbowColors(lvl.length, phase);
      for (let k = 0; k < lvl.length; k++)
        put(lr, start + k, lvl[k]!, { fg: cols[k]!, bold: true });
    } else {
      put(
        lr,
        start,
        lvl,
        on
          ? { fg: gradientColorAt(GRAD_MARKERS[i]! / (DIVIDER_COL - 1)), bold: true }
          : { fg: "#808080" },
      );
    }
  });
  const ul = "ultracode";
  const ulStart = leftPad + ULTRA_MARKER - Math.floor(ul.length / 2);
  if (isUltra) {
    put(lr, ulStart, ul, { fg: "#eadcff", bold: true });
  } else {
    put(lr, ulStart, ul, { fg: "#808080" });
  }

  // 6 — sublabel.
  const sr = newRow();
  const sub = "xhigh + workflows";
  put(
    sr,
    leftPad + ULTRA_MARKER - Math.floor(sub.length / 2),
    sub,
    isUltra ? { fg: LAV } : { dim: true },
  );

  // 7 — blank (bottom edge of the ripple rectangle).
  newRow();

  // 8 — description.
  const dr = newRow();
  put(
    dr,
    2,
    active,
    isUltra
      ? { fg: "#c9b6ee", bold: true }
      : isMax
        ? { bold: true }
        : { fg: "#36c6e0", bold: true },
  );
  put(dr, 2 + active.length, " — " + EFFORT_DESCRIPTIONS[active], { dim: true });

  // 9 — hint.
  const hr = newRow();
  put(hr, 2, "←/→ to adjust · Enter to confirm · Esc to cancel", { dim: true });

  // --- Ultracode effect: full-panel violet pixel field as a BACKGROUND wash
  //     over rows 0–7, centred on the ▲ marker. Layers:
  //       (1) fill diffusion  — a circle grows SLOWLY from ▲ to cover the rect
  //       (2) radial ripples  — once filled, concentric rings expand outward
  //                             from ▲ (sin of distance − time): the water wave
  //       (3) vertical block glitch — column strips jump ±1 row occasionally
  //       (4) bloom glow       — global breathing brightness
  if (isUltra) {
    const centerCol = leftPad + ULTRA_MARKER;
    const centerRow = 4;
    const maxDist = Math.max(
      Math.hypot(centerCol - rectL, (centerRow - RECT_TOP) * 2.1),
      Math.hypot(rectR - centerCol, (RECT_BOTTOM - centerRow) * 2.1),
    );
    // (1) fill front grows slowly from the marker (eased), reaching full
    //     coverage at fade=1. Slower start than before for a deliberate bloom.
    const fillR = maxDist * (fade * fade); // ease-in → gentle at first
    // (4) bloom: gentle global breathing.
    const bloom = (Math.sin(phase * 0.08) + 1) / 2;

    for (let r = RECT_TOP; r <= RECT_BOTTOM; r++) {
      const cells = grid[r]!;
      for (let c = rectL; c <= rectR; c++) {
        // (3) glitch: sample this column strip from a row offset ±1 sometimes.
        const strip = Math.floor((c - rectL) / 2);
        const jitter =
          hash(strip * 3.7 + Math.floor(phase / 6)) > 0.85
            ? hash(strip + Math.floor(phase / 6)) > 0.5
              ? 1
              : -1
            : 0;
        const sr = r + jitter;

        // Radial distance from the ▲ (aspect-corrected: chars ~2× tall).
        const dx = c - centerCol;
        const dy = (sr - centerRow) * 2.1;
        const dist = Math.hypot(dx, dy);

        // (1) not yet reached by the growing fill front → leave dark.
        if (dist > fillR + 0.5) continue;

        // (2) concentric ripple: rings of brightness expanding outward from ▲.
        //     Slow drift (small phase coeff) so the waves roll out gently.
        const ripple = Math.sin(dist * 0.24 - phase * 0.08);
        // Soft edge so the fill front itself glows as it advances.
        const front = Math.max(0, 1 - Math.abs(dist - fillR) / 3);
        const base = 0.3 + 0.16 * ripple + 0.1 * bloom + 0.14 * front;
        const light = base; // already vivid; violet() clamps to 0.12–0.62
        const hueShift = 16 * ripple; // ring crests tilt toward magenta
        cells[c] = { ...grid[r]![c]!, bg: violet(light, hueShift) };
      }
    }
  }

  return grid.map(renderRow);
}

export { ORDER };
