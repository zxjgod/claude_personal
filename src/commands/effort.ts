// /effort — reasoning effort slider
import chalk from "chalk";
import {
  EFFORT_DEFINITIONS,
  EFFORT_LEVELS,
  type EffortLevel,
  getEffort,
  parseEffort,
  renderEffortSlider,
} from "../tui/effort.js";
import type { SlashCommand } from "./types.js";

function printEffortDefinition(level: EffortLevel): void {
  const def = EFFORT_DEFINITIONS[level];
  console.log(chalk.gray(`  Definition: ${def.definition}`));
  console.log(chalk.gray(`  Behavior:   ${def.behavior}`));
  console.log(chalk.gray(`  Mapping:    ${def.mapping}`));
}

function printEffortDefinitions(): void {
  console.log("");
  console.log(chalk.bold("  Effort levels:"));
  for (const level of EFFORT_LEVELS) {
    const def = EFFORT_DEFINITIONS[level];
    console.log(chalk.gray(`  - ${chalk.cyan(level)}: ${def.definition}`));
    console.log(chalk.gray(`    ${def.behavior}`));
    console.log(chalk.gray(`    ${def.mapping}`));
  }
}

export const effortCommand: SlashCommand = {
  name: "effort",
  description:
    "Reasoning effort slider (/effort opens the picker; /effort <level> sets it directly)",
  run: (args, ctx) => {
    const arg = args.trim().toLowerCase();
    const options = (ctx.modelConfig.options ??= {});

    // No arg → show the slider with the active tier highlighted.
    if (!arg) {
      const active = getEffort(options);
      console.log(renderEffortSlider(active));
      printEffortDefinitions();
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
    printEffortDefinition(next);
    if (next !== prev) {
      console.log(
        chalk.gray(`  Effort: ${prev} → ${chalk.cyan(next)} (applies to the next turn).`),
      );
    }
  },
};

export default effortCommand;
