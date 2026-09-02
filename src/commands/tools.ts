// /tools — list loaded tools and their source (core / MCP)
import chalk from "chalk";
import type { Tool } from "../types.js";
import type { SlashCommand } from "./types.js";

export const toolsCommand: SlashCommand = {
  name: "tools",
  description: "List loaded tools and their source (core / MCP)",
  run: (_args, ctx): undefined => {
    if (!ctx.tools || ctx.tools.length === 0) {
      console.log(chalk.gray("  Tool list is not available."));
      return;
    }
    const core = ctx.tools.filter((t) => t.source === "core");
    const mcp = ctx.tools.filter((t) => t.source === "mcp");
    console.log("");
    console.log(chalk.bold(`  Tools (${ctx.tools.length}):`));
    const printOne = (tool: Tool) => {
      const ro = tool.isReadOnly() ? chalk.green("read-only") : chalk.yellow("mutating");
      console.log(`    ${chalk.cyan(tool.name.padEnd(16))} ${ro}  ${chalk.gray(tool.description)}`);
    };
    console.log(chalk.dim("  core:"));
    for (const t of core) printOne(t.tool);
    if (mcp.length > 0) {
      console.log(chalk.dim("  mcp:"));
      for (const t of mcp) printOne(t.tool);
    }
  },
};

export default toolsCommand;
