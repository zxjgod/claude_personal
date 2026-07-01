// /clear — clear the conversation history
import chalk from "chalk";
import { clearChanges } from "../change-tracker.js";
import { resetSystemPromptCache } from "../system-prompt.js";
import type { SlashCommand } from "./types.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear the conversation history",
  run: (_args, ctx) => {
    ctx.messages.length = 0;
    clearChanges(ctx.sessionId);
    // The memoized system-prompt sections are scoped to a conversation; a fresh
    // conversation may have different memory/env, so drop the cache (kernel §4).
    resetSystemPromptCache();
    console.log(chalk.gray("  Conversation cleared."));
  },
};

export default clearCommand;
