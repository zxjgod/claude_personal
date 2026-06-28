// /provider — switch between saved API endpoint profiles (.claude/providers.json)
import chalk from "chalk";
import { promptSelectMenu } from "../cli-interactive.js";
import {
  applyProfile,
  findProfile,
  loadProviderProfiles,
  type ProviderProfile,
  providersFilePath,
} from "../provider-profiles.js";
import type { CommandContext, SlashCommand } from "./types.js";

/** "provider/model" — one-line summary of a profile's target. */
function describe(p: ProviderProfile): string {
  return `${p.provider ?? "openai"}/${p.model ?? "default"}`;
}

const EXAMPLE = `  {
    "profiles": [
      { "name": "relay", "provider": "openai", "baseURL": "https://your-relay/v1", "apiKey": "sk-...", "model": "gpt-4o" },
      { "name": "deepseek", "provider": "deepseek", "apiKey": "sk-...", "model": "deepseek-chat" }
    ]
  }`;

/** Switch the live config to `profile` and print a one-line confirmation. */
function switchTo(ctx: CommandContext, profile: ProviderProfile): void {
  const prevProvider = ctx.modelConfig.provider;
  const prevModel = ctx.modelConfig.model;
  applyProfile(ctx.modelConfig, profile);
  console.log(
    chalk.gray(
      `  Provider: ${prevProvider}/${prevModel} → ${chalk.cyan(
        `${ctx.modelConfig.provider}/${ctx.modelConfig.model}`,
      )} (${profile.name})`,
    ),
  );
}

export const providerCommand: SlashCommand = {
  name: "provider",
  description: "Switch API endpoint profile (/provider [name]) — see .claude/providers.json",
  run: async (args, ctx) => {
    const profiles = loadProviderProfiles(ctx.workspaceRoot);
    if (profiles.length === 0) {
      console.log(chalk.yellow("  No provider profiles found."));
      console.log(chalk.gray(`  Create ${providersFilePath(ctx.workspaceRoot)} with:`));
      console.log(chalk.gray(EXAMPLE));
      return;
    }

    const name = args.trim();

    // With an argument: switch directly (works in both front-ends).
    if (name) {
      const match = findProfile(profiles, name);
      if (!match) {
        console.log(chalk.yellow(`  No profile matches "${name}".`));
        console.log(chalk.gray(`  Available: ${profiles.map((p) => p.name).join(", ")}`));
        return;
      }
      switchTo(ctx, match);
      return;
    }

    // No argument on a real terminal (line REPL / --no-tui): arrow-key picker.
    // The TUI intercepts bare /provider before this runs (see tui/run.tsx).
    if (process.stdin.isTTY) {
      const picked = await promptSelectMenu({
        header: "Switch provider",
        question: "Pick an API endpoint profile:",
        options: profiles.map((p) => ({ label: p.name, description: describe(p) })),
      });
      if (!picked || picked.length === 0) {
        console.log(chalk.gray("  Cancelled."));
        return;
      }
      const match = profiles.find((p) => p.name === picked[0]);
      if (match) switchTo(ctx, match);
      return;
    }

    // Non-TTY (piped / CI): list profiles, don't block on input.
    console.log("");
    console.log(chalk.bold("  Provider profiles:"));
    for (const p of profiles) {
      console.log(`    ${chalk.cyan(p.name)} — ${chalk.gray(describe(p))}`);
    }
    console.log(chalk.gray("  Use /provider <name> to switch."));
  },
};

export default providerCommand;
