// /sessions — list, search, pin, and delete saved sessions
import chalk from "chalk";
import type { SessionCatalogEntry, SessionMeta } from "../persistence.js";
import type { SlashCommand } from "./types.js";

type SessionRow = SessionMeta | SessionCatalogEntry;

function isCatalogEntry(s: SessionRow): s is SessionCatalogEntry {
  return "pinned" in s || "preview" in s;
}

function formatSession(s: SessionRow, currentId: string): string {
  const marker = s.sessionId === currentId ? chalk.green("*") : " ";
  const pin = isCatalogEntry(s) && s.pinned ? chalk.yellow("📌 ") : "   ";
  const state = s.taskState;
  const preview = isCatalogEntry(s) && s.preview ? chalk.gray(` — ${s.preview}`) : "";
  return `  ${marker} ${pin}${s.sessionId.slice(0, 8)}... — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()} — ${state}${preview}`;
}

function findSessionByPrefix(sessions: SessionMeta[], idOrPrefix: string): SessionMeta[] {
  return sessions.filter((s) => s.sessionId === idOrPrefix || s.sessionId.startsWith(idOrPrefix));
}

async function resolveSession(
  ctx: Parameters<SlashCommand["run"]>[1],
  idOrPrefix: string,
): Promise<SessionMeta | null> {
  const sessions = await ctx.persistence!.listSessions();
  const matches = findSessionByPrefix(sessions, idOrPrefix);
  if (matches.length === 0) {
    console.log(chalk.yellow(`  Session not found: ${idOrPrefix}`));
    return null;
  }
  if (matches.length > 1) {
    console.log(chalk.yellow(`  Ambiguous session prefix: ${idOrPrefix}`));
    for (const s of matches.slice(0, 10)) console.log(formatSession(s, ctx.sessionId));
    return null;
  }
  return matches[0]!;
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

  const match = await resolveSession(ctx, idOrPrefix);
  if (!match) return;

  if (!force && match.sessionId === ctx.sessionId) {
    console.log(
      chalk.yellow(
        "  Refusing to delete the current session. Use /sessions delete <id> --force if you really want to.",
      ),
    );
    return;
  }

  await ctx.persistence!.deleteSession(match.sessionId);
  console.log(chalk.gray(`  Deleted session ${match.sessionId.slice(0, 8)}...`));
}

async function pinSession(
  args: string,
  pinned: boolean,
  ctx: Parameters<SlashCommand["run"]>[1],
): Promise<void> {
  const idOrPrefix = args.trim();
  if (!idOrPrefix) {
    console.log(
      chalk.yellow(`  Usage: /sessions ${pinned ? "pin" : "unpin"} <session-prefix-or-id>`),
    );
    return;
  }
  const match = await resolveSession(ctx, idOrPrefix);
  if (!match) return;
  await ctx.persistence!.setPinned(match.sessionId, pinned);
  console.log(
    chalk.gray(`  ${pinned ? "Pinned" : "Unpinned"} session ${match.sessionId.slice(0, 8)}...`),
  );
}

async function searchSessions(
  query: string,
  ctx: Parameters<SlashCommand["run"]>[1],
): Promise<void> {
  if (!query.trim()) {
    console.log(chalk.yellow("  Usage: /sessions search <keyword>"));
    return;
  }
  const matches = await ctx.persistence!.searchSessions(query);
  if (matches.length === 0) {
    console.log(chalk.gray(`  No sessions matched: ${query}`));
    return;
  }
  console.log("");
  console.log(chalk.bold(`  Sessions matching "${query}":`));
  for (const s of matches.slice(0, 20)) console.log(formatSession(s, ctx.sessionId));
  if (matches.length > 20) console.log(chalk.gray(`  … ${matches.length - 20} more`));
}

export const sessionsCommand: SlashCommand = {
  name: "sessions",
  description: "List, search, pin, or delete saved sessions",
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

    const pinMatch = trimmed.match(/^(pin|unpin)\s+(.+)$/i);
    if (pinMatch) {
      await pinSession(pinMatch[2]!, pinMatch[1]!.toLowerCase() === "pin", ctx);
      return;
    }
    if (/^(pin|unpin)$/i.test(trimmed)) {
      console.log(
        chalk.yellow(`  Usage: /sessions ${trimmed.toLowerCase()} <session-prefix-or-id>`),
      );
      return;
    }

    const searchMatch = trimmed.match(/^(search|find)\s+(.+)$/i);
    if (searchMatch) {
      await searchSessions(searchMatch[2]!, ctx);
      return;
    }
    if (/^(search|find)$/i.test(trimmed)) {
      console.log(chalk.yellow("  Usage: /sessions search <keyword>"));
      return;
    }

    const sessions = await ctx.persistence.searchSessions("");
    if (sessions.length === 0) {
      console.log(chalk.gray("  No saved sessions."));
      return;
    }
    console.log("");
    console.log(chalk.bold("  Sessions:"));
    for (const s of sessions.slice(0, 10)) console.log(formatSession(s, ctx.sessionId));
    console.log(chalk.gray("  Use /resume <session-prefix-or-id> to switch."));
    console.log(chalk.gray("  Use /sessions search <keyword> to find by id/date/preview."));
    console.log(
      chalk.gray("  Use /sessions pin|unpin <session-prefix-or-id> to keep sessions on top."),
    );
    console.log(chalk.gray("  Use /sessions delete <session-prefix-or-id> to delete history."));
  },
};

export default sessionsCommand;
