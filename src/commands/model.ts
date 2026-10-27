// /model — show or switch the active model
import chalk from "chalk";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Show or switch the active model (/model <id>)",
  run: (args, ctx): undefined => {
    const next = args.trim();
    if (!next) {
      console.log(
        `  Model: ${chalk.cyan(sanitizeTerminalText(ctx.modelConfig.model))} (${sanitizeTerminalText(ctx.modelConfig.provider)})`,
      );
      return;
    }
    const prev = ctx.modelConfig.model;
    ctx.modelConfig.model = next;
    console.log(
      chalk.gray(
        `  Model: ${sanitizeTerminalText(prev)} → ${chalk.cyan(sanitizeTerminalText(next))}`,
      ),
    );
  },
};

export default modelCommand;
