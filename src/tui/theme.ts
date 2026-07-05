// ============================================================
// TUI palette — one source of truth for role/element colors (M37)
// ============================================================
// Before this, every component defined its own `const ORANGE = "#d77757"` and
// reached for bare "cyan"/"green"/"red" inline, so there was no coherent story
// about which color means what. This module centralizes the palette and, more
// importantly, gives each *role* in the transcript a distinct, readable hue so
// a glance tells you who is speaking: the user, the assistant, a tool, or the
// system.
//
// Colors are chosen to read well on a dark terminal (the common case) while
// staying legible on light backgrounds — mid-luminance hues, nothing so dark it
// vanishes on black nor so pale it washes out on white. `muted` stays as Ink's
// `dimColor` (rendered via the `dimColor` prop, not a color value) for hints and
// secondary chrome.
// ============================================================

/** Named role/element colors. Values are Ink `color` prop inputs (hex or name). */
export const palette = {
  /** Claude orange — the assistant bullet, input frame, primary accent. */
  accent: "#d77757",
  /** Lighter orange used for the status-line shimmer sweep. */
  accentBright: "#f59575",
  /** User turns — a calm blue so "who typed this" is unmistakable at a glance. */
  user: "#7aa2f7",
  /** Slash-command names in the palette / autocomplete. */
  command: "#7dcfff",
  /** Tool names in tool cards (distinct from the assistant's orange). */
  tool: "#bb9af7",
  /** Added lines / positive diffs. */
  success: "#9ece6a",
  /** Errors / removed lines. */
  error: "#f7768e",
  /** Permission mode badge colors (keyed by mode name). */
  modeColors: {
    default: "#e0af68",
    acceptEdits: "#bb9af7",
    bypassPermissions: "#f7768e",
    plan: "#7aa2f7",
  } as Record<string, string>,
} as const;

/** Return the badge color for a permission mode. Falls back to accent for unknown modes. */
export function modeColor(mode: string): string {
  return palette.modeColors[mode] ?? palette.accent;
}

export type PaletteColor = (typeof palette)[keyof typeof palette];
