// /status — show session status
import chalk from "chalk";
import { listChanges } from "../change-tracker.js";
import { getEffort } from "../effort.js";
import { formatDuration } from "../tui/session-stats.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const statusCommand: SlashCommand = {
  name: "status",
  description: "Show session status (model, workspace, tokens, changes)",
  run: (_args, ctx): undefined => {
    console.log("");
    console.log(chalk.bold("  Status:"));
    console.log(`    Session:     ${chalk.cyan(ctx.sessionId.slice(0, 8) + "...")}`);
    console.log(`    Provider:    ${chalk.cyan(sanitizeTerminalText(ctx.modelConfig.provider))}`);
    console.log(`    Model:       ${chalk.cyan(sanitizeTerminalText(ctx.modelConfig.model))}`);
    console.log(`    Effort:      ${chalk.cyan(getEffort(ctx.modelConfig.options))}`);
    console.log(`    Workspace:   ${chalk.cyan(sanitizeTerminalText(ctx.workspaceRoot))}`);
    const permissionMode = ctx.getPermissionMode?.() ?? ctx.permissionMode;
    if (permissionMode) {
      console.log(`    Permissions: ${chalk.cyan(permissionMode)}`);
    }
    console.log(`    Messages:    ${chalk.cyan(ctx.messages.length)}`);
    if (ctx.tools) {
      console.log(`    Tools:       ${chalk.cyan(ctx.tools.length)}`);
    }
    if (typeof ctx.mcpServerCount === "number") {
      console.log(`    MCP servers: ${chalk.cyan(ctx.mcpServerCount)}`);
    }
    if (ctx.stats) {
      console.log(
        `    Tokens:      ${chalk.cyan(ctx.stats.inputTokens)} in / ${chalk.cyan(ctx.stats.outputTokens)} out`,
      );
      console.log(`    Uptime:      ${chalk.cyan(formatDuration(ctx.stats.elapsedMs))}`);
    }
    const changes = listChanges(ctx.sessionId);
    console.log(`    Files changed:${chalk.cyan(" " + changes.length)}`);
  },
};

export default statusCommand;
