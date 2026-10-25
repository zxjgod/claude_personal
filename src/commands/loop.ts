import chalk from "chalk";
import {
  currentLoop,
  type LoopScope,
  loopArchive,
  pauseLoop,
  resumeLoop,
  startLoop,
  stopLoop,
  takeDueLoop,
} from "../loop-runtime.js";
import { LOOP_PROFILES, loopConfig } from "../loop-settings.js";
import { cancelAllWakeupJobs, listWakeupJobs } from "../tools/extended/schedule-wakeup.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export function loopStatusLines(scope: LoopScope): string[] {
  const record = currentLoop(scope);
  if (!record) return ["No managed loop in this session."];
  return [
    `${LOOP_PROFILES[record.config.profile].name} · ${record.status}${record.pauseRequested ? " (pause requested)" : ""}`,
    `Task: ${sanitizeTerminalText(record.objective)}`,
    `Rounds: ${record.rounds}/${record.config.maxRounds ?? "continuous"} · ${record.config.cadence} · ${record.config.intervalMinutes} min`,
    `Tokens: ${(record.inputTokens + record.outputTokens).toLocaleString()}/${record.config.tokenBudget || "unlimited"} · reserved ${record.reservedTokens.toLocaleString()}`,
    `Estimated cost: ${record.costKnown ? `$${record.estimatedUsd.toFixed(4)}` : "unknown"}${record.config.usdBudget ? `/$${record.config.usdBudget}` : ""}`,
    `Next: ${record.nextRunAt === null ? "none" : new Date(record.nextRunAt).toLocaleString("en", { timeZone: record.config.timezone })}`,
    `Reason: ${sanitizeTerminalText(record.reason)}`,
  ];
}
export const loopCommand: SlashCommand = {
  name: "loop",
  description: "Manage verified iterations and scheduled checks (/loop)",
  run: (args, ctx) => {
    const scope = { workspaceRoot: ctx.workspaceRoot, sessionId: ctx.sessionId };
    const trimmed = args.trim();
    const [action] = trimmed.split(/\s+/);
    if (!trimmed || action === "status") {
      for (const line of loopStatusLines(scope)) console.log(chalk.gray(`  ${line}`));
      console.log(
        chalk.gray(
          "  /loop <task> · /loop pause [now] · /loop resume · /loop stop · /loop history",
        ),
      );
      for (const wakeup of listWakeupJobs(ctx))
        console.log(
          chalk.gray(
            `  Legacy wakeup ${sanitizeTerminalText(wakeup.id)}: ${sanitizeTerminalText(wakeup.prompt)}`,
          ),
        );
      return;
    }
    if (action === "stop") {
      const record = currentLoop(scope);
      if (record) stopLoop(scope);
      else {
        const cancelled = cancelAllWakeupJobs(ctx);
        console.log(chalk.gray(`  Cancelled ${cancelled} legacy wakeup(s).`));
      }
      console.log(chalk.gray("  Loop stopped. No further iterations will be scheduled."));
      return;
    }
    if (action === "pause") {
      pauseLoop(scope, trimmed === "pause now");
      for (const line of loopStatusLines(scope)) console.log(chalk.gray(`  ${line}`));
      return;
    }
    if (action === "resume") {
      resumeLoop(scope);
      console.log(chalk.gray("  Loop resumed with counters and limits retained."));
      return;
    }
    if (action === "history") {
      const record = currentLoop(scope);
      for (const entry of record?.history ?? [])
        console.log(
          chalk.gray(
            `  ${new Date(entry.at).toLocaleTimeString()} · round ${entry.round} · ${entry.event} · ${sanitizeTerminalText(entry.summary)}`,
          ),
        );
      console.log(chalk.gray(`  ${loopArchive(scope).length} previous loop(s) saved.`));
      return;
    }
    const task = action === "start" ? trimmed.slice(5).trim() : trimmed;
    const config = loopConfig(scope.workspaceRoot);
    startLoop(scope, task, config);
    const prompt = takeDueLoop(scope);
    console.log(chalk.gray(`  Loop started in ${LOOP_PROFILES[config.profile].name} mode.`));
    // Quality guidance (progress-anchor design): without machine-checkable
    // acceptance the loop can only end on a model's self-assessment, which
    // is exactly the "declares victory" failure mode the completion gate
    // exists to prevent.
    if (config.completion !== "continuous" && !config.commands.length && !config.files.length)
      console.log(
        chalk.yellow(
          "  No completion checks configured — add commands/files (menu item 6) so quality is verified objectively, not self-reported.",
        ),
      );
    return prompt ? { prompt } : undefined;
  },
};
export default loopCommand;
