// /compact — summarize and compress the conversation now
import chalk from "chalk";
import { autoCompact } from "../agent-loop.js";
import { resetSystemPromptCache } from "../system-prompt.js";
import type { SlashCommand } from "./types.js";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Summarize and compress the conversation now",
  run: async (_args, ctx) => {
    if (ctx.messages.length === 0) {
      console.log(chalk.gray("  Nothing to compact."));
      return;
    }
    const before = ctx.messages.length;
    console.log(chalk.gray("  📦 Compacting..."));
    const compacted = await autoCompact(ctx.messages, ctx.callModel, ctx.modelConfig);
    // Replace contents in place so the caller keeps the same array reference.
    ctx.messages.length = 0;
    ctx.messages.push(...compacted);
    // Compaction resets the context window; invalidate the memoized sections so
    // they are recomputed against the fresh window (kernel §4).
    resetSystemPromptCache();
    console.log(chalk.gray(`  Compacted ${before} → ${ctx.messages.length} messages.`));
  },
};

export default compactCommand;
