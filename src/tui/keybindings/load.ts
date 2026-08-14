// ============================================================
// Keybindings — load user overrides from ~/.claude/keybindings.json
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeybindingBlock } from "./types.js";

/**
 * Load user keybinding blocks from `~/.claude/keybindings.json`. Best-effort:
 * a missing/malformed file returns null (the caller falls back to defaults).
 */
export function loadUserBindings(): KeybindingBlock[] | null {
  const file = path.join(os.homedir(), ".claude", "keybindings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { bindings?: unknown };
    if (parsed && Array.isArray(parsed.bindings)) {
      return parsed.bindings as KeybindingBlock[];
    }
    return null;
  } catch {
    return null;
  }
}
