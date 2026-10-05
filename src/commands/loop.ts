// /loop — dynamic self-paced loop mode (M41)
// ============================================================
// Starts a task that runs in iterations: each turn the agent works one pass,
// then calls ScheduleWakeup to schedule the next iteration (choosing its own
// delay — see the prompt-cache TTL guidance in the tool). The scheduler loop
// (tools/extended/scheduler.ts) fires due wakeups as synthetic user input
// while the REPL is idle, which re-enters this loop without the user driving
// it. "/loop stop" cancels everything.
// ============================================================
import chalk from "chalk";
import { cancelAllWakeupJobs, listWakeupJobs } from "../tools/extended/schedule-wakeup.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

function loopPrompt(task: string): string {
  return (
    `[Loop mode] You are iterating on this task until it is fully done:\n${task}\n\n` +
    "Run ONE iteration of work now (don't try to finish a long-running task in a single pass). " +
    "At the end of this iteration:\n" +
    "- If the task needs another pass — or you are waiting on something external (a build, a test " +
    "run, time passing) — call the ScheduleWakeup tool with a suitable delaySeconds (60-3600), " +
    'prompt "Loop iteration: <one-line task summary>", and a short reason for the chosen delay.\n' +
    "- If the task is complete, call ScheduleWakeup with stop=true to end the loop.\n" +
    "Never end a loop iteration without calling ScheduleWakeup one way or the other."
  );
}

export const loopCommand: SlashCommand = {
  name: "loop",
  description: "Run a task in self-paced iterations via ScheduleWakeup (/loop <task> | stop)",
  run: (args, ctx) => {
    const trimmed = args.trim();

    if (trimmed === "stop") {
      const n = cancelAllWakeupJobs(ctx);
      console.log(chalk.gray(`  Loop stopped — cancelled ${n} pending wakeup(s).`));
      return;
    }

    if (!trimmed) {
      const wakeups = listWakeupJobs(ctx);
      console.log(chalk.gray("  Usage: /loop <task>  — run the task in self-paced iterations"));
      console.log(chalk.gray("         /loop stop   — cancel all pending wakeups"));
      if (wakeups.length > 0) {
        console.log("");
        console.log(chalk.bold(`  Pending wakeups (${wakeups.length}):`));
        for (const w of wakeups) {
          // The prompt is model/user text and the id may come from a durable
          // .claude/scheduled_tasks.json — sanitize before printing.
          const prompt = sanitizeTerminalText(w.prompt);
          const preview = prompt.length > 50 ? `${prompt.slice(0, 47)}…` : prompt;
          const secs = Math.max(
            0,
            Math.round(Number((w.fireAt - process.hrtime.bigint()) / 1_000_000n)),
          );
          console.log(
            `    ${chalk.cyan(sanitizeTerminalText(w.id))}  in ${secs}s  ${chalk.gray(preview)}`,
          );
        }
      }
      return;
    }

    // Review fix ("loop state clobbering"): starting a new /loop while an
    // old one still had pending wakeups used to leave BOTH alive — two
    // loops interleaving turns and rescheduling themselves, with /loop stop
    // as the only way out. New-loop-is-replace: cancel the session's stale
    // wakeups first so at most one dynamic loop owns this session.
    const replaced = cancelAllWakeupJobs(ctx);
    if (replaced > 0) {
      console.log(
        chalk.gray(`  Replaced the previous loop — cancelled ${replaced} stale wakeup(s).`),
      );
    }
    console.log(
      chalk.gray(
        `  Loop started. Each iteration runs while you're away; watch for "[Scheduled wakeup]" turns. /loop stop ends it.`,
      ),
    );
    return { prompt: loopPrompt(trimmed) };
  },
};

export default loopCommand;
