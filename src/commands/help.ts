// /help — list all commands
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

// COMMANDS is injected at registry build time to avoid a static import cycle
// (registry.ts imports this file, so this file cannot import registry.ts).
let COMMANDS_REF: SlashCommand[] = [];
export function bindCommandList(list: () => SlashCommand[]): void {
  COMMANDS_REF = list() as SlashCommand[];
}

export const helpCommand: SlashCommand = {
  name: "help",
  description: "Show available commands",
  run: () => {
    console.log("");
    console.log(chalk.bold("  Commands:"));
    for (const cmd of COMMANDS_REF) {
      console.log(`    ${chalk.cyan("/" + cmd.name).padEnd(20)} ${chalk.gray(cmd.description)}`);
    }
    console.log(
      `    ${chalk.cyan("@<path>").padEnd(20)} ${chalk.gray("Inject a file's contents into your message")}`,
    );
    console.log(`    ${chalk.cyan("exit").padEnd(20)} ${chalk.gray("Quit")}`);
  },
};

export default helpCommand;
