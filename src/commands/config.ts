// /config — show the active runtime configuration
import chalk from "chalk";
import { getEffort } from "../effort.js";
import type { SlashCommand } from "./types.js";

export const configCommand: SlashCommand = {
  name: "config",
  description: "Show the active runtime configuration",
  run: (_args, ctx) => {
    const c = ctx.modelConfig;
    console.log("");
    console.log(chalk.bold("  Config:"));
    console.log(`    Provider:    ${chalk.cyan(c.provider)}`);
    console.log(`    Model:       ${chalk.cyan(c.model)}`);
    console.log(`    Effort:      ${chalk.cyan(getEffort(c.options))}`);
    console.log(`    Base URL:    ${chalk.cyan(c.baseURL ?? "(provider default)")}`);
    console.log(`    Max tokens:  ${chalk.cyan(c.maxTokens ?? "(default)")}`);
    console.log(`    Temperature: ${chalk.cyan(c.temperature ?? "(default)")}`);
    console.log(`    Workspace:   ${chalk.cyan(ctx.workspaceRoot)}`);
    if (ctx.permissionMode) {
      console.log(`    Permissions: ${chalk.cyan(ctx.permissionMode)}`);
    }
    console.log(chalk.gray("  Use /model <id> to switch model for this session."));
  },
};

export default configCommand;
