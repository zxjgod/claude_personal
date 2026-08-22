// /context — show context composition, token usage, and compaction headroom
// ============================================================
// M18.8 enhancement: in addition to the per-role token breakdown, show how
// close the conversation is to the auto-compaction threshold (the same
// 150k-token window the agent loop uses) with a progress bar and a preview
// of what /compact would do. Token counts use the ~4-chars/token heuristic
// shared with the agent loop's estimateTokens — there is no native tokenizer
// dependency, so this stays an estimate, but it now mirrors the real window.
// ============================================================
import chalk from "chalk";
import { estimateTokens } from "../token-estimator.js";
import type { SlashCommand } from "./types.js";

// Mirror agent-loop.ts: auto-compaction fires above this many estimated tokens.
const AUTO_COMPACT_THRESHOLD = 150_000;

function chunkLabel(label: string, value: number, color: typeof chalk.green): string {
  return `    ${label.padEnd(18)} ${color(value.toLocaleString())} tokens`;
}

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show context composition, token usage, and compaction headroom",
  run: async (_args, ctx) => {
    try {
      const messages = ctx.messages;
      const total = estimateTokens(messages);
      const systemTokens = ctx.systemPrompt
        ? estimateTokens([{ role: "system", content: ctx.systemPrompt } as any])
        : 0;
      const messageTokens = Math.max(0, total - systemTokens);
      const usedRatio = Math.min(1, total / AUTO_COMPACT_THRESHOLD);
      const usedPct = Math.round(usedRatio * 100);
      const barWidth = 24;
      const filled = Math.max(0, Math.min(barWidth, Math.round(usedRatio * barWidth)));
      const barColor = usedRatio >= 0.9 ? chalk.red : usedRatio >= 0.6 ? chalk.yellow : chalk.green;
      const bar = barColor("█".repeat(filled)) + chalk.gray("░".repeat(barWidth - filled));
      const recent = messages.slice(-8);
      const recentTokens = estimateTokens(recent);
      const headroom = AUTO_COMPACT_THRESHOLD - total;

      console.log("");
      console.log(chalk.bold("  Context layers:"));
      console.log(chunkLabel("System", systemTokens, chalk.cyan));
      console.log(chunkLabel("Conversation", messageTokens, chalk.cyan));
      console.log(chunkLabel("Recent tail", recentTokens, chalk.cyan));
      console.log(chunkLabel("Total", total, chalk.bold));

      console.log("");
      console.log(chalk.bold("  Compaction window:"));
      console.log(
        `    [${bar}] ${barColor(`${usedPct}%`)} of ${AUTO_COMPACT_THRESHOLD.toLocaleString()} tokens`,
      );
      if (total > AUTO_COMPACT_THRESHOLD) {
        console.log(
          chalk.yellow(
            "    Over the threshold — the next turn will auto-compact. Run /compact to preview.",
          ),
        );
      } else {
        console.log(
          chalk.gray(`    ${headroom.toLocaleString()} tokens of headroom before auto-compaction.`),
        );
      }
      console.log(chalk.gray(`    (~4 chars/token heuristic; ${ctx.messages.length} messages)`));
      if (ctx.systemPrompt) {
        console.log(
          chalk.gray(
            `    System prompt currently contributes about ${systemTokens.toLocaleString()} tokens.`,
          ),
        );
      }
    } catch (error: any) {
      console.log(chalk.yellow(`  Failed to estimate tokens: ${error?.message || error}`));
    }
  },
};

export default contextCommand;
