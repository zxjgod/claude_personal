// /branch — fork the current conversation at this point (M18.1)
// ============================================================
// Saves a snapshot of the current messages as a NEW session (a branch point).
// The CURRENT session keeps running unchanged — the new branch is NOT resumed
// automatically; the user switches to it explicitly via /resume <id> (the
// command prints the exact invocation). This mirrors Claude Code's "fork
// current messages" semantics without a tree data structure — each branch is
// just its own session file. (#45: the header used to claim the branch was
// "resumed immediately" — it never was.)
// ============================================================
import chalk from "chalk";
import { forkCheckpoints, resetCheckpoints, turnOfMessage } from "../checkpoint.js";
import type { SlashCommand } from "./types.js";

export const branchCommand: SlashCommand = {
  name: "branch",
  description: "Fork the conversation into a new session at this point",
  run: async (_args, ctx): Promise<undefined> => {
    if (!ctx.persistence) {
      console.log(chalk.yellow("  Session persistence is not available; cannot branch."));
      return;
    }
    if (ctx.messages.length === 0) {
      console.log(chalk.yellow("  Nothing to branch — the conversation is empty."));
      return;
    }

    // Rebind checkpoint tags to the new session; retaining the source id would
    // make /resume <branch> → /rewind silently skip file restoration.
    const newId = ctx.persistence.generateId();
    const branchMessages = ctx.messages.map((message) => {
      const turn = turnOfMessage(message, ctx.sessionId);
      return message.role === "user" && turn !== null
        ? { ...message, checkpoint: { sessionId: newId, turn } }
        : message;
    });
    try {
      await ctx.persistence.save(newId, branchMessages);
      forkCheckpoints(ctx.sessionId, newId);
    } catch (error) {
      // A failed fork must not disturb the current conversation. Clean only
      // artifacts belonging to the newly allocated branch id.
      resetCheckpoints(newId);
      await ctx.persistence.deleteSession(newId).catch(() => {});
      console.error(
        chalk.red("  Failed to create the branch:"),
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    console.log(chalk.gray(`  Branched ${ctx.messages.length} messages into a new session.`));
    console.log(chalk.gray(`  New session: ${chalk.cyan(newId.slice(0, 8) + "...")}`));
    console.log(chalk.gray(`  Resume it with: /resume ${newId.slice(0, 8)}`));
    console.log(chalk.gray("  (The current session is unchanged.)"));
  },
};

export default branchCommand;
