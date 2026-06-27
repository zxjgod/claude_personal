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
import type { SlashCommand } from "./types.js";

// Mirror agent-loop.ts: auto-compaction fires above this many estimated tokens.
const AUTO_COMPACT_THRESHOLD = 150_000;

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show context composition, token usage, and compaction headroom",
  run: (_args, ctx) => {
    // ~4 chars per token is the heuristic the agent loop's estimateTokens uses.
    const estTokens = (text: string) => Math.round(text.length / 4);

    let sysTokens = ctx.systemPrompt ? estTokens(ctx.systemPrompt) : 0;
    let userTokens = 0;
    let assistantTokens = 0;
    let toolTokens = 0;

    for (const m of ctx.messages) {
      if (m.role === "user") {
        for (const block of m.content) {
          if (block.type === "text") userTokens += estTokens(block.text);
        }
      } else if (m.role === "assistant") {
        if (typeof m.content === "string") assistantTokens += estTokens(m.content);
        for (const tc of m.tool_calls ?? []) {
          assistantTokens += estTokens(tc.function.arguments) + estTokens(tc.function.name);
        }
      } else if (m.role === "tool") {
        toolTokens += estTokens(m.content);
      } else if (m.role === "system") {
        sysTokens += estTokens(m.content);
      }
    }

    const total = sysTokens + userTokens + assistantTokens + toolTokens;
    const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");

    console.log("");
    console.log(chalk.bold("  Context (estimated tokens):"));
    console.log(
      `    System prompt: ${chalk.cyan(sysTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(sysTokens))}`,
    );
    console.log(
      `    User msgs:     ${chalk.cyan(userTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(userTokens))}`,
    );
    console.log(
      `    Assistant:     ${chalk.cyan(assistantTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(assistantTokens))}`,
    );
    console.log(
      `    Tool results:  ${chalk.cyan(toolTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(toolTokens))}`,
    );
    console.log(
      `    ${chalk.bold("Total:")}         ${chalk.cyan(total.toLocaleString().padStart(8))}`,
    );

    // --- Compaction headroom (18.8) ---
    const usedRatio = total / AUTO_COMPACT_THRESHOLD;
    const usedPct = Math.round(usedRatio * 100);
    const barWidth = 24;
    const filled = Math.min(barWidth, Math.round(usedRatio * barWidth));
    const barColor = usedRatio >= 0.9 ? chalk.red : usedRatio >= 0.6 ? chalk.yellow : chalk.green;
    const bar = barColor("█".repeat(filled)) + chalk.gray("░".repeat(barWidth - filled));

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
      const remaining = AUTO_COMPACT_THRESHOLD - total;
      console.log(
        chalk.gray(`    ${remaining.toLocaleString()} tokens of headroom before auto-compaction.`),
      );
    }
    console.log(chalk.gray(`    (~4 chars/token heuristic; ${ctx.messages.length} messages)`));
  },
};

export default contextCommand;
