import * as fs from "node:fs";
import * as path from "node:path";
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
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const pluginCommand: SlashCommand = {
  name: "plugin",
  description: "List, install, or remove workspace plugins",
  run: async (args, ctx): Promise<undefined> => {
    const trimmed = args.trim();
    const [op, firstValue] = trimmed.split(/\s+/, 2);
    // Local plugin paths may contain spaces. Only install consumes the complete
    // remainder; the other subcommands keep their original first-value parsing.
    const value = op === "install" ? trimmed.slice(op.length).trimStart() || undefined : firstValue;
    if (!op || op === "list") {
      const plugins = listPlugins(ctx.workspaceRoot);
      console.log(
        plugins.length
          ? plugins
              .map(
                (p) =>
                  `  ${sanitizeTerminalText(p.name)}@${sanitizeTerminalText(p.version)}${p.disabled ? " (disabled)" : ""} — ${sanitizeTerminalText(p.description ?? "")}`,
              )
              .join("\n")
          : chalk.gray("  No workspace plugins installed."),
      );
      for (const error of checkPluginDependencies(ctx.workspaceRoot))
        console.log(chalk.yellow(`  Dependency warning: ${sanitizeTerminalText(error)}`));
      return;
    }
    try {
      if (op === "install" && value) {
        const installValue =
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
            ? value.slice(1, -1)
            : value;
        let installed: PluginManifest;
        if (/^https?:\/\//i.test(installValue))
          installed = await installRemotePlugin(ctx.workspaceRoot, installValue);
        else {
          // Local paths follow the active workspace, not the process cwd. An
          // absolute path is unchanged by path.resolve.
          const source = path.resolve(ctx.workspaceRoot, installValue);
          if (fs.existsSync(source)) installed = installPlugin(ctx.workspaceRoot, source);
          else {
            // Not a URL and not a directory — resolve by name from the
            // workspace marketplace index.
            const entry = findMarketplacePlugin(ctx.workspaceRoot, installValue);
            if (!entry)
              throw new Error(
                `"${installValue}" is not a URL, a local directory, or a marketplace entry — try /plugin marketplace`,
              );
            installed = await installRemotePlugin(ctx.workspaceRoot, entry.source);
          }
        }
        console.log(
          chalk.green(
            `  Installed plugin ${sanitizeTerminalText(installed.name)}@${sanitizeTerminalText(installed.version)}.`,
          ),
        );
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
              ? index.plugins
                  .map(
                    (p) =>
                      `  ${sanitizeTerminalText(p.name)}@${sanitizeTerminalText(p.version)} ← ${sanitizeTerminalText(p.source)}`,
                  )
                  .join("\n")
              : chalk.gray("  Marketplace is empty. Add one: /plugin marketplace add <url>"),
          );
        }
      } else if ((op === "disable" || op === "enable") && value) {
        setPluginDisabled(ctx.workspaceRoot, value, op === "disable");
        console.log(
          chalk.green(
            `  ${op === "disable" ? "Disabled" : "Enabled"} plugin ${sanitizeTerminalText(value)}.`,
          ),
        );
      } else if ((op === "remove" || op === "uninstall") && value) {
        removePlugin(ctx.workspaceRoot, value);
        console.log(chalk.green(`  Removed plugin ${sanitizeTerminalText(value)}.`));
      } else
        console.log(
          chalk.yellow(
            "  Usage: /plugin list | marketplace [add <url>|remove] | install <name|dir|url> | enable <name> | disable <name> | remove <name>",
          ),
        );
    } catch (e) {
      console.log(
        chalk.red(
          `  Plugin error: ${sanitizeTerminalText(e instanceof Error ? e.message : String(e))}`,
        ),
      );
    }
  },
};
export default pluginCommand;
