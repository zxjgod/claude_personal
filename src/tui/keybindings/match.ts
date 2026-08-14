// ============================================================
// Keybindings — match an Ink keystroke against a parsed binding
// ============================================================

import type { ParsedBinding, ParsedKeystroke } from "./types.js";

/** Structural subset of Ink's `Key` that matching cares about. */
export interface InkKey {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  super?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
}

/** Map an Ink input + Key to a normalized key name ("" = no printable/named key). */
export function getKeyName(input: string, key: InkKey): string | null {
  if (key.escape) return "escape";
  if (key.return) return "enter";
  if (key.tab) return "tab";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.home) return "home";
  if (key.end) return "end";
  if (input.length === 1) return input.toLowerCase();
  return null;
}

/**
 * Compare Ink modifiers against a ParsedKeystroke. Alt and Meta are collapsed:
 * legacy terminals can't distinguish them (Ink sets `key.meta` for Alt/Option),
 * so a `meta` binding is an alias for `alt`. Super (Cmd/Win) is distinct.
 */
function modifiersMatch(key: InkKey, target: ParsedKeystroke): boolean {
  if ((key.ctrl ?? false) !== target.ctrl) return false;
  if ((key.shift ?? false) !== target.shift) return false;
  const targetNeedsMeta = target.alt || target.meta;
  if ((key.meta ?? false) !== targetNeedsMeta) return false;
  if ((key.super ?? false) !== target.super) return false;
  return true;
}

export function matchesKeystroke(input: string, key: InkKey, target: ParsedKeystroke): boolean {
  const keyName = getKeyName(input, key);
  if (keyName !== target.key) return false;

  // QUIRK: Ink sets key.meta=true on Escape (legacy terminal escape-sequence
  // behavior). Ignore meta when matching the escape key itself, otherwise a
  // bare "escape" binding would never match.
  if (key.escape) return modifiersMatch({ ...key, meta: false }, target);
  return modifiersMatch(key, target);
}

/** Match an Ink keystroke against a single-keystroke binding. */
export function matchesBinding(input: string, key: InkKey, binding: ParsedBinding): boolean {
  if (binding.chord.length !== 1) return false;
  const keystroke = binding.chord[0];
  if (!keystroke) return false;
  return matchesKeystroke(input, key, keystroke);
}
