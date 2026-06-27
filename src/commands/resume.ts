// /resume — resume a saved session
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a saved session (/resume [id-prefix])",
  run: async (args, ctx) => {
    const id = args.trim();

    // No id: on a TTY the TUI intercepts this and opens an interactive picker
    // (see tui/run.tsx). Reaching here means the line-based REPL — list saved
    // sessions so the user can pick a prefix to pass.
    if (!id) {
      if (!ctx.persistence) {
        console.log(chalk.yellow("  Usage: /resume <session-prefix-or-id>"));
        return;
      }
      const sessions = await ctx.persistence.listSessions();
      if (sessions.length === 0) {
        console.log(chalk.gray("  No saved sessions to resume."));
        return;
      }
      console.log("");
      console.log(chalk.bold("  Sessions (newest first):"));
      for (const s of sessions.slice(0, 10)) {
        const marker = s.sessionId === ctx.sessionId ? chalk.green("*") : " ";
        console.log(
          `  ${marker} ${s.sessionId.slice(0, 8)} — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()} — ${s.completed ? "done" : "open"}`,
        );
      }
      console.log(chalk.gray("  Use /resume <prefix> to restore one (no tokens used)."));
      return;
    }

    if (!ctx.resumeSession) {
      console.log(chalk.yellow("  Resume is not available."));
      return;
    }
    const ok = await ctx.resumeSession(id);
    if (!ok) {
      console.log(chalk.yellow(`  Session not found or ambiguous: ${id}`));
    }
  },
};

export default resumeCommand;
