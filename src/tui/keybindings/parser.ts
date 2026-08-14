// ============================================================
// Keybindings — keystroke/chord parser + display (ported)
// ============================================================
// Pure string parsing: "ctrl+shift+k" → ParsedKeystroke, "ctrl+k ctrl+s" →
// Chord, plus canonical + platform display formatting.

import type { Chord, KeybindingBlock, ParsedBinding, ParsedKeystroke } from "./types.js";

/** Parse a keystroke string like "ctrl+shift+k" into a ParsedKeystroke. */
export function parseKeystroke(input: string): ParsedKeystroke {
  const parts = input.split("+");
  const keystroke: ParsedKeystroke = {
    key: "",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
  };
  for (const part of parts) {
    const lower = part.toLowerCase();
    switch (lower) {
      case "ctrl":
      case "control":
        keystroke.ctrl = true;
        break;
      case "alt":
      case "opt":
      case "option":
        keystroke.alt = true;
        break;
      case "shift":
        keystroke.shift = true;
        break;
      case "meta":
        keystroke.meta = true;
        break;
      case "cmd":
      case "command":
      case "super":
      case "win":
        keystroke.super = true;
        break;
      case "esc":
        keystroke.key = "escape";
        break;
      case "return":
      case "enter":
        keystroke.key = "enter";
        break;
      case "space":
        keystroke.key = " ";
        break;
      case "↑":
        keystroke.key = "up";
        break;
      case "↓":
        keystroke.key = "down";
        break;
      case "←":
        keystroke.key = "left";
        break;
      case "→":
        keystroke.key = "right";
        break;
      default:
        keystroke.key = lower;
        break;
    }
  }
  return keystroke;
}

/** Parse a chord string like "ctrl+k ctrl+s" into an array of ParsedKeystrokes. */
export function parseChord(input: string): Chord {
  // A lone space character IS the space key binding, not a separator.
  if (input === " ") return [parseKeystroke("space")];
  return input
    .trim()
    .split(/\s+/)
    .map((part) => parseKeystroke(part));
}

function keyToDisplayName(key: string): string {
  switch (key) {
    case "escape":
      return "Esc";
    case " ":
      return "Space";
    case "tab":
      return "Tab";
    case "enter":
      return "Enter";
    case "backspace":
      return "Backspace";
    case "delete":
      return "Delete";
    case "up":
      return "↑";
    case "down":
      return "↓";
    case "left":
      return "←";
    case "right":
      return "→";
    case "pageup":
      return "PageUp";
    case "pagedown":
      return "PageDown";
    case "home":
      return "Home";
    case "end":
      return "End";
    default:
      return key;
  }
}

/** Canonical string for a single keystroke. */
export function keystrokeToString(ks: ParsedKeystroke): string {
  const parts: string[] = [];
  if (ks.ctrl) parts.push("ctrl");
  if (ks.alt) parts.push("alt");
  if (ks.shift) parts.push("shift");
  if (ks.meta) parts.push("meta");
  if (ks.super) parts.push("cmd");
  parts.push(keyToDisplayName(ks.key));
  return parts.join("+");
}

/** Canonical string for a chord. */
export function chordToString(chord: Chord): string {
  return chord.map(keystrokeToString).join(" ");
}

/** Parse keybinding blocks (from JSON config) into a flat list of ParsedBindings. */
export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = [];
  for (const block of blocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      bindings.push({ chord: parseChord(key), action, context: block.context });
    }
  }
  return bindings;
}
