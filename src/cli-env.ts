// ============================================================
// CLI environment & info flags — .env loading, --version/--help,
// first-run onboarding. Imported FIRST by cli.ts: the dotenv calls
// below are a deliberate module-level side effect.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import dotenv from "dotenv";

import { COMMANDS } from "./commands.js";

/**
 * Installation directory of the CLI (the repo root), resolved from the module
 * location — src/cli.ts and dist/cli.js both sit one level below it. Unlike
 * process.cwd(), this is stable no matter which directory ccr is launched
 * from, so the user's API-key .env is found even when ccr is installed
 * globally and started inside an arbitrary project workspace.
 */
export function getInstallDir(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

// Load environment variables: a workspace-local .env takes precedence (per-
// project API config), then fall back to the installation directory's .env
// (global config). dotenv does not override already-set variables.
dotenv.config();
dotenv.config({ path: path.join(getInstallDir(), ".env") });

// --- CLI info flags (--version / --help) ---
// Handled before any config load so they work without an API key or network.
// The smoke test (scripts/smoke.mjs) exercises exactly this path:
//   build → `node dist/cli.js --version` → assert exit 0 + version string.

export function readPackageVersion(): string {
  try {
    // src/cli.ts and dist/cli.js both sit one level below the repo root,
    // so "../package.json" resolves correctly under tsx and the built CLI.
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Check if .env exists, and if not, guide the user to create it.
 * Returns true if we should continue (env exists or was just created),
 * false if the user wants to exit.
 */
export async function checkOrCreateEnv(): Promise<boolean> {
  const envPath = ".env";
  const envExamplePath = ".env.example";
  const installEnvPath = path.join(getInstallDir(), ".env");
  const installEnvExamplePath = path.join(getInstallDir(), ".env.example");

  // A workspace-local .env (per-project API config) or the installation
  // directory's .env (global config) — either is enough to start.
  if (fs.existsSync(envPath) || fs.existsSync(installEnvPath)) {
    return true;
  }

  // .env doesn't exist - show onboarding message
  console.log("");
  console.log(chalk.bold.cyan("╭────────────────────────────────────────╮"));
  console.log(
    chalk.bold.cyan("│") +
      chalk.bold.white("  Claude Code Replica — 首次设置") +
      " ".repeat(14) +
      chalk.bold.cyan("│"),
  );
  console.log(chalk.bold.cyan("╰────────────────────────────────────────╯"));
  console.log("");
  console.log(chalk.yellow("  ⚠️  未检测到 .env 配置文件"));
  console.log("");

  // Check if .env.example exists (workspace first, then installation dir)
  const examplePath = fs.existsSync(envExamplePath)
    ? envExamplePath
    : fs.existsSync(installEnvExamplePath)
      ? installEnvExamplePath
      : undefined;
  if (!examplePath) {
    console.log(chalk.red("  ✗ .env.example 模板文件不存在"));
    console.log(chalk.gray("  请手动创建 .env 文件，参考文档: docs/快速开始.md"));
    return false;
  }

  console.log(chalk.green("  ✓ 找到 .env.example 模板文件"));
  console.log("");

  // For interactive mode, offer to create the file
  if (process.stdin.isTTY) {
    console.log("  请选择操作:");
    console.log(chalk.cyan("    1.") + " 复制模板并编辑 (推荐)");
    console.log(chalk.cyan("    2.") + " 仅复制模板，稍后手动编辑");
    console.log(chalk.cyan("    3.") + " 退出");
    console.log("");

    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const promptUser = () =>
      new Promise<string>((resolve) => {
        rl.question(chalk.cyan("  请输入选项 [1]: "), (answer) => {
          resolve(answer.trim() || "1");
        });
      });

    const choice = await promptUser();
    rl.close();

    if (choice === "3" || choice.toLowerCase() === "q" || choice.toLowerCase() === "exit") {
      console.log(chalk.gray("\n  已退出。请手动创建 .env 文件后重新启动。\n"));
      return false;
    }

    if (choice === "2" || choice === "") {
      // Just copy the template
      fs.copyFileSync(examplePath, envPath);
      console.log(chalk.green("\n  ✓ 已复制 .env.example → .env"));
      console.log(chalk.gray("  请编辑 .env 文件填入您的 API Key 后重新启动。\n"));
      return false;
    }

    // Default: choice === "1" or any other input - copy and guide
    fs.copyFileSync(examplePath, envPath);
    console.log(chalk.green("\n  ✓ 已复制 .env.example → .env"));
    console.log("");
    console.log(chalk.bold("  📝 下一步操作:"));
    console.log(chalk.gray("  ──────────────────────────────────────"));
    console.log("  1. 编辑 .env 文件:");
    console.log(chalk.cyan(`     code .env`) + chalk.gray(" (或使用您喜欢的编辑器)"));
    console.log("");
    console.log("  2. 填写以下必填项:");
    console.log(chalk.cyan("     LLM_API_KEY=sk-your-api-key-here"));
    console.log(chalk.gray("     (支持: Anthropic / OpenAI / DeepSeek / Qwen 等)"));
    console.log("");
    console.log("  3. 可选配置:");
    console.log(chalk.cyan("     LLM_PROVIDER=anthropic  # 或 openai/deepseek/qwen"));
    console.log(chalk.cyan("     LLM_MODEL=             # 留空使用默认模型"));
    console.log("");
    console.log(chalk.gray("  ──────────────────────────────────────"));
    console.log(chalk.cyan("  重新启动 ccr 即可开始使用！\n"));
    return false;
  }

  // Non-interactive mode - just copy the template
  fs.copyFileSync(examplePath, envPath);
  console.log(chalk.green("  ✓ 已复制 .env.example → .env"));
  console.log(chalk.yellow("  请编辑 .env 文件填入 API Key 后重新启动。\n"));
  return false;
}

const HELP_TEXT = `Claude Code Replica (ccr) — a local AI coding assistant for OpenAI-compatible APIs.

Usage:
  ccr [options]              Start an interactive session (TUI on a TTY, line REPL otherwise)
  echo "prompt" | ccr        Pipe a single prompt (non-TTY)

Options:
  --version, -V              Print version and exit
  --help, -h                 Print this help and exit
  --print-command            List built-in slash commands and exit (smoke tests)
  --session=<id>             Resume a saved session by id
  --verbose                  Verbose startup + token accounting
  --quiet                    Suppress non-essential output (default)
  --show-tokens              Show per-turn token usage
  --no-tui                   Force the line-based REPL (skip the Ink TUI)
  --no-speculation           Disable speculative prefetch
  --llm-perm-classifier      Use the LLM permission-risk classifier
  --safe-mode                Read-only session (force plan mode)
  --permission-mode <mode>   Set the permission mode (default/acceptEdits/bypassPermissions/plan/auto/dontAsk)

Configuration:
  .env                       LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL
  .mcp.json                  MCP server definitions (optional)
  .claude/settings.json      Permission mode, hooks, telemetry

In-session: type /help for slash commands.`;

export function maybeHandleInfoFlags(argv: string[]): boolean {
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(readPackageVersion());
    return true;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP_TEXT);
    return true;
  }
  if (argv.includes("--print-command")) {
    // Non-interactive introspection for smoke tests and scripting: list the
    // built-in slash commands, then exit before any provider/TUI setup.
    for (const cmd of COMMANDS) {
      console.log(`/${cmd.name} — ${cmd.description}`);
    }
    return true;
  }
  return false;
}
