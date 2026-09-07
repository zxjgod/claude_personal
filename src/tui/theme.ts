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
//
// /theme (2026-09-08): `palette` is a LIVE object — applyTheme mutates it in
// place, and components reading `palette.x` at RENDER time pick up the switch
// on the next repaint (the command's log output triggers the store emit).
// Never snapshot palette values at module scope (`const X = palette.y` at
// file top freezes the dark value forever).
// ============================================================

export type ThemeName = "dark" | "light";

interface PaletteShape {
  /** Claude orange — spinner glyph/verb, primary accent (official `claude`). */
  accent: string;
  /** Lighter orange for the shimmer sweep (official `claudeShimmer`). */
  accentBright: string;
  /** Slash-command names in the palette / autocomplete. */
  command: string;
  /** Added lines / positive diffs. */
  success: string;
  /** Errors / removed lines. */
  error: string;
  /** Amber for warn-level states (context gauge, mid-risk hints). */
  warning: string;
  /** Input box rounded top border + `❯` chrome (official promptBorder). */
  promptBorder: string;
  /** `!` shell-mode border + prompt (official bashBorder pink). */
  bashBorder: string;
  /** Permission dialogs + their ▔ divider (official permission blue). */
  permission: string;
  /** Dim chrome replacement where dimColor can't be threaded (official subtle). */
  subtle: string;
  /** Permission mode colors. */
  modeColors: Record<string, string>;
}

const DARK: PaletteShape = {
  accent: "#d77757",
  accentBright: "#f59575",
  command: "#7dcfff",
  /** Claude Code dark success green rgb(78,186,101). */
  success: "#4EBA65",
  error: "#f7768e",
  warning: "#e0af68",
  promptBorder: "#999999",
  bashBorder: "#ff0087",
  permission: "#5769f7",
  subtle: "#afafaf",
  /** The official LIGHT-theme literals (teal #006666, purple #8700ff) measure
   *  ~2.5:1 on dark terminals — the official dark theme swaps them for ANSI
   *  bright variants, so we ship bright-equivalent hexes that stay legible on
   *  dark (the common case) and acceptable on light. */
  modeColors: {
    default: "#afafaf",
    acceptEdits: "#c586c0", // official dark: magentaBright
    bypassPermissions: "#f7768e",
    plan: "#4ec9b0", // official dark: cyanBright
  },
};

/** Official LIGHT-theme literals (spec §2.7): success rgb(44,122,57), error
 *  rgb(171,43,63), autoAccept purple #8700ff, planMode teal #006666 — on a
 *  light background these native values are the legible ones. */
const LIGHT: PaletteShape = {
  accent: "#d77757", // brand orange reads on both
  accentBright: "#d76d47", // shimmer darkened for light backgrounds
  command: "#0a7ea4",
  success: "#2c7a39", // official light rgb(44,122,57)
  error: "#ab2b3f", // official rgb(171,43,63)
  warning: "#9a6a00",
  promptBorder: "#6e6e6e",
  bashBorder: "#d0006f",
  permission: "#3f4ed8",
  subtle: "#595959",
  modeColors: {
    default: "#595959",
    acceptEdits: "#8700ff", // official light purple rgb(135,0,255)
    bypassPermissions: "#ab2b3f",
    plan: "#006666", // official light teal rgb(0,102,102)
  },
};

/** Live palette — see the header note. Initialized dark (the default theme). */
export const palette: PaletteShape = { ...DARK, modeColors: { ...DARK.modeColors } };

let activeTheme: ThemeName = "dark";

/** Switch the live palette. Unknown names fall back to dark. */
export function applyTheme(name: string): ThemeName {
  const next: ThemeName = name === "light" ? "light" : "dark";
  const src = next === "light" ? LIGHT : DARK;
  palette.accent = src.accent;
  palette.accentBright = src.accentBright;
  palette.command = src.command;
  palette.success = src.success;
  palette.error = src.error;
  palette.warning = src.warning;
  palette.promptBorder = src.promptBorder;
  palette.bashBorder = src.bashBorder;
  palette.permission = src.permission;
  palette.subtle = src.subtle;
  palette.modeColors = { ...src.modeColors };
  activeTheme = next;
  return next;
}

export function currentTheme(): ThemeName {
  return activeTheme;
}

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
