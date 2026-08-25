// ============================================================
// Keybindings — default global bindings (the shortcuts the app wires)
// ============================================================

import type { KeybindingBlock } from "./types.js";

/**
 * The default global shortcuts the app actually dispatches. Editing keys
 * (arrows, backspace, Enter-as-submit) remain handled inline by the InputBox;
 * this table covers the app-level hotkeys, so a user can remap them via
 * `~/.claude/keybindings.json` (e.g. `{"bindings":[{"context":"Global","bindings":{"ctrl+m":"chat:cycleMode"}}]}`).
 */
export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: "Global",
    bindings: {
      "shift+tab": "chat:cycleMode",
      "?": "help:toggle",
      "ctrl+c": "app:interrupt",
      pageup: "transcript:review",
    },
  },
];
