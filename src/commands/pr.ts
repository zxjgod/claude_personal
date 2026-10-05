// /pr — draft a PR description from commits/changes vs upstream
import chalk from "chalk";
import { type GitDiffSummary, gatherDiffSummary, suggestCommitSubject } from "../git-context.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const prCommand: SlashCommand = {
  name: "pr",
  description: "Draft a PR description from commits/changes vs upstream",
  run: async (_args, ctx): Promise<undefined> => {
    const summary = await gatherDiffSummary(ctx.workspaceRoot);
    if (!summary) {
      console.log(chalk.yellow("  Not a git repository (or git unavailable)."));
      return;
    }
    if (summary.upstreamFiles.length === 0 && summary.branchCommits.length === 0) {
      console.log(chalk.gray("  No upstream tracking branch or no commits ahead of it."));
      console.log(chalk.gray("  Push your branch first, then /pr."));
      return;
    }
    console.log("");
    // Branch name, commit subjects, file paths and status letters are all
    // repo-controlled on a freshly cloned repository — sanitize before print.
    console.log(chalk.bold(`  PR draft — ${sanitizeTerminalText(summary.branch)}:`));
    console.log("");
    // Title: reuse the commit-subject heuristic on the upstream diff.
    const upstreamSummary: GitDiffSummary = { ...summary, files: summary.upstreamFiles };
    console.log(`    ${chalk.green(sanitizeTerminalText(suggestCommitSubject(upstreamSummary)))}`);
    console.log("");
    if (summary.branchCommits.length > 0) {
      console.log(chalk.bold("  Commits on this branch:"));
      for (const c of summary.branchCommits) console.log(`    - ${sanitizeTerminalText(c)}`);
      console.log("");
    }
    console.log(chalk.bold("  Files changed vs upstream:"));
    for (const f of summary.upstreamFiles) {
      console.log(
        `    ${sanitizeTerminalText(f.status).padEnd(2)} ${chalk.cyan(sanitizeTerminalText(f.path))}`,
      );
    }
    console.log("");
    console.log(chalk.gray("  Body suggestion: summarize what changed and why, then"));
    console.log(chalk.gray("  create with:  gh pr create --body-file <(echo ...)"));
    console.log(chalk.gray("  (This is a draft — refine before posting.)"));
  },
};

export default prCommand;
