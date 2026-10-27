// /theme — show or set the color theme
import chalk from "chalk";
import { readSettingsFileStrict } from "../settings.js";
import { settingsWriteTarget } from "../settings-target.js";
import { applyTheme, currentTheme, type ThemeName } from "../tui/theme.js";
import { atomicWriteFile, withFileLock } from "../utils/file-lock.js";
import type { SlashCommand } from "./types.js";

function persistTheme(workspaceRoot: string, theme: ThemeName): void {
  const target = settingsWriteTarget(workspaceRoot, "theme");
  withFileLock(target.file, () => {
    const { value, corrupt } = readSettingsFileStrict(target.file);
    if (corrupt) {
      throw new Error(
        `${target.file} is not valid JSON — fix or delete it before changing the theme.`,
      );
    }
    atomicWriteFile(target.file, `${JSON.stringify({ ...value, theme }, null, 2)}\n`);
  });
}

export const themeCommand: SlashCommand = {
  name: "theme",
  description: "Show or set the color theme (/theme [dark|light])",
  run: (args, ctx): undefined => {
    const arg = args.trim().toLowerCase();
    if (arg === "dark" || arg === "light") {
      persistTheme(ctx.workspaceRoot, arg);
      ctx.modelConfig.options = { ...ctx.modelConfig.options, theme: arg };
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
