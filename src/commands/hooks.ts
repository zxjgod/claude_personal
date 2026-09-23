// /hooks — list registered tool and lifecycle hooks (M18.13)
// ============================================================
// Hooks intercept, block, or rewrite tool calls and observe lifecycle
// events (see hooks.ts). They are registered programmatically in cli.ts;
// this command surfaces what's active so the user can see why a tool call
// might be blocked or rewritten. It is read-only — enabling/disabling
// specific hooks is left to config, matching the lightweight "inspect,
// don't micromanage" stance.
// ============================================================
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const hooksCommand: SlashCommand = {
  name: "hooks",
  description: "List registered tool and lifecycle hooks",
  run: (_args, ctx): undefined => {
    if (!ctx.hooks) {
      console.log(chalk.gray("  Hook registry is not available in this session."));
      return;
    }
    const entries = ctx.hooks.list();
    console.log("");
    console.log(chalk.bold(`  Hooks (${entries.length} registered):`));
    if (entries.length === 0) {
      console.log(chalk.gray("    None. Register hooks in .claude/settings.json or cli.ts."));
      return;
    }
    for (const h of entries) {
      const phases = [
        h.pre ? "PreToolUse" : null,
        h.post ? "PostToolUse" : null,
        h.stop ? "Stop" : null,
        h.event ? "Event" : null,
      ]
        .filter(Boolean)
        .join(" + ");
      const matcher = h.matcher === "*" ? chalk.yellow("* (all tools)") : chalk.cyan(h.matcher);
      console.log(`    ${matcher} — ${chalk.gray(phases)}`);
    }
  },
};

export default hooksCommand;
