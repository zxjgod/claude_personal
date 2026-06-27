// /keybindings — show the active keyboard shortcuts
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const keybindingsCommand: SlashCommand = {
  name: "keybindings",
  description: "Show the active keyboard shortcuts",
  run: () => {
    console.log("");
    console.log(chalk.bold("  Keybindings:"));
    const bindings: Array<[string, string]> = [
      ["Enter", "Submit the current input"],
      ["Ctrl+J", "Insert a newline (multi-line input)"],
      ["Tab", "Accept the highlighted /command suggestion"],
      ["↑ / ↓", "Move cursor between lines, or navigate command suggestions"],
      ["← / →", "Move the cursor within the line"],
      ["Ctrl+A / Ctrl+E", "Move cursor to start / end of the line"],
      ["Home / End", "Same as Ctrl+A / Ctrl+E"],
      ["Ctrl+R", "Toggle expansion of the last long tool card"],
      ["Ctrl+C", "Interrupt the current turn (keeps the session)"],
      ["PgUp / PgDn", "Scroll the transcript back / forward (End to resume)"],
      ["/", "Open the full command palette"],
      ["@<path>", "Inject a file's contents into the message"],
    ];
    for (const [k, desc] of bindings) {
      console.log(`    ${chalk.cyan(k.padEnd(18))} ${chalk.gray(desc)}`);
    }
  },
};

export default keybindingsCommand;
