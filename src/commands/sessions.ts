// /sessions — list saved sessions
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const sessionsCommand: SlashCommand = {
  name: "sessions",
  description: "List saved sessions",
  run: async (_args, ctx) => {
    if (!ctx.persistence) {
      console.log(chalk.yellow("  Session persistence is not available."));
      return;
    }
    const sessions = await ctx.persistence.listSessions();
    if (sessions.length === 0) {
      console.log(chalk.gray("  No saved sessions."));
      return;
    }
    console.log("");
    console.log(chalk.bold("  Sessions:"));
    for (const s of sessions.slice(0, 10)) {
      const marker = s.sessionId === ctx.sessionId ? chalk.green("*") : " ";
      console.log(
        `  ${marker} ${s.sessionId.slice(0, 8)}... — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()} — ${s.completed ? "done" : "open"}`,
      );
    }
    console.log(chalk.gray("  Use /resume <session-prefix-or-id> to switch."));
  },
};

export default sessionsCommand;
