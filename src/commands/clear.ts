// /clear — clear the conversation history
import chalk from "chalk";
import { clearChanges } from "../change-tracker.js";
import { resetCheckpoints } from "../checkpoint.js";
import { resetSystemPromptCache } from "../system-prompt.js";
import { clearTodos } from "../tools/extended/todo.js";
import { clearJobs } from "../tools/job-store.js";
import { clearCwd } from "../tools/session-cwd.js";
import type { SlashCommand } from "./types.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear the conversation history",
  run: (_args, ctx): undefined => {
    ctx.messages.length = 0;
    clearChanges(ctx.sessionId);
    // P0-3: the rewind checkpoints belong to the cleared conversation — drop
    // them too, or their turn count would outlive the (now empty) message
    // history and every later rewind mapping would query a stale bucket.
    resetCheckpoints(ctx.sessionId);
    // Release settled background-job output buffers and the remembered cwd for a
    // fresh conversation (running jobs are left alone — they hold live processes).
    clearJobs(ctx.sessionId);
    clearCwd(ctx.sessionId);
    // The todo list belongs to the cleared conversation — drop it so the next
    // session (and the TUI's pinned projection) starts empty.
    clearTodos(ctx.sessionId);
    // The memoized system-prompt sections are scoped to a conversation; a fresh
    // conversation may have different memory/env, so drop the cache (kernel §4).
    resetSystemPromptCache();
    console.log(chalk.gray("  Conversation cleared."));
  },
};

export default clearCommand;
