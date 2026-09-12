import * as fs from "node:fs";
import chalk from "chalk";
import type { PluginManifest } from "../plugins.js";
import {
  addMarketplaceFromUrl,
  checkPluginDependencies,
  findMarketplacePlugin,
  installPlugin,
  installRemotePlugin,
  listPlugins,
  readMarketplace,
  removePlugin,
  setPluginDisabled,
  writeMarketplace,
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
                  `  ${p.name}@${p.version}${p.disabled ? " (disabled)" : ""} — ${p.description ?? ""}`,
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
        let installed: PluginManifest;
        if (/^https?:\/\//i.test(value))
          installed = await installRemotePlugin(ctx.workspaceRoot, value);
        else if (fs.existsSync(value)) installed = installPlugin(ctx.workspaceRoot, value);
        else {
          // Not a URL and not a directory — resolve by name from the
          // workspace marketplace index.
          const entry = findMarketplacePlugin(ctx.workspaceRoot, value);
          if (!entry)
            throw new Error(
              `"${value}" is not a URL, a local directory, or a marketplace entry — try /plugin marketplace`,
            );
          installed = await installRemotePlugin(ctx.workspaceRoot, entry.source);
        }
        console.log(chalk.green(`  Installed plugin ${installed.name}@${installed.version}.`));
      } else if (op === "marketplace") {
        const [, sub, url] = args.trim().split(/\s+/);
        if (sub === "add" && url) {
          const added = await addMarketplaceFromUrl(ctx.workspaceRoot, url);
          console.log(
            chalk.green(`  Marketplace updated: ${added.plugins.length} plugin(s) available.`),
          );
        } else if (sub === "remove") {
          writeMarketplace(ctx.workspaceRoot, { plugins: [] });
          console.log(chalk.green("  Marketplace index removed."));
        } else {
          const index = readMarketplace(ctx.workspaceRoot);
          console.log(
            index.plugins.length
              ? index.plugins.map((p) => `  ${p.name}@${p.version} ← ${p.source}`).join("\n")
              : chalk.gray("  Marketplace is empty. Add one: /plugin marketplace add <url>"),
          );
        }
      } else if ((op === "disable" || op === "enable") && value) {
        setPluginDisabled(ctx.workspaceRoot, value, op === "disable");
        console.log(chalk.green(`  ${op === "disable" ? "Disabled" : "Enabled"} plugin ${value}.`));
      } else if ((op === "remove" || op === "uninstall") && value) {
        removePlugin(ctx.workspaceRoot, value);
        console.log(chalk.green(`  Removed plugin ${value}.`));
      } else
        console.log(
          chalk.yellow(
            "  Usage: /plugin list | marketplace [add <url>|remove] | install <name|dir|url> | enable <name> | disable <name> | remove <name>",
          ),
        );
    } catch (e) {
      console.log(chalk.red(`  Plugin error: ${e instanceof Error ? e.message : String(e)}`));
    }
  },
};
export default pluginCommand;
