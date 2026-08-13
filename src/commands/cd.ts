// ============================================================
// /cd — change the session's working directory mid-conversation
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const cdCommand: SlashCommand = {
  name: "cd",
  description: "Change the working directory for this session",
  run: (args, ctx) => {
    if (!args.trim()) {
      console.log(chalk.dim(`  Current workspace: ${ctx.workspaceRoot}`));
      console.log(chalk.dim("  Usage: /cd <path>"));
      return;
    }

    if (!ctx.setWorkspaceRoot) {
      console.log(chalk.red("  /cd is not available in this session."));
      return;
    }

    // Resolve relative to the CURRENT root (matching `cd` semantics), so a
    // chain of `/cd a` then `/cd b` composes like the shell.
    const target = path.resolve(ctx.workspaceRoot, args.trim());
    let isDir = false;
    try {
      isDir = fs.statSync(target).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      console.log(chalk.red(`  Not a directory: ${args.trim()}`));
      return;
    }

    const prev = ctx.workspaceRoot;
    const ok = ctx.setWorkspaceRoot(target);
    if (ok) {
      console.log(chalk.green(`  Workspace: ${prev} → ${target}`));
    } else {
      console.log(chalk.red(`  Could not change workspace to: ${target}`));
    }
  },
};

export default cdCommand;
