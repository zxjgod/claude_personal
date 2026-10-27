import chalk from "chalk";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";
export const addDirCommand: SlashCommand = {
  name: "add-dir",
  description: "Show or add an allowed workspace directory",
  run: (args, ctx): undefined => {
    const dir = args.trim();
    if (!dir) {
      console.log(`  Workspace: ${sanitizeTerminalText(ctx.workspaceRoot)}`);
      return;
    }
    console.log(chalk.yellow("  Additional directories are configured with --add-dir at startup."));
  },
};
export default addDirCommand;
