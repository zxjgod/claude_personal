// /clear — clear the conversation history
import chalk from "chalk";
import { clearChanges } from "../change-tracker.js";
import type { SlashCommand } from "./types.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear the conversation history",
  run: (_args, ctx) => {
    ctx.messages.length = 0;
    clearChanges(ctx.sessionId);
    console.log(chalk.gray("  Conversation cleared."));
  },
};

export default clearCommand;
