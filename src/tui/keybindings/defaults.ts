// ============================================================
// Keybindings — default global bindings (the shortcuts the app wires)
// ============================================================

import type { KeybindingBlock } from "./types.js";

/**
 * The default global shortcuts the app actually dispatches. Editing keys
 * (arrows, backspace, Enter-as-submit) remain handled inline by the InputBox;
 * this table covers the app-level hotkeys, so a user can remap them via
 * `~/.claude/keybindings.json` (e.g. `{"bindings":[{"context":"Global","bindings":{"ctrl+m":"chat:cycleMode"}}]}`).
 *
 * Batch B (official alignment): ctrl+r is HISTORY SEARCH (the official
 * history:search binding — the old tool-card expansion it used to trigger is
 * covered by ctrl+o's verbose viewer); ctrl+s/g/t/l and alt+p/t join as
 * official chat/app actions. ctrl+c/ctrl+d are NOT rebindable (official
 * reservedShortcuts) — they are handled directly by InterruptHotkey.
 */
export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: "Global",
    bindings: {
      "shift+tab": "chat:cycleMode",
      "?": "help:toggle",
      "ctrl+c": "app:interrupt",
      "ctrl+r": "history:search",
      "ctrl+o": "transcript:toggle",
      pageup: "transcript:review",
      "ctrl+s": "chat:stash",
      "ctrl+g": "chat:externalEditor",
      "ctrl+t": "app:toggleTodos",
      "ctrl+l": "app:redraw",
      "meta+p": "chat:modelPicker",
      "meta+t": "chat:thinkingToggle",
    },
  },
];
