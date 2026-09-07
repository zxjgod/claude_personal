// /theme — show or set the color theme
import chalk from "chalk";
import { applyTheme, currentTheme } from "../tui/theme.js";
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
      // Applies LIVE: applyTheme mutates the shared palette in place, and the
      // store emit from this command's own log output repaints the TUI with
      // the new colors immediately — no restart.
      applyTheme(arg);
      console.log(chalk.gray(`  Theme: ${arg}`));
      return;
    }
    console.log(`  Theme: ${chalk.cyan(currentTheme())}`);
    console.log(chalk.gray("  Set with /theme dark or /theme light."));
  },
};

export default themeCommand;
