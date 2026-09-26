// /context — show context composition, token usage, and compaction headroom
// ============================================================
// M18.8 enhancement: per-role token breakdown plus how close the conversation
// is to the auto-compaction threshold. Top10 follow-ups: the threshold is now
// DERIVED from the model's real context window (same formula as agent-loop —
// the private 150k copy is gone), and on the Anthropic provider the total is
// calibrated against the count_tokens API when reachable (the char heuristic
// drifts 15-35% from the real tokenizer).
// ============================================================
import chalk from "chalk";
import { countTokensAnthropic } from "../anthropic-adapter.js";
import { modelContextWindow } from "../model-metadata.js";
import { estimateTokens } from "../token-estimator.js";
import type { SlashCommand } from "./types.js";

function chunkLabel(label: string, value: number, color: typeof chalk.green): string {
  return `    ${label.padEnd(18)} ${color(value.toLocaleString())} tokens`;
}

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show context composition, token usage, and compaction headroom",
  run: async (_args, ctx): Promise<undefined> => {
    try {
      const messages = ctx.messages;
      // Same derivation as agent-loop (#24): window×0.85 when the model is
      // known, historical 150k default otherwise.
      const window = modelContextWindow(ctx.modelConfig.model);
      const threshold = window !== null ? Math.floor(window * 0.85) : 150_000;

      let total = estimateTokens(messages);
      let countedByApi = false;
      const tools = (ctx.tools ?? []).map((t) => t.tool);
      const apiCount = await countTokensAnthropic(
        ctx.modelConfig,
        ctx.systemPrompt ?? "",
        messages,
        tools,
      );
      if (apiCount !== null) {
        total = apiCount;
        countedByApi = true;
      }
      const systemTokens = ctx.systemPrompt
        ? estimateTokens([{ role: "system", content: ctx.systemPrompt }])
        : 0;
      const messageTokens = Math.max(0, total - systemTokens);
      const usedRatio = Math.min(1, total / threshold);
      const usedPct = Math.round(usedRatio * 100);
      const barWidth = 24;
      const filled = Math.max(0, Math.min(barWidth, Math.round(usedRatio * barWidth)));
      const barColor = usedRatio >= 0.9 ? chalk.red : usedRatio >= 0.6 ? chalk.yellow : chalk.green;
      const bar = barColor("█".repeat(filled)) + chalk.gray("░".repeat(barWidth - filled));
      const recent = messages.slice(-8);
      const recentTokens = estimateTokens(recent);
      const headroom = threshold - total;

      console.log("");
      console.log(chalk.bold("  Context layers:"));
      console.log(chunkLabel("System", systemTokens, chalk.cyan));
      console.log(chunkLabel("Conversation", messageTokens, chalk.cyan));
      console.log(chunkLabel("Recent tail", recentTokens, chalk.cyan));
      console.log(chunkLabel("Total", total, chalk.bold));

      console.log("");
      console.log(chalk.bold("  Compaction window:"));
      console.log(
        `    [${bar}] ${barColor(`${usedPct}%`)} of ${threshold.toLocaleString()} tokens`,
      );
      if (total > threshold) {
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
      console.log(
        chalk.gray(
          countedByApi
            ? `    (count_tokens API ground truth; ${messages.length} messages)`
            : `    (~chars/token heuristic estimate; ${messages.length} messages)`,
        ),
      );
      if (window !== null) {
        console.log(chalk.gray(`    Model context window: ${window.toLocaleString()} tokens.`));
      }
      if (ctx.systemPrompt) {
        console.log(
          chalk.gray(
            `    System prompt currently contributes about ${systemTokens.toLocaleString()} tokens.`,
          ),
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`  Failed to estimate tokens: ${detail}`));
    }
  },
};

export default contextCommand;
