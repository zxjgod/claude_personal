// /schedule — list or cancel cron-scheduled prompts (M18.14)
// ============================================================
// The schedule_cron / sleep tools register jobs that fire while the REPL is
// idle (see tools-m9.ts). This command surfaces those jobs and lets the user
// cancel one by id (or all). Read by default; "/schedule cancel <id>" or
// "/schedule clear" mutate. The jobs registry is process-global, so no extra
// context plumbing is needed.
// ============================================================
import chalk from "chalk";
import { listScheduledJobs, removeScheduledJob } from "../tools-m9.js";
import type { SlashCommand } from "./types.js";

export const scheduleCommand: SlashCommand = {
  name: "schedule",
  description: "List or cancel cron-scheduled prompts (/schedule [cancel <id> | clear])",
  run: (args) => {
    const [sub, target] = args.trim().split(/\s+/);

    if (sub === "clear") {
      const jobs = listScheduledJobs();
      for (const j of jobs) removeScheduledJob(j.id);
      console.log(chalk.gray(`  Cancelled ${jobs.length} scheduled job(s).`));
      return;
    }

    if (sub === "cancel") {
      if (!target) {
        console.log(chalk.yellow("  Usage: /schedule cancel <id>"));
        return;
      }
      const ok = removeScheduledJob(target);
      console.log(
        ok ? chalk.gray(`  Cancelled job ${target}.`) : chalk.yellow(`  No job with id ${target}.`),
      );
      return;
    }

    const jobs = listScheduledJobs();
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
