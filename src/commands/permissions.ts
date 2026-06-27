// /permissions — show or clear always-allow permission memory
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const permissionsCommand: SlashCommand = {
  name: "permissions",
  description: "Show or clear always-allow permission memory",
  run: (args, ctx) => {
    if (!ctx.permissions) {
      console.log(chalk.yellow("  Permission memory is not available."));
      return;
    }
    const arg = args.trim().toLowerCase();
    if (arg === "clear") {
      ctx.permissions.clearAlwaysAllow();
      console.log(chalk.gray("  Always-allow permission memory cleared."));
      return;
    }
    const items = ctx.permissions.listAlwaysAllow();
    if (items.length === 0) {
      console.log(chalk.gray("  No always-allow permissions in this session."));
      return;
    }
    console.log("");
    console.log(chalk.bold("  Always-allow permissions:"));
    for (const item of items) console.log(chalk.gray(`    ${item}`));
    console.log(chalk.gray("  Use /permissions clear to clear them."));
  },
};

export default permissionsCommand;
