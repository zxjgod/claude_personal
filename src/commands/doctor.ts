// /doctor — check environment, provider, workspace, git, MCP, and disk
// ============================================================
// M18.9 enhancement: beyond the basic env/build checks, /doctor now probes
// git availability + worktree state, MCP server connectivity, and free disk
// space on the workspace volume. All probes are best-effort and never throw —
// a missing tool or non-repo simply renders as a warning line.
// ============================================================

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import chalk from "chalk";
import { resolveGitExecutable } from "../git-context.js";
import type { SlashCommand } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveGitExecutable(), args, {
      cwd,
      timeout: 3000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Check environment, provider, workspace, git, MCP, and disk",
  run: async (_args, ctx): Promise<undefined> => {
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
    console.log(
      `    Workspace:   ${workspaceExists ? chalk.green(ctx.workspaceRoot) : chalk.red(ctx.workspaceRoot)}`,
    );
    console.log(
      `    package.json:${packageJson ? chalk.green(" present") : chalk.red(" missing")}`,
    );
    console.log(
      `    dist/cli.js: ${distCli ? chalk.green("built") : chalk.yellow("not built (run npm run build)")}`,
    );

    // --- Git & worktree (18.9) ---
    const gitVersion = await git(["--version"], ctx.workspaceRoot);
    if (!gitVersion) {
      console.log(`    Git:         ${chalk.yellow("not found on PATH")}`);
    } else {
      const inside = await git(["rev-parse", "--is-inside-work-tree"], ctx.workspaceRoot);
      if (inside !== "true") {
        console.log(
          `    Git:         ${chalk.cyan(gitVersion.replace("git version ", ""))} ${chalk.gray("(workspace is not a repo)")}`,
        );
      } else {
        const branch =
          (await git(["rev-parse", "--abbrev-ref", "HEAD"], ctx.workspaceRoot)) || "(detached)";
        const dirty = (await git(["status", "--porcelain"], ctx.workspaceRoot)) || "";
        const dirtyCount = dirty.split("\n").filter(Boolean).length;
        const worktrees = (await git(["worktree", "list"], ctx.workspaceRoot)) || "";
        const wtCount = worktrees.split("\n").filter(Boolean).length;
        console.log(
          `    Git:         ${chalk.green(gitVersion.replace("git version ", ""))} on ${chalk.cyan(branch)}`,
        );
        console.log(
          `    Working tree:${dirtyCount === 0 ? chalk.green(" clean") : chalk.yellow(` ${dirtyCount} uncommitted`)}`,
        );
        console.log(`    Worktrees:   ${chalk.cyan(String(wtCount))}`);
      }
    }

    // --- MCP connectivity (18.9) ---
    if (ctx.mcpManager) {
      const count = ctx.mcpManager.serverCount;
      const mcpTools = ctx.mcpManager
        .getAllTools()
        .filter((t) => t.name.startsWith("mcp__")).length;
      console.log(
        `    MCP:         ${count === 0 ? chalk.gray("no servers") : chalk.green(`${count} server(s), ${mcpTools} tool(s)`)}`,
      );
    } else {
      console.log(`    MCP:         ${chalk.gray("manager not available")}`);
    }

    // --- Disk space on the workspace volume (18.9) ---
    try {
      const stat = (
        fs as typeof fs & { statfsSync?: (p: string) => { bavail: number; bsize: number } }
      ).statfsSync;
      if (stat) {
        const s = stat(ctx.workspaceRoot);
        const freeGb = (s.bavail * s.bsize) / 1024 ** 3;
        const color = freeGb < 1 ? chalk.red : freeGb < 5 ? chalk.yellow : chalk.green;
        console.log(`    Disk free:   ${color(`${freeGb.toFixed(1)} GB`)}`);
      }
    } catch {
      // statfsSync unavailable (older Node) — skip silently.
    }
  },
};

export default doctorCommand;
