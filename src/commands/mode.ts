// ============================================================
// /mode — set or show the permission mode (M38)
// ============================================================

import chalk from "chalk";
import { PERMISSION_MODE_CYCLE } from "../tui/store.js";
import type { PermissionMode } from "../types.js";
import type { SlashCommand } from "./types.js";

export const modeCommand: SlashCommand = {
  name: "mode",
  description: "Show or set the permission mode (default | acceptEdits | bypassPermissions | plan)",
  run: (args, ctx) => {
    const current = (ctx.getPermissionMode?.() ??
      ctx.permissionMode ??
      "default") as PermissionMode;

    if (!args.trim()) {
      console.log("");
      console.log(chalk.bold("  Permission Mode:"));
      console.log("");
      for (const m of PERMISSION_MODE_CYCLE) {
        const marker = m === current ? chalk.green("❯") : " ";
        console.log(`  ${marker} ${m.padEnd(20)} ${getModeDescription(m)}`);
      }
      console.log("");
      console.log(chalk.dim("  Use /mode <name> to switch (e.g. /mode bypassPermissions)"));
      console.log(chalk.dim("  Or use Shift+Tab to cycle modes in the TUI."));
      return;
    }

    const target = args.trim().toLowerCase() as PermissionMode;
    if (!PERMISSION_MODE_CYCLE.includes(target)) {
      console.log(chalk.red(`  Unknown mode: ${target}`));
      console.log(chalk.dim("  Available modes:"));
      for (const m of PERMISSION_MODE_CYCLE) {
        console.log(chalk.dim(`    - ${m}`));
      }
      return;
    }

    ctx.setPermissionMode?.(target);
    if (ctx.permissionMode !== undefined) {
      (ctx as { permissionMode: string }).permissionMode = target;
    }
    console.log(chalk.green(`  Permission mode: ${current} → ${target}`));
  },
};

function getModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "Ask before running tools that modify files or execute commands";
    case "acceptEdits":
      return "Auto-approve Read/Edit/Write tools";
    case "bypassPermissions":
      return "Auto-approve all tools except dangerous patterns";
    case "plan":
      return "Plan only — no destructive tool execution";
    default:
      return "Unknown mode";
  }
}

export default modeCommand;
