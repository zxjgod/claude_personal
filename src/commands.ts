// ============================================================
// Slash Commands — entry (re-exports the M18 directory split)
// ============================================================
// Pre-M18 this file held all commands inline. They now live one-per-file
// under src/commands/<name>.ts, assembled in src/commands/registry.ts.
// This module re-exports the public surface and owns handleSlashCommand
// (which threads the new `prompt` result channel back to the caller).
// ============================================================

import chalk from "chalk";
import { COMMANDS } from "./commands/registry.js";
import type { CommandContext, CommandResult } from "./commands/types.js";

export { COMMANDS } from "./commands/registry.js";
export type {
  CommandContext,
  CommandResult,
  SlashCommand,
  ToolSource,
} from "./commands/types.js";

const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]));

/**
 * Handle a line of input if it is a slash command.
 * Returns handled=false for normal text so the caller sends it to the LLM.
 *
 * M18: a command may return `{ prompt }` to ask the caller to inject that
 * text as a user message and run it through the agent loop (mirrors B's
 * `type: 'prompt'` commands). The caller checks `result.prompt`.
 */
export async function handleSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!input.startsWith("/")) return { handled: false };

  const [rawName, ...rest] = input.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const args = input.slice(1 + rawName.length).trim();
  const cmd = COMMAND_MAP.get(name);

  if (!cmd) {
    console.log(chalk.yellow(`  Unknown command: /${name}. Try /help.`));
    return { handled: true };
  }

  const partial = await cmd.run(args, ctx);
  if (partial && typeof partial === "object") {
    return { handled: true, exit: partial.exit, prompt: partial.prompt };
  }
  return { handled: true };
}
