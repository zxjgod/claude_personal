// /sessions — list and delete saved sessions
import chalk from "chalk";
import type { SessionMeta } from "../persistence.js";
import type { SlashCommand } from "./types.js";

function formatSession(s: SessionMeta, currentId: string): string {
  const marker = s.sessionId === currentId ? chalk.green("*") : " ";
  return `  ${marker} ${s.sessionId.slice(0, 8)}... — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()} — ${s.completed ? "done" : "open"}`;
}

function findSessionByPrefix(sessions: SessionMeta[], idOrPrefix: string): SessionMeta[] {
  return sessions.filter((s) => s.sessionId === idOrPrefix || s.sessionId.startsWith(idOrPrefix));
}

async function deleteSession(
  args: string,
  force: boolean,
  ctx: Parameters<SlashCommand["run"]>[1],
): Promise<void> {
  const idOrPrefix = args.trim();
  if (!idOrPrefix) {
    console.log(chalk.yellow("  Usage: /sessions delete <session-prefix-or-id>"));
    return;
  }

  const sessions = await ctx.persistence!.listSessions();
  const matches = findSessionByPrefix(sessions, idOrPrefix);
  if (matches.length === 0) {
    console.log(chalk.yellow(`  No session matches: ${idOrPrefix}`));
    return;
  }
  if (matches.length > 1) {
    console.log(
      chalk.yellow(`  ${matches.length} sessions match ${idOrPrefix}; use a longer prefix:`),
    );
    for (const s of matches.slice(0, 10)) console.log(formatSession(s, ctx.sessionId));
    return;
  }

  const match = matches[0]!;

  // Require confirmation before deleting (unless --force flag is used)
  if (!force && ctx.input) {
    const shortId = match.sessionId.slice(0, 8);
    const confirmed = await ctx.input.askConfirmation(
      `Delete session ${shortId}... (${match.messageCount} msgs)? [y/N] `,
    );
    if (!confirmed) {
      console.log(chalk.gray("  Cancelled."));
      return;
    }
  }

  await ctx.persistence!.deleteSession(match.sessionId);
  console.log(chalk.gray(`  Deleted session ${match.sessionId.slice(0, 8)}...`));
}

export const sessionsCommand: SlashCommand = {
  name: "sessions",
  description: "List or delete saved sessions",
  run: async (args, ctx) => {
    if (!ctx.persistence) {
      console.log(chalk.yellow("  Session persistence is not available."));
      return;
    }

    const trimmed = args.trim();
    const deleteMatch = trimmed.match(/^(delete|rm|remove)\s+(.+)$/i);
    if (deleteMatch) {
      const rawArgs = deleteMatch[2]!;
      const force = /\s+--force$/i.test(rawArgs);
      const sessionIdArg = rawArgs.replace(/\s+--force$/i, "");
      await deleteSession(sessionIdArg, force, ctx);
      return;
    }
    if (/^(delete|rm|remove)$/i.test(trimmed)) {
      console.log(chalk.yellow("  Usage: /sessions delete <session-prefix-or-id>"));
      return;
    }

    const sessions = await ctx.persistence.listSessions();
    if (sessions.length === 0) {
      console.log(chalk.gray("  No saved sessions."));
      return;
    }
    console.log("");
    console.log(chalk.bold("  Sessions:"));
    for (const s of sessions.slice(0, 10)) console.log(formatSession(s, ctx.sessionId));
    console.log(chalk.gray("  Use /resume <session-prefix-or-id> to switch."));
    console.log(chalk.gray("  Use /sessions delete <session-prefix-or-id> to delete history."));
  },
};

export default sessionsCommand;
