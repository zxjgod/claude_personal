// /schedule — list or cancel cron-scheduled prompts (M18.14)
// ============================================================
// The schedule_cron / sleep tools register jobs that fire while the REPL is
// idle (see breadth/orchestration.ts). This command surfaces those jobs and lets the user
// cancel one by id (or all). Read by default; "/schedule cancel <id>" or
// "/schedule clear" mutate. Both waiting and queued jobs are scoped to the
// current workspace and session; durable tasks are workspace-wide.
// ============================================================
import chalk from "chalk";
import { listScheduledJobs, removeScheduledJob } from "../tools/breadth/orchestration.js";
import { ensureDurableJobsLoaded } from "../tools/extended/cron-shared.js";
import { cancelScheduledInputs } from "../tools/extended/schedule-scope.js";
import type { SlashCommand } from "./types.js";

export const scheduleCommand: SlashCommand = {
  name: "schedule",
  description: "List or cancel cron-scheduled prompts (/schedule [cancel <id> | clear])",
  run: (args, ctx): undefined => {
    ensureDurableJobsLoaded(ctx.workspaceRoot);
    const [sub, target] = args.trim().split(/\s+/);

    if (sub === "clear") {
      const jobs = listScheduledJobs(ctx);
      for (const j of jobs) removeScheduledJob(j.id, ctx);
      const queued = cancelScheduledInputs("cron", undefined, ctx);
      console.log(chalk.gray(`  Cancelled ${jobs.length + queued} scheduled job(s).`));
      return;
    }

    if (sub === "cancel") {
      if (!target) {
        console.log(chalk.yellow("  Usage: /schedule cancel <id>"));
        return;
      }
      const ok = removeScheduledJob(target, ctx);
      console.log(
        ok ? chalk.gray(`  Cancelled job ${target}.`) : chalk.yellow(`  No job with id ${target}.`),
      );
      return;
    }

    const jobs = listScheduledJobs(ctx);
    console.log("");
    console.log(chalk.bold(`  Scheduled jobs (${jobs.length}):`));
    if (jobs.length === 0) {
      console.log(chalk.gray("    None. Use the schedule_cron tool to add one."));
      return;
    }
    for (const j of jobs) {
      const kind = j.recurring ? "recurring" : "one-shot";
      const flags = [kind, j.durable ? "durable" : null].filter(Boolean).join(", ");
      const preview = j.prompt.length > 50 ? j.prompt.slice(0, 47) + "…" : j.prompt;
      console.log(`    ${chalk.cyan(j.id)}  ${chalk.gray(`"${j.cron}"`)}  [${flags}]`);
      console.log(chalk.gray(`        ${preview}`));
    }
    console.log(chalk.gray("    Cancel with /schedule cancel <id> or /schedule clear."));
  },
};

export default scheduleCommand;
