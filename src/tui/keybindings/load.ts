// ============================================================
// Keybindings — load user overrides from ~/.claude/keybindings.json
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeybindingBlock } from "./types.js";

/**
 * Structural check for one loaded block: a non-null object with a string
 * `context` and a plain-object `bindings` of key → action (action may be
 * null, which UNBINDS the key). Anything else is dropped, not fatal: the
 * resolver is created once at App module scope, so a malformed file reaching
 * parseBindings would throw at import time and take the whole TUI down with
 * it — `{"bindings":[null]}` used to do exactly that.
 */
function isBlock(v: unknown): v is KeybindingBlock {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const { context, bindings } = v as { context?: unknown; bindings?: unknown };
  if (typeof context !== "string") return false;
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return false;
  return Object.values(bindings).every((action) => typeof action === "string" || action === null);
}

/**
 * Parse + shape-check the file's raw contents. Pure so the validation is
 * unit-testable without touching the real homedir. Returns null when nothing
 * usable remains (no `bindings` array, unparseable JSON, or every block
 * failing the shape check). NEVER throws.
 */
export function parseBindingsFile(raw: string): KeybindingBlock[] | null {
  try {
    const parsed = JSON.parse(raw) as { bindings?: unknown };
    if (parsed && Array.isArray(parsed.bindings)) {
      const blocks = (parsed.bindings as unknown[]).filter(isBlock);
      return blocks.length > 0 ? blocks : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load user keybinding blocks from `~/.claude/keybindings.json`. Best-effort:
 * a missing/malformed file (or one whose blocks all fail the shape check)
 * returns null and the caller falls back to defaults. NEVER throws.
 */
export function loadUserBindings(): KeybindingBlock[] | null {
  const file = path.join(os.homedir(), ".claude", "keybindings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  return parseBindingsFile(raw);
}
