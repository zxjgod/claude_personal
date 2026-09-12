import chalk from "chalk";
import {
  checkPluginDependencies,
  installPlugin,
  installRemotePlugin,
  listPlugins,
  readMarketplace,
  removePlugin,
  setPluginDisabled,
} from "../plugins.js";
import type { SlashCommand } from "./types.js";

export const pluginCommand: SlashCommand = {
  name: "plugin",
  description: "List, install, or remove workspace plugins",
  run: async (args, ctx): Promise<undefined> => {
    const [op, value] = args.trim().split(/\s+/, 2);
    if (!op || op === "list") {
      const plugins = listPlugins(ctx.workspaceRoot);
      console.log(
        plugins.length
          ? plugins
              .map(
                (p) =>
                  `  ${p.name}@${p.version}${p.disabled ? " (disabled)" : ""} �?${p.description ?? ""}`,
              )
              .join("\n")
          : chalk.gray("  No workspace plugins installed."),
      );
      for (const error of checkPluginDependencies(ctx.workspaceRoot))
        console.log(chalk.yellow(`  Dependency warning: ${error}`));
      return;
    }
    try {
      if (op === "install" && value) {
        const installed = /^https?:\/\//i.test(value)
          ? await installRemotePlugin(ctx.workspaceRoot, value)
          : installPlugin(ctx.workspaceRoot, value);
        console.log(chalk.green(`  Installed plugin ${installed.name}@${installed.version}.`));
      } else if (op === "marketplace") {
        const index = readMarketplace(ctx.workspaceRoot);
        console.log(
          index.plugins.length
            ? index.plugins.map((p) => `  ${p.name}@${p.version} �?${p.source}`).join("\n")
            : chalk.gray("  Marketplace is empty."),
        );
      } else if ((op === "disable" || op === "enable") && value) {
        setPluginDisabled(ctx.workspaceRoot, value, op === "disable");
        console.log(chalk.green(`  ${op === "disable" ? "Disabled" : "Enabled"} plugin ${value}.`));
      } else if ((op === "remove" || op === "uninstall") && value) {
        removePlugin(ctx.workspaceRoot, value);
        console.log(chalk.green(`  Removed plugin ${value}.`));
      } else
        console.log(
          chalk.yellow(
            "  Usage: /plugin list | marketplace | install <local-dir-or-url> | enable <name> | disable <name> | remove <name>",
          ),
        );
    } catch (e) {
      console.log(chalk.red(`  Plugin error: ${e instanceof Error ? e.message : String(e)}`));
    }
  },
};
export default pluginCommand;
