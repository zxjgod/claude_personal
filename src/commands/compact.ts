// /compact — summarize and compress the conversation now
import chalk from "chalk";
import { autoCompact } from "../auto-compact.js";
import { resetSystemPromptCache } from "../system-prompt.js";
import type { SlashCommand } from "./types.js";

function progressBar(step: number, total: number): string {
  const width = 16;
  const filled = Math.max(0, Math.min(width, Math.round((step / total) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${step}/${total}`;
}

function printCompactProgress(step: number, total: number, label: string): void {
  console.log(chalk.gray(`  ${progressBar(step, total)} ${label}`));
}

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Summarize and compress the conversation now",
  run: async (_args, ctx) => {
    if (ctx.messages.length === 0) {
      console.log(chalk.gray("  Nothing to compact."));
      return;
    }
    const before = ctx.messages.length;
    const total = 4;
    printCompactProgress(1, total, "Preparing conversation for compaction");
    printCompactProgress(2, total, "Trimming cheap context layers");
    printCompactProgress(3, total, "Summarizing with the model");
    const compacted = await autoCompact(ctx.messages, ctx.callModel, ctx.modelConfig);
    // Replace contents in place so the caller keeps the same array reference.
    ctx.messages.length = 0;
    ctx.messages.push(...compacted);
    // Compaction resets the context window; invalidate the memoized sections so
    // they are recomputed against the fresh window (kernel §4).
    resetSystemPromptCache();
    printCompactProgress(total, total, "Compaction complete");
    console.log(chalk.gray(`  Compacted ${before} → ${ctx.messages.length} messages.`));
  },
};

export default compactCommand;
