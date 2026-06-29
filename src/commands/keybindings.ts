// /keybindings — show the active keyboard shortcuts
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const keybindingsCommand: SlashCommand = {
  name: "keybindings",
  description: "Show the active keyboard shortcuts",
  run: () => {
    console.log("");
    console.log(chalk.bold("  Keybindings:"));
    // Only keys that are actually wired up in InputBox/App today. Multi-line
    // input (Ctrl+J) is implemented as of M25.1. Transcript scrollback
    // (PgUp/PgDn) belongs to the M25.2 full-screen layout (opt-in via
    // --fullscreen); it's listed there only when that flag is on.
    const bindings: Array<[string, string]> = [
      ["Enter", "Submit the current input"],
      ["Ctrl+J", "Insert a newline (multi-line input; \\ + Enter also works)"],
      ["Tab", "Accept the highlighted /command suggestion"],
      ["↑ / ↓", "Navigate the /command list (palette open) · move between lines (closed)"],
      ["← / →", "Move the cursor within the line"],
      ["Ctrl+A / Ctrl+E", "Move cursor to start / end of the current line"],
      ["Home / End", "Same as Ctrl+A / Ctrl+E"],
      ["Ctrl+R", "Toggle expansion of the last long tool card"],
      ["Ctrl+C", "Interrupt the current turn (keeps the session)"],
      ["/", "Open the full command palette"],
      ["@<path>", "Inject a file's contents into the message"],
    ];
    for (const [k, desc] of bindings) {
      console.log(`    ${chalk.cyan(k.padEnd(18))} ${chalk.gray(desc)}`);
    }
  },
};

export default keybindingsCommand;
