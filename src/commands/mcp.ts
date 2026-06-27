// /mcp — show MCP server, tool, and auth status
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Show MCP server, tool, and auth status",
  run: (_args, ctx) => {
    if (!ctx.mcpManager) {
      console.log(chalk.gray("  MCP manager is not available in this session."));
      return;
    }
    const tools = ctx.mcpManager.getAllTools();
    const count = ctx.mcpManager.serverCount;
    console.log("");
    console.log(chalk.bold(`  MCP (${count} server${count === 1 ? "" : "s"}):`));
    if (count === 0) {
      console.log(chalk.gray("  No MCP servers connected."));
      return;
    }
    const mcpTools = tools.filter((t) => t.name.startsWith("mcp__"));
    console.log(`    Servers: ${chalk.cyan(count)}   Tools: ${chalk.cyan(mcpTools.length)}`);
    // Group tools by server: mcp__<server>__<tool>
    const byServer = new Map<string, string[]>();
    for (const t of mcpTools) {
      const parts = t.name.split("__");
      const server = parts[1] ?? "unknown";
      const tool = parts.slice(2).join("__") || t.name;
      if (!byServer.has(server)) byServer.set(server, []);
      byServer.get(server)!.push(tool);
    }
    for (const [server, toolNames] of byServer) {
      console.log(`    ${chalk.cyan(server)} — ${toolNames.length} tool(s)`);
      for (const tn of toolNames.slice(0, 12)) console.log(chalk.gray(`        - ${tn}`));
      if (toolNames.length > 12) console.log(chalk.gray(`        … +${toolNames.length - 12} more`));
    }
    console.log(chalk.gray("  Auth: tokens are persisted per-server via the OAuth provider."));
  },
};

export default mcpCommand;
