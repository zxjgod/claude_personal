// /effort — reasoning effort slider
import chalk from "chalk";
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_LEVELS,
  getEffort,
  parseEffort,
  renderEffortSlider,
} from "../effort.js";
import type { SlashCommand } from "./types.js";

export const effortCommand: SlashCommand = {
  name: "effort",
  description:
    "Reasoning effort slider (/effort opens the picker; /effort <level> sets it directly)",
  run: (args, ctx) => {
    const arg = args.trim().toLowerCase();
    const options = (ctx.modelConfig.options ??= {});

    // No arg → show the slider with the active tier highlighted.
    if (!arg) {
      console.log(renderEffortSlider(getEffort(options)));
      console.log(chalk.gray(`  Set with /effort <level>. Levels: ${EFFORT_LEVELS.join(", ")}.`));
      return;
    }

    const next = parseEffort(arg);
    if (!next) {
      console.log(chalk.yellow(`  Unknown effort: ${arg}. Levels: ${EFFORT_LEVELS.join(", ")}.`));
      return;
    }

    const prev = getEffort(options);
    options.effort = next;
    console.log(renderEffortSlider(next));
    if (next !== prev) {
      console.log(
        chalk.gray(`  Effort: ${prev} → ${chalk.cyan(next)} (applies to the next turn).`),
      );
    }
    if (next === "ultracode") {
      console.log(chalk.gray(`  ${EFFORT_DESCRIPTIONS.ultracode}.`));
    }
  },
};

export default effortCommand;
