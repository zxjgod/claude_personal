// /theme — show or set the color theme
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const themeCommand: SlashCommand = {
  name: "theme",
  description: "Show or set the color theme (/theme [dark|light])",
  run: (args, ctx): undefined => {
    const arg = args.trim().toLowerCase();
    ctx.modelConfig.options ??= {};
    const options = ctx.modelConfig.options;
    if (arg === "dark" || arg === "light") {
      (options as Record<string, unknown>).theme = arg;
      console.log(chalk.gray(`  Theme: ${arg}`));
      console.log(chalk.gray("  (Theme applies to the TUI renderer; restart for full effect.)"));
      return;
    }
    const current = (options.theme as string) ?? "dark";
    console.log(`  Theme: ${chalk.cyan(current)}`);
    console.log(chalk.gray("  Set with /theme dark or /theme light."));
  },
};

export default themeCommand;
