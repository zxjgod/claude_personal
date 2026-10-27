// /mcp — show MCP server, tool, and auth status
import chalk from "chalk";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Show MCP server, tool, and auth status (/mcp refresh <server>)",
  run: (args, ctx): Promise<undefined> | undefined => {
    if (!ctx.mcpManager) {
      console.log(chalk.gray("  MCP manager is not available in this session."));
      return;
    }

    // /mcp refresh <server> — manually re-list a server's tools (S2). Mirrors
    // what the toolsListChanged notification does automatically.
    const trimmed = args.trim();
    if (trimmed.toLowerCase().startsWith("refresh")) {
      const server = trimmed.slice(7).trim();
      const refresh = async (): Promise<void> => {
        try {
          const count = await ctx.mcpManager!.refreshServerTools(server);
          console.log(
            chalk.gray(`  Refreshed "${sanitizeTerminalText(server)}" — ${count} tool(s).`),
          );
        } catch (e) {
          console.log(
            chalk.red(
              `  Refresh failed: ${sanitizeTerminalText(e instanceof Error ? e.message : String(e))}`,
            ),
          );
        }
      };
      if (!server) {
        console.log(chalk.yellow("  Usage: /mcp refresh <server>"));
        return;
      }
      return refresh().then(() => undefined);
    }
    const servers = ctx.mcpManager.getServerSummaries();
    const count = servers.length;
    console.log("");
    console.log(chalk.bold(`  MCP (${count} server${count === 1 ? "" : "s"}):`));
    if (count === 0) {
      console.log(chalk.gray("  No MCP servers connected."));
      return;
    }
    const exposedTools = new Set(ctx.mcpManager.getAllTools());
    const toolCount = exposedTools.size;
    console.log(`    Servers: ${chalk.cyan(count)}   Tools: ${chalk.cyan(toolCount)}`);
    // Iterate actual manager entries: wrapped names are not reversible because
    // both server and remote tool names may themselves contain "__". Hide
    // duplicate objects that getAllTools() does not expose after a collision.
    for (const { name, tools } of servers) {
      const visibleTools = tools.filter((tool) => exposedTools.has(tool));
      console.log(`    ${chalk.cyan(sanitizeTerminalText(name))} — ${visibleTools.length} tool(s)`);
      for (const tool of visibleTools.slice(0, 12)) {
        console.log(chalk.gray(`        - ${sanitizeTerminalText(tool.name)}`));
      }
      if (visibleTools.length > 12)
        console.log(chalk.gray(`        … +${visibleTools.length - 12} more`));
    }
    console.log(chalk.gray("  Auth: tokens are persisted per-server via the OAuth provider."));
    return;
  },
};

export default mcpCommand;
