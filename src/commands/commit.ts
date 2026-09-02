// /commit — draft a commit message from the current git changes
import chalk from "chalk";
import { gatherDiffSummary, suggestCommitSubject } from "../git-context.js";
import type { SlashCommand } from "./types.js";

export const commitCommand: SlashCommand = {
  name: "commit",
  description: "Draft a commit message from the current git changes",
  run: async (_args, ctx): Promise<undefined> => {
    const summary = await gatherDiffSummary(ctx.workspaceRoot);
    if (!summary) {
      console.log(chalk.yellow("  Not a git repository (or git unavailable)."));
      return;
    }
    if (summary.files.length === 0) {
      console.log(chalk.gray("  No changes to commit (working tree clean vs HEAD)."));
      return;
    }
    console.log("");
    console.log(chalk.bold(`  Commit draft (${summary.branch}):`));
    console.log("");
    console.log(`    ${chalk.green(suggestCommitSubject(summary))}`);
    console.log("");
    console.log(chalk.bold("  Files:"));
    for (const f of summary.files) {
      const tag = f.status.includes("D")
        ? chalk.red("deleted ")
        : f.status.includes("A") || f.status === "??"
          ? chalk.green("added   ")
          : chalk.yellow("modified");
      const stat =
        f.insertions !== undefined && f.deletions !== undefined
          ? chalk.gray(` +${f.insertions}/-${f.deletions}`)
          : "";
      console.log(`    ${tag} ${chalk.cyan(f.path)}${stat}`);
    }
    if (summary.truncated) console.log(chalk.gray("    … (list truncated)"));
    console.log("");
    console.log(chalk.gray("  Review, then run:  git add -A && git commit -e"));
    console.log(chalk.gray("  (This is a draft — edit before committing.)"));
  },
};

export default commitCommand;
