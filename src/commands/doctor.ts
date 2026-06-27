// /doctor — check environment, provider, workspace, and build status
import * as fs from "node:fs";
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Check environment, provider, workspace, and build status",
  run: (_args, ctx) => {
    const hasKey = Boolean(ctx.modelConfig.apiKey);
    const distCli = fs.existsSync("dist/cli.js");
    const packageJson = fs.existsSync("package.json");
    const workspaceExists = fs.existsSync(ctx.workspaceRoot);
    const envExists = fs.existsSync(".env");

    console.log("");
    console.log(chalk.bold("  Doctor:"));
    console.log(`    Node:        ${chalk.cyan(process.version)}`);
    console.log(`    Provider:    ${chalk.cyan(ctx.modelConfig.provider)}`);
    console.log(`    Model:       ${chalk.cyan(ctx.modelConfig.model)}`);
    console.log(`    API key:     ${hasKey ? chalk.green("set") : chalk.red("missing")}`);
    console.log(`    .env:        ${envExists ? chalk.green("present") : chalk.yellow("missing")}`);
    console.log(`    Workspace:   ${workspaceExists ? chalk.green(ctx.workspaceRoot) : chalk.red(ctx.workspaceRoot)}`);
    console.log(`    package.json:${packageJson ? chalk.green(" present") : chalk.red(" missing")}`);
    console.log(`    dist/cli.js: ${distCli ? chalk.green("built") : chalk.yellow("not built (run npm run build)")}`);
  },
};

export default doctorCommand;
