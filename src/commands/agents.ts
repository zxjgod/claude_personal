// /agents — list available sub-agent roles and their tool set
import chalk from "chalk";
import { getSubagentType, listSubagentNames } from "../subagents.js";
import type { SlashCommand } from "./types.js";

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "List available sub-agent roles and their tool set",
  run: (): undefined => {
    const names = listSubagentNames();
    if (names.length === 0) {
      console.log(chalk.gray("  No sub-agent roles registered."));
      return;
    }
    console.log("");
    console.log(chalk.bold("  Sub-agent roles:"));
    for (const name of names) {
      const type = getSubagentType(name);
      if (!type) continue;
      console.log("");
      console.log(`    ${chalk.cyan(name)} — ${type.description}`);
      console.log(chalk.gray(`      tools: ${type.toolNames.join(", ")}`));
      if (type.maxTurns) console.log(chalk.gray(`      max turns: ${type.maxTurns}`));
    }
  },
};

export default agentsCommand;
