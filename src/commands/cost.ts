// /cost — show token usage and estimated cost this session
import chalk from "chalk";
import { formatUsd } from "../tui/session-stats.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const costCommand: SlashCommand = {
  name: "cost",
  description: "Show token usage and estimated cost this session",
  run: (_args, ctx): undefined => {
    if (!ctx.stats) {
      console.log(chalk.gray("  No usage recorded yet this session."));
      return;
    }
    const s = ctx.stats;
    const cost = s.cost(ctx.modelConfig.model);
    console.log("");
    console.log(chalk.bold("  Cost:"));
    console.log(`    API calls:    ${chalk.cyan(s.apiCalls)}`);
    console.log(`    Tool calls:   ${chalk.cyan(s.toolCalls)}`);
    console.log(`    Input tokens: ${chalk.cyan(s.inputTokens.toLocaleString())}`);
    console.log(`    Output tokens:${chalk.cyan(" " + s.outputTokens.toLocaleString())}`);
    console.log(`    Total tokens: ${chalk.cyan(s.totalTokens.toLocaleString())}`);
    // 12.3: prompt-cache observability.
    const hit = s.cacheHitRate;
    if (hit !== null && (s.cacheReadTokens > 0 || s.cacheCreationTokens > 0)) {
      console.log(
        `    Cache:        ${chalk.cyan((hit * 100).toFixed(1) + "%")} hit ` +
          chalk.gray(
            `(${s.cacheReadTokens.toLocaleString()} read / ${s.cacheCreationTokens.toLocaleString()} written)`,
          ),
      );
    }
    if (cost === null) {
      console.log(
        chalk.gray(
          `    Est. cost:    unknown (no pricing for ${sanitizeTerminalText(ctx.modelConfig.model)})`,
        ),
      );
    } else {
      console.log(
        `    Est. cost:    ${chalk.green(formatUsd(cost))} ${chalk.gray("(approximate)")}`,
      );
    }
  },
};

export default costCommand;
