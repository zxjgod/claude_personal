// /init — generate a starter CLAUDE.md by scanning the workspace
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

/**
 * Scan a workspace and produce a starter CLAUDE.md. Best-effort: detects a
 * package.json (name, scripts), common config files, and the top-level
 * directory layout. The user is expected to refine it.
 */
export function buildClaudeMdScaffold(workspaceRoot: string): string {
  const name = path.basename(path.resolve(workspaceRoot));
  const lines: string[] = [`# ${name}`, ""];

  // package.json — project name, description, scripts.
  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf-8"));
  } catch {
    /* no package.json */
  }
  if (pkg) {
    lines.push("## Project Overview", "");
    if (pkg.description) lines.push(pkg.description, "");
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      lines.push("## Commands", "");
      for (const [k, v] of Object.entries(pkg.scripts)) {
        lines.push(`- \`npm run ${k}\` — ${String(v)}`);
      }
      lines.push("");
    }
  } else {
    lines.push("## Project Overview", "", "<!-- Describe what this project does. -->", "");
  }

  // Detected tooling / config files.
  const configs = [
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "Makefile",
    ".eslintrc",
    ".prettierrc",
  ];
  const found = configs.filter((f) => fs.existsSync(path.join(workspaceRoot, f)));
  if (found.length > 0) {
    lines.push("## Tooling", "", ...found.map((f) => `- ${f}`), "");
  }

  // Top-level layout (dirs only, skip noise).
  try {
    const skip = new Set(["node_modules", ".git", "dist", "build", ".cache"]);
    const dirs = fs
      .readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !skip.has(d.name) && !d.name.startsWith("."))
      .map((d) => d.name)
      .slice(0, 20);
    if (dirs.length > 0) {
      lines.push("## Structure", "", ...dirs.map((d) => `- \`${d}/\``), "");
    }
  } catch {
    /* ignore */
  }

  lines.push(
    "## Conventions",
    "",
    "<!-- Capture coding conventions, patterns, and constraints the assistant should follow. -->",
    "",
  );

  return lines.join("\n");
}

export const initCommand: SlashCommand = {
  name: "init",
  description: "Generate a starter CLAUDE.md by scanning the workspace",
  run: (args, ctx) => {
    const claudeMdPath = path.join(ctx.workspaceRoot, "CLAUDE.md");
    const force = args.trim().toLowerCase() === "force";
    if (fs.existsSync(claudeMdPath) && !force) {
      console.log(chalk.yellow("  CLAUDE.md already exists. Use /init force to overwrite."));
      return;
    }
    const scaffold = buildClaudeMdScaffold(ctx.workspaceRoot);
    try {
      fs.writeFileSync(claudeMdPath, scaffold, "utf-8");
      console.log(chalk.gray(`  Wrote starter CLAUDE.md (${scaffold.length} bytes).`));
      console.log(chalk.gray("  Edit it to capture project context, then restart to load it."));
    } catch (e: any) {
      console.log(chalk.red(`  Could not write CLAUDE.md: ${e.message}`));
    }
  },
};

export default initCommand;
