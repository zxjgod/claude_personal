// /vim — toggle vim-style input editing (M18.10)
// ============================================================
// Switches the editor input semantics between "default" (emacs-ish line
// editing) and "vim" (modal: Esc for normal mode, i/a to insert). The actual
// keystroke handling lives in the raw input reader; this command only flips
// the shared editorMode holder the reader consults. With no arg it toggles;
// "/vim on" | "/vim off" set explicitly. Outside the TUI it's a no-op note.
// ============================================================
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const vimCommand: SlashCommand = {
  name: "vim",
  description: "Toggle vim-style input editing (/vim [on|off])",
  run: (args, ctx): undefined => {
    if (!ctx.editorMode) {
      console.log(chalk.gray("  Vim mode is only available in the interactive TUI."));
      return;
    }
    const arg = args.trim().toLowerCase();
    let next: "default" | "vim";
    if (arg === "on" || arg === "vim") next = "vim";
    else if (arg === "off" || arg === "default") next = "default";
    else if (arg) {
      console.log(chalk.gray("  用法: /vim [on|off]"));
      return;
    } else next = ctx.editorMode.value === "vim" ? "default" : "vim";

    ctx.editorMode.value = next;
    if (next === "vim") {
      console.log(chalk.gray("  Vim mode: ") + chalk.cyan("on"));
      console.log(chalk.gray("  Esc → normal mode, i/a → insert, h/j/k/l move, x delete."));
    } else {
      console.log(
        chalk.gray("  Vim mode: ") + chalk.cyan("off") + chalk.gray(" (default line editing)."),
      );
    }
  },
};

export default vimCommand;
