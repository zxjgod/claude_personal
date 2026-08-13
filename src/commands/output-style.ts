// /output-style — list or switch the active output style
// ============================================================
// Lists the available output styles (default / explanatory / learning, plus any
// registered custom ones) and, when given a style name, switches the session's
// active style by writing the shared holder (ctx.outputStyle) that the CLI reads
// when it rebuilds the turn's system prompt. Mirrors the /goal / /vim pattern of
// mutating a `{ value }` holder shared with the REPL/TUI loop.
// ============================================================
import chalk from "chalk";
import { getOutputStyle, listOutputStyles } from "../output-style.js";
import type { SlashCommand } from "./types.js";

export const outputStyleCommand: SlashCommand = {
  name: "output-style",
  description: "List or switch the active output style",
  run: (args, ctx) => {
    const styles = listOutputStyles();
    const active = ctx.outputStyle?.value ?? "default";
    const target = args.trim().toLowerCase();

    if (target) {
      if (!getOutputStyle(target)) {
        console.log(chalk.yellow(`  Unknown output style: ${target}`));
        console.log(chalk.gray(`  Available: ${styles.map((s) => s.name).join(", ")}`));
        return;
      }
      if (ctx.outputStyle) {
        ctx.outputStyle.value = target;
        console.log(chalk.green(`  ✓ Output style set to "${target}"`));
        console.log(chalk.gray("  Takes effect from the next turn."));
      } else {
        console.log(chalk.yellow("  Output style is not writable in this session."));
      }
      return;
    }

    console.log("");
    console.log(chalk.bold("  Output styles:"));
    for (const s of styles) {
      const marker = s.name === active ? chalk.green("●") : " ";
      console.log(`    ${marker} ${chalk.cyan(s.name.padEnd(14))} ${chalk.gray(s.description)}`);
    }
    console.log("");
    console.log(chalk.gray(`  Active: ${active}  —  switch with /output-style <name>`));
  },
};

export default outputStyleCommand;
