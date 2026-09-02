// /tokens — show message count or toggle token display
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const tokensCommand: SlashCommand = {
  name: "tokens",
  description: "Show message count or toggle token display (/tokens on|off)",
  run: (_args, ctx): undefined => {
    const arg = _args.trim().toLowerCase();
    if (arg === "on" || arg === "show") {
      if (ctx.ui) ctx.ui.showTokens = true;
      console.log(chalk.gray("  Token usage display: on"));
      return;
    }
    if (arg === "off" || arg === "hide") {
      if (ctx.ui) ctx.ui.showTokens = false;
      console.log(chalk.gray("  Token usage display: off"));
      return;
    }
    console.log(chalk.gray(`  Messages in context: ${ctx.messages.length}`));
    if (ctx.ui) {
      console.log(chalk.gray(`  Token usage display: ${ctx.ui.showTokens ? "on" : "off"}`));
    }
  },
};

export default tokensCommand;
