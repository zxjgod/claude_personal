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
    // input (Ctrl+J) and transcript scrollback (PgUp/PgDn) belong to the
    // reverted M17 full-screen layout and are NOT implemented on the current
    // <Static>-based TUI — listing them here advertised keys that did nothing.
    // They return if/when M25 restores the alt-screen layout.
    const bindings: Array<[string, string]> = [
      ["Enter", "Submit the current input"],
      ["Tab", "Accept the highlighted /command suggestion"],
      ["↑ / ↓", "Navigate the command suggestion list (when the palette is open)"],
      ["← / →", "Move the cursor within the line"],
      ["Ctrl+A / Ctrl+E", "Move cursor to start / end of the line"],
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
