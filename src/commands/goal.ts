// /goal — set or view this session's objective (M18.12)
// ============================================================
// A short objective the user wants the assistant to keep in view. When set,
// the CLI appends it to the turn's system prompt (the [SESSION GOAL] block)
// so the model stays anchored to the goal across turns. Stored in a mutable
// holder on CommandContext so the REPL reads the same reference. "/goal clear"
// removes it; "/goal" with no args shows the current goal.
// ============================================================
import chalk from "chalk";
import { sessionGoal, setSessionGoal } from "../goal-runtime.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

export const goalCommand: SlashCommand = {
  name: "goal",
  description: "Set or view the session goal (/goal <text> | /goal clear)",
  run: (args, ctx): undefined => {
    if (!ctx.goal) {
      console.log(chalk.gray("  Session goals are not available in this session."));
      return;
    }
    const arg = args.trim();

    if (arg.toLowerCase() === "clear") {
      ctx.goal.value = "";
      setSessionGoal(ctx.sessionId, "");
      void ctx.persistence
        ?.save(ctx.sessionId, ctx.messages)
        .catch((error) =>
          console.warn(
            `Goal persistence failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
          ),
        );
      console.log(chalk.gray("  Session goal cleared."));
      return;
    }

    if (!arg) {
      if (ctx.goal.value) {
        console.log(`  ${chalk.bold("Goal:")} ${sanitizeTerminalText(ctx.goal.value)}`);
        const state = sessionGoal(ctx.sessionId);
        if (state?.complete) console.log(chalk.gray("  Goal completed."));
        else if (state?.suspended)
          console.log(
            chalk.yellow(
              `  Automatic goal work paused: ${sanitizeTerminalText(state.reason ?? "evaluation unavailable")}`,
            ),
          );
        console.log(chalk.gray("  Change it with /goal <text>, or /goal clear."));
      } else {
        console.log(chalk.gray("  No goal set. Set one with /goal <text>."));
      }
      return;
    }

    ctx.goal.value = arg;
    setSessionGoal(ctx.sessionId, arg);
    void ctx.persistence
      ?.save(ctx.sessionId, ctx.messages)
      .catch((error) =>
        console.warn(
          `Goal persistence failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
        ),
      );
    console.log(chalk.gray(`  Goal set: ${chalk.cyan(sanitizeTerminalText(arg))}`));
    console.log(chalk.gray("  It will be injected into the system prompt on the next turn."));
  },
};

export default goalCommand;
