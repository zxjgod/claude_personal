// /context — show context composition and approximate token usage
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show context composition and approximate token usage",
  run: (_args, ctx) => {
    // ~4 chars per token is a rough heuristic shared with the spinner.
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
          assistantTokens += estTokens(tc.function.arguments);
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
    console.log(`    System prompt: ${chalk.cyan(sysTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(sysTokens))}`);
    console.log(`    User msgs:     ${chalk.cyan(userTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(userTokens))}`);
    console.log(`    Assistant:     ${chalk.cyan(assistantTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(assistantTokens))}`);
    console.log(`    Tool results:  ${chalk.cyan(toolTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(toolTokens))}`);
    console.log(`    ${chalk.bold("Total:")}         ${chalk.cyan(total.toLocaleString().padStart(8))}`);
    console.log(chalk.gray(`    (~4 chars/token heuristic; ${ctx.messages.length} messages)`));
  },
};

export default contextCommand;
