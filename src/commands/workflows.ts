// ============================================================
// /workflows — list workflow runs (Phase 3)
// ============================================================

import chalk from "chalk";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import { listWorkflows } from "../workflow.js";
import type { SlashCommand } from "./types.js";

export const workflowsCommand: SlashCommand = {
  name: "workflows",
  description: "List workflow runs (fan-out orchestration)",
  run: (): undefined => {
    const workflows = listWorkflows();
    console.log("");
    console.log(chalk.bold(`  Workflows (${workflows.length}):`));
    if (workflows.length === 0) {
      console.log(chalk.gray("    None yet. The workflow tool records runs here."));
      return;
    }
    for (const wf of workflows.slice(0, 20)) {
      // Log lines and the rendered result are model/tool output — the
      // interpreter logs whatever the agents emitted — and this command writes
      // straight to the parent terminal, where nothing strips control bytes.
      const status =
        wf.status === "completed"
          ? chalk.green(wf.status)
          : wf.status === "failed"
            ? chalk.red(wf.status)
            : chalk.yellow(wf.status);
      const dur = wf.finishedAt
        ? `${((wf.finishedAt - wf.startedAt) / 1000).toFixed(1)}s`
        : "running…";
      console.log(`    ${chalk.cyan(sanitizeTerminalText(wf.id))}  ${status}  ${chalk.gray(dur)}`);
      const last = wf.logs.slice(-3);
      for (const l of last) console.log(chalk.gray(`        ${sanitizeTerminalText(l)}`));
      if (wf.result) {
        console.log(chalk.gray(`        → ${sanitizeTerminalText(wf.result).slice(0, 80)}`));
      }
    }
  },
};

export default workflowsCommand;
