import chalk from "chalk";
import type { SlashCommand } from "./types.js";
export const usageCommand: SlashCommand = {
  name: "usage",
  description: "Show session token usage",
  run: (_args, ctx): undefined => {
    const s = ctx.stats;
    if (!s) {
      console.log(chalk.gray("  Usage is unavailable."));
      return;
    }
    console.log(
      `  Input: ${s.inputTokens.toLocaleString()}  Output: ${s.outputTokens.toLocaleString()}  Total: ${s.totalTokens.toLocaleString()}`,
    );
  },
};
export default usageCommand;
