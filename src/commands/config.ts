// /config — show the active runtime configuration
import chalk from "chalk";
import { getEffort } from "../effort.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const configCommand: SlashCommand = {
  name: "config",
  description: "Show the active runtime configuration",
  run: (_args, ctx): undefined => {
    const c = ctx.modelConfig;
    console.log("");
    console.log(chalk.bold("  Config:"));
    console.log(`    Provider:    ${chalk.cyan(sanitizeTerminalText(c.provider))}`);
    console.log(`    Model:       ${chalk.cyan(sanitizeTerminalText(c.model))}`);
    console.log(`    Effort:      ${chalk.cyan(getEffort(c.options))}`);
    console.log(
      `    Base URL:    ${chalk.cyan(sanitizeTerminalText(c.baseURL ?? "(provider default)"))}`,
    );
    console.log(`    Max tokens:  ${chalk.cyan(c.maxTokens ?? "(default)")}`);
    console.log(`    Temperature: ${chalk.cyan(c.temperature ?? "(default)")}`);
    console.log(`    Workspace:   ${chalk.cyan(sanitizeTerminalText(ctx.workspaceRoot))}`);
    const permissionMode = ctx.getPermissionMode?.() ?? ctx.permissionMode;
    if (permissionMode) {
      console.log(`    Permissions: ${chalk.cyan(permissionMode)}`);
    }
    console.log(chalk.gray("  Use /model <id> to switch model for this session."));
  },
};

export default configCommand;
