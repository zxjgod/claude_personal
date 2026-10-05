// /diff — show files changed during this session
import chalk from "chalk";
import { listChanges } from "../change-tracker.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const diffCommand: SlashCommand = {
  name: "diff",
  description: "Show files changed during this session",
  run: (_args, ctx): undefined => {
    const changes = listChanges(ctx.sessionId);
    if (changes.length === 0) {
      console.log(chalk.gray("  No files changed this session."));
      return;
    }
    console.log("");
    console.log(chalk.bold(`  Files changed (${changes.length}):`));
    for (const ch of changes) {
      const tag = ch.kind === "created" ? chalk.green("created ") : chalk.yellow("modified");
      const times = ch.edits > 1 ? chalk.gray(` ×${ch.edits}`) : "";
      console.log(`    ${tag} ${chalk.cyan(sanitizeTerminalText(ch.path))}${times}`);
    }
  },
};

export default diffCommand;
