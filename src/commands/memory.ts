// /memory — view or append to CLAUDE.md
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "View or append to CLAUDE.md (/memory, /memory add <text>)",
  run: (args, ctx) => {
    const claudeMdPath = path.join(ctx.workspaceRoot, "CLAUDE.md");
    const trimmed = args.trim();

    // /memory add <text> — append a bullet to CLAUDE.md.
    if (trimmed.toLowerCase().startsWith("add ")) {
      const note = trimmed.slice(4).trim();
      if (!note) {
        console.log(chalk.yellow("  Usage: /memory add <text>"));
        return;
      }
      try {
        const exists = fs.existsSync(claudeMdPath);
        const prefix = exists && fs.readFileSync(claudeMdPath, "utf-8").endsWith("\n") ? "" : "\n";
        fs.appendFileSync(claudeMdPath, `${prefix}- ${note}\n`, "utf-8");
        console.log(chalk.gray(`  Appended to CLAUDE.md: "${note}"`));
        console.log(chalk.gray("  (Restart the session to load it into the system prompt.)"));
      } catch (e: any) {
        console.log(chalk.red(`  Could not write CLAUDE.md: ${e.message}`));
      }
      return;
    }

    // /memory — show current CLAUDE.md.
    try {
      const content = fs.readFileSync(claudeMdPath, "utf-8");
      console.log("");
      console.log(chalk.bold(`  CLAUDE.md (${claudeMdPath}):`));
      console.log("");
      for (const line of content.split("\n")) console.log(`  ${chalk.gray(line)}`);
    } catch {
      console.log(chalk.gray("  No CLAUDE.md found. Use /init to create one, or /memory add <text>."));
    }
  },
};

export default memoryCommand;
