// /skills — list registered skills
import chalk from "chalk";
import { listSkills } from "../skills.js";
import type { SlashCommand } from "./types.js";

export const skillsCommand: SlashCommand = {
  name: "skills",
  description: "List registered skills (loadable via the Skill tool)",
  run: (): undefined => {
    const skills = listSkills();
    if (skills.length === 0) {
      console.log(chalk.gray("  No skills registered yet."));
      return;
    }
    console.log("");
    console.log(chalk.bold(`  Skills (${skills.length}):`));
    for (const s of skills) {
      console.log(`    ${chalk.cyan(s.name.padEnd(20))} ${chalk.gray(s.description)}`);
    }
  },
};

export default skillsCommand;
