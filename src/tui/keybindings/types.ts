// ============================================================
// Keybindings — shared types (ported from claude-code keybindings)
// ============================================================

export interface ParsedKeystroke {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  super: boolean;
}

/** A chord is one or more keystrokes pressed in sequence ("ctrl+k ctrl+s"). */
export type Chord = ParsedKeystroke[];

export interface KeybindingBlock {
  context: string;
  bindings: Record<string, string | null>;
}

export interface ParsedBinding {
  chord: Chord;
  action: string | null;
  context: string;
}
