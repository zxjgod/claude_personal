// /review — review the current git diff (M18.3)
// ============================================================
// Injects a code-review prompt into the agent loop. The model reads the
// workspace diff itself (via the bash/git tools) and returns a structured
// review. This mirrors B's `commands/review` (`type: 'prompt'`) but works
// against the local working tree instead of a GitHub PR, since this is a
// local-first tool.
// ============================================================
import chalk from "chalk";
import type { CommandResult, SlashCommand } from "./types.js";

export const reviewCommand: SlashCommand = {
  name: "review",
  description: "Review the current git changes (working-tree diff)",
  run: (_args, ctx): CommandResult | void => {
    const prompt = [
      `You are an expert code reviewer. Review the current uncommitted changes in the workspace at \`${ctx.workspaceRoot}\`.`,
      ``,
      `Steps:`,
      `1. Run \`git status\` and \`git diff HEAD\` to see what changed.`,
      `2. Read the changed files for full context where needed.`,
      `3. Provide a concise but thorough review:`,
      `   - Overview of what the changes do`,
      `   - Correctness issues or bugs`,
      `   - Adherence to project conventions (check CLAUDE.md if present)`,
      `   - Performance / security considerations`,
      `   - Concrete, specific suggestions (cite file:line)`,
      `4. End with a short "Verdict: looks good / needs changes" summary.`,
      ``,
      `Focus on substance, not style nits. If there are no changes, say so.`,
    ].join("\n");

    console.log(chalk.gray("  Reviewing current changes…"));
    return { handled: true, prompt };
  },
};

export default reviewCommand;
