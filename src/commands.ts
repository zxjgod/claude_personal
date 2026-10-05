// ============================================================
// Slash Commands — entry (re-exports the M18 directory split)
// ============================================================
// Pre-M18 this file held all commands inline. They now live one-per-file
// under src/commands/<name>.ts, assembled in src/commands/registry.ts.
// This module re-exports the public surface and owns handleSlashCommand
// (which threads the new `prompt` result channel back to the caller).
// ============================================================

import chalk from "chalk";
import { getCustomCommands } from "./commands/loadCommandsDir.js";
import { COMMANDS } from "./commands/registry.js";
import type { CommandContext, CommandResult } from "./commands/types.js";
import { activateSkill } from "./scoped-execution.js";
import { runForkSkill } from "./skills/forkSkill.js";
import { getSkill, resolveSkillPrompt } from "./skills.js";
import { sanitizeTerminalText } from "./tui/terminal-width.js";
import type { PermissionMode } from "./types.js";

export {
  getCustomCommands,
  loadCommandsDir,
  registerCustomCommand,
  resetCustomCommands,
} from "./commands/loadCommandsDir.js";
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

  const [rawName] = input.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const args = input.slice(1 + rawName.length).trim();
  // Built-in commands take precedence; disk-defined commands are consulted
  // after them (a custom command may not shadow a built-in).
  const cmd = COMMAND_MAP.get(name) ?? getCustomCommands().get(name);

  if (!cmd) {
    // Slash sugar (kernel §Skill point 3): `/<name>` that isn't a built-in
    // command may be a skill. Expand it to the skill's prompt body and hand it
    // back as a prompt Command for the caller to run through the agent loop —
    // exactly what the model would get from the Skill tool. Inline skills only;
    // fork skills must go through the Skill tool (they spawn a sub-agent).
    const skill = getSkill(name);
    if (skill && skill.userInvocable !== false) {
      try {
        const prompt = await resolveSkillPrompt(skill, {
          args,
          workspaceRoot: ctx.workspaceRoot,
        });
        if (skill.context === "fork") {
          const result = await runForkSkill(
            skill,
            prompt,
            {
              workspaceRoot: ctx.workspaceRoot,
              sessionId: `${ctx.sessionId}-skill-${Date.now()}`,
              permissionMode: (ctx.getPermissionMode?.() ??
                ctx.permissionMode ??
                "default") as PermissionMode,
              permissionPolicy: ctx.permissionPolicy,
              modelConfig: ctx.modelConfig,
              hooks: ctx.hooks,
              askUser: async (tool, input) =>
                ctx.input
                  ? ctx.input.askConfirmation(
                      `Allow skill tool ${tool.name}: ${JSON.stringify(input)}? [y/N]`,
                    )
                  : false,
            },
            ctx.callModel,
          );
          // Fork-skill output is sub-agent (model) prose — sanitize before print.
          const out = sanitizeTerminalText(result.content);
          console.log(result.error ? `${sanitizeTerminalText(result.error)}\n${out}` : out);
          return { handled: true };
        }
        activateSkill(ctx.sessionId, skill);
        return { handled: true, prompt };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // Skill load errors can embed SKILL.md frontmatter (untrusted project
        // content) via zod messages — sanitize before print.
        console.log(
          chalk.yellow(`  Skill /${name} failed to load: ${sanitizeTerminalText(detail)}`),
        );
        return { handled: true };
      }
    }
    console.log(chalk.yellow(`  Unknown command: /${name}. Try /help.`));
    return { handled: true };
  }

  const partial = await cmd.run(args, ctx);
  if (partial && typeof partial === "object") {
    return { handled: true, exit: partial.exit, prompt: partial.prompt };
  }
  return { handled: true };
}
