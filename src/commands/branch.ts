// /branch — fork the current conversation at this point (M18.1)
// ============================================================
// Saves the current messages as a NEW session (a branch point), so the user
// can keep exploring from here while the original session stays intact. The
// new branch is resumed immediately; the old session remains resumable via
// /sessions. This mirrors Claude Code's "fork current messages" semantics
// without a tree data structure — each branch is just its own session file.
// ============================================================
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const branchCommand: SlashCommand = {
  name: "branch",
  description: "Fork the conversation into a new session at this point",
  run: async (_args, ctx) => {
    if (!ctx.persistence) {
      console.log(chalk.yellow("  Session persistence is not available; cannot branch."));
      return;
    }
    if (ctx.messages.length === 0) {
      console.log(chalk.yellow("  Nothing to branch — the conversation is empty."));
      return;
    }

    // Snapshot the current messages into a brand-new session file.
    const newId = ctx.persistence.generateId();
    await ctx.persistence.save(newId, [...ctx.messages]);

    console.log(chalk.gray(`  Branched ${ctx.messages.length} messages into a new session.`));
    console.log(chalk.gray(`  New session: ${chalk.cyan(newId.slice(0, 8) + "...")}`));
    console.log(chalk.gray(`  Resume it with: /resume ${newId.slice(0, 8)}`));
    console.log(chalk.gray("  (The current session is unchanged.)"));
  },
};

export default branchCommand;
