// /resume — resume a saved session
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a saved session (/resume <id-prefix>)",
  run: async (args, ctx) => {
    const id = args.trim();
    if (!id) {
      console.log(chalk.yellow("  Usage: /resume <session-prefix-or-id>"));
      return;
    }
    if (!ctx.resumeSession) {
      console.log(chalk.yellow("  Resume is not available."));
      return;
    }
    const ok = await ctx.resumeSession(id);
    if (!ok) {
      console.log(chalk.yellow(`  Session not found or ambiguous: ${id}`));
    }
  },
};

export default resumeCommand;
