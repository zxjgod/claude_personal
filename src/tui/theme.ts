// ============================================================
// TUI palette — one source of truth for role/element colors (M37)
// ============================================================
// Before this, every component defined its own `const ORANGE = "#d77757"` and
// reached for bare "cyan"/"green"/"red" inline, so there was no coherent story
// about which color means what. This module centralizes the palette and, more
// importantly, gives each *role* in the transcript a distinct, readable hue.
//
// The official-alignment batch (2026-09) added the chrome tokens the official
// client defines in utils/theme.ts: promptBorder (the input box's gray rounded
// top border), bashBorder (pink `!` shell mode), permission (the blue used by
// dialogs + their ▔ divider), subtle (dim replacement), and the official
// permission-mode colors (autoAccept purple / planMode teal / error red).
// Values are the official dark-readable picks; `accent`/`accentBright` were
// already the official claude / claudeShimmer oranges.
// ============================================================

/** Named role/element colors. Values are Ink `color` prop inputs (hex or name). */
export const palette = {
  /** Claude orange — spinner glyph/verb, primary accent (official `claude`). */
  accent: "#d77757",
  /** Lighter orange for the shimmer sweep (official `claudeShimmer`). */
  accentBright: "#f59575",
  /** Slash-command names in the palette / autocomplete. */
  command: "#7dcfff",
  /** Added lines / positive diffs — Claude Code dark success green rgb(78,186,101). */
  success: "#4EBA65",
  /** Errors / removed lines. */
  error: "#f7768e",
  /** Amber for warn-level states (context gauge, mid-risk hints). */
  warning: "#e0af68",
  /** Input box rounded top border + `❯` chrome (official promptBorder). */
  promptBorder: "#999999",
  /** `!` shell-mode border + prompt (official bashBorder pink). */
  bashBorder: "#ff0087",
  /** Permission dialogs + their ▔ divider (official permission blue). */
  permission: "#5769f7",
  /** Dim chrome replacement where dimColor can't be threaded (official subtle). */
  subtle: "#afafaf",
  /** Permission mode colors. The official LIGHT-theme literals (teal #006666,
   *  purple #8700ff) measure ~2.5:1 on dark terminals — the official dark
   *  theme swaps them for ANSI bright variants, so we ship bright-equivalent
   *  hexes that stay legible on dark (the common case) and acceptable on light. */
  modeColors: {
    default: "#afafaf",
    acceptEdits: "#c586c0", // official dark: magentaBright
    bypassPermissions: "#f7768e",
    plan: "#4ec9b0", // official dark: cyanBright
  } as Record<string, string>,
} as const;

/** Official permission-mode footer symbols (acceptEdits/bypass share ⏵⏵) —
 *  glyphs live in figures.ts, the mode→glyph mapping here. */
import { FAST_FORWARD, PAUSE } from "./figures.js";
export const MODE_SYMBOLS: Record<string, string> = {
  acceptEdits: FAST_FORWARD,
  bypassPermissions: FAST_FORWARD,
  plan: PAUSE,
};

/** Return the badge color for a permission mode. Falls back to subtle for unknown modes. */
export function modeColor(mode: string): string {
  return palette.modeColors[mode] ?? palette.subtle;
}

/** Short friendly badge labels for permission modes — enum names like
 *  "bypassPermissions" read as identifiers, not UI copy. */
const MODE_LABELS: Record<string, string> = {
  default: "default",
  acceptEdits: "accept edits",
  bypassPermissions: "bypass permissions",
  plan: "plan mode",
};

/** Friendly label for a permission mode. Falls back to the raw name. */
export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

/** The official footer mode indicator, e.g. "⏸ plan mode on". Default mode
 *  renders nothing in the official client — callers skip it (returns null). */
export function modeFooterText(mode: string): string | null {
  if (mode === "default") return null;
  return `${MODE_SYMBOLS[mode] ?? ""} ${modeLabel(mode)} on`.trim();
}

export type PaletteColor = (typeof palette)[keyof typeof palette];
