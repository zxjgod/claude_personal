// ============================================================
// Keybindings — resolve an Ink keystroke to an action
// ============================================================

import { getKeyName, type InkKey, matchesBinding } from "./match.js";
import { parseBindings } from "./parser.js";
import type { KeybindingBlock, ParsedBinding, ParsedKeystroke } from "./types.js";

export type ResolveResult =
  | { type: "match"; action: string }
  | { type: "none" }
  | { type: "unbound" };

/**
 * Resolve an Ink keystroke to an action, given the active contexts and a flat
 * list of parsed bindings. Single-keystroke bindings only; later bindings win
 * so user overrides (appended after defaults) take precedence.
 */
export function resolveKey(
  input: string,
  key: InkKey,
  activeContexts: string[],
  bindings: ParsedBinding[],
): ResolveResult {
  let match: ParsedBinding | undefined;
  const ctxSet = new Set(activeContexts);
  for (const binding of bindings) {
    if (binding.chord.length !== 1) continue;
    if (!ctxSet.has(binding.context)) continue;
    if (matchesBinding(input, key, binding)) match = binding;
  }
  if (!match) return { type: "none" };
  if (match.action === null) return { type: "unbound" };
  return { type: "match", action: match.action };
}

/** Build a ParsedKeystroke from an Ink input + Key (null if no key name). */
export function buildKeystroke(input: string, key: InkKey): ParsedKeystroke | null {
  const keyName = getKeyName(input, key);
  if (!keyName) return null;
  // Escape quirk: Ink sets meta=true on Escape; don't record it as a modifier.
  const effectiveMeta = key.escape ? false : (key.meta ?? false);
  return {
    key: keyName,
    ctrl: key.ctrl ?? false,
    alt: effectiveMeta,
    shift: key.shift ?? false,
    meta: effectiveMeta,
    super: key.super ?? false,
  };
}

/** Compare two ParsedKeystrokes, collapsing alt/meta into one logical modifier. */
export function keystrokesEqual(a: ParsedKeystroke, b: ParsedKeystroke): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    (a.alt || a.meta) === (b.alt || b.meta) &&
    a.super === b.super
  );
}

/**
 * Build a resolver closure over defaults + user overrides. Returns a function
 * that maps (input, key, activeContexts) → ResolveResult.
 */
export function createResolver(defaults: KeybindingBlock[], user: KeybindingBlock[] | null) {
  const bindings = parseBindings(user ? [...defaults, ...user] : defaults);
  return (input: string, key: InkKey, activeContexts: string[]): ResolveResult =>
    resolveKey(input, key, activeContexts, bindings);
}
