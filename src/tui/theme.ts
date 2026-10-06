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
  text: string;
  userText: string;
  userBackground: string;
  secondary: string;
  muted: string;
  inlineCode: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  syntax: Record<string, string>;
  /** Claude orange — spinner glyph/verb, primary accent (official `claude`). */
  accent: string;
  /** Lighter orange for the shimmer sweep (official `claudeShimmer`). */
  accentBright: string;
  /** Slash-command names in the palette / autocomplete. */
  command: string;
  commandSelected: string;
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
  /** Soft lavender title, divider and selection in asking dialogs. */
  promptAccent: string;
  /** Startup banner colors stay explicit instead of relying on terminal dim. */
  bannerText: string;
  bannerMuted: string;
  bannerWelcome: string;
  /** Dim chrome replacement where dimColor can't be threaded (official subtle). */
  subtle: string;
  /** Permission mode colors. */
  modeColors: Record<string, string>;
}

const DARK: PaletteShape = {
  text: "#d4d4d4",
  userText: "#ffffff",
  userBackground: "#383838",
  secondary: "#999999",
  muted: "#707070",
  inlineCode: "#b1b9f9",
  diffAddedBg: "#002800",
  diffRemovedBg: "#380000",
  syntax: {
    keyword: "#ff0087",
    built_in: "#a6e22e",
    type: "#66d9ef",
    literal: "#ae81ff",
    number: "#ae81ff",
    string: "#e6db74",
    symbol: "#e6db74",
    regexp: "#e6db74",
    variable: "#f8f8f2",
    attribute: "#a6e22e",
    tag: "#ff0087",
    name: "#a6e22e",
    title: "#a6e22e",
    section: "#a6e22e",
    function: "#a6e22e",
    comment: "#85816c",
    doctag: "#85816c",
    meta: "#999999",
  },
  accent: "#d77757",
  accentBright: "#f59575",
  command: "#7dcfff",
  commandSelected: "#b1b9f9",
  /** Claude Code dark success green rgb(78,186,101). */
  success: "#4EBA65",
  error: "#f7768e",
  warning: "#e0af68",
  promptBorder: "#999999",
  bashBorder: "#ff0087",
  permission: "#5769f7",
  promptAccent: "#b1b9f9",
  bannerText: "#cccccc",
  bannerMuted: "#999999",
  bannerWelcome: "#f2f2f2",
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
  text: "#242424",
  userText: "#242424",
  userBackground: "#e5e5e5",
  secondary: "#595959",
  muted: "#707070",
  inlineCode: "#4b50a8",
  diffAddedBg: "#daf0da",
  diffRemovedBg: "#f9dddd",
  syntax: {
    keyword: "#af005f",
    built_in: "#476b00",
    type: "#006b80",
    literal: "#7040a0",
    number: "#7040a0",
    string: "#756000",
    symbol: "#756000",
    regexp: "#756000",
    variable: "#242424",
    attribute: "#476b00",
    tag: "#af005f",
    name: "#476b00",
    title: "#476b00",
    section: "#476b00",
    function: "#476b00",
    comment: "#707060",
    doctag: "#707060",
    meta: "#595959",
  },
  accent: "#d77757", // brand orange reads on both
  accentBright: "#d76d47", // shimmer darkened for light backgrounds
  command: "#0a7ea4",
  commandSelected: "#4b50a8",
  success: "#2c7a39", // official light rgb(44,122,57)
  error: "#ab2b3f", // official rgb(171,43,63)
  warning: "#9a6a00",
  promptBorder: "#6e6e6e",
  bashBorder: "#d0006f",
  permission: "#3f4ed8",
  promptAccent: "#4b50a8",
  bannerText: "#242424",
  bannerMuted: "#595959",
  bannerWelcome: "#242424",
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
  palette.text = src.text;
  palette.userText = src.userText;
  palette.userBackground = src.userBackground;
  palette.secondary = src.secondary;
  palette.muted = src.muted;
  palette.inlineCode = src.inlineCode;
  palette.diffAddedBg = src.diffAddedBg;
  palette.diffRemovedBg = src.diffRemovedBg;
  palette.syntax = { ...src.syntax };
  palette.accent = src.accent;
  palette.accentBright = src.accentBright;
  palette.command = src.command;
  palette.commandSelected = src.commandSelected;
  palette.success = src.success;
  palette.error = src.error;
  palette.warning = src.warning;
  palette.promptBorder = src.promptBorder;
  palette.bashBorder = src.bashBorder;
  palette.permission = src.permission;
  palette.promptAccent = src.promptAccent;
  palette.bannerText = src.bannerText;
  palette.bannerMuted = src.bannerMuted;
  palette.bannerWelcome = src.bannerWelcome;
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
