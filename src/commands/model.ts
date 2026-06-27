// /model — show or switch the active model
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Show or switch the active model (/model <id>)",
  run: (args, ctx) => {
    const next = args.trim();
    if (!next) {
      console.log(`  Model: ${chalk.cyan(ctx.modelConfig.model)} (${ctx.modelConfig.provider})`);
      return;
    }
    const prev = ctx.modelConfig.model;
    ctx.modelConfig.model = next;
    console.log(chalk.gray(`  Model: ${prev} → ${chalk.cyan(next)}`));
  },
};

export default modelCommand;
