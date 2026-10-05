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
  if (process.env.LLM_API_KEY) return true;
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

  console.log(
    chalk.yellow(
      "  Non-interactive setup will not create .env. Set LLM_API_KEY or configure it interactively.\n",
    ),
  );
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
  -p, --print [prompt]       Run one headless prompt and exit
  --output-format <format>   text, json, or stream-json
  --input-format <format>    text or stream-json
  --include-hook-events      Put hook lifecycle frames on the stream-json output
                             (hook_started / hook_progress / hook_response).
                             SessionStart and Setup are always reported; every
                             other event needs this flag. Only settings.json
                             hooks report — in-process callbacks have no
                             separate process to observe
  --prompt-suggestions [v]   After each turn, predict the next user prompt and
                             emit a prompt_suggestion frame (stream-json only).
                             Costs one extra small model call per turn, charged
                             to --max-budget-usd; a failed prediction is omitted.
                             Deviation: official calls a dedicated suggestion
                             endpoint, this one reuses the session model
  --brief                    Register the SendUserMessage tool and add the
                             BRIEF CHANNEL prompt section, so replies the user
                             is meant to read go through a dedicated
                             checkpoint instead of narration around a tool
                             call. attachments take workspace file paths only;
                             official's {file_uuid,...} form needs a device
                             upload channel this CLI does not have and is
                             rejected. Not implemented: official's chat/
                             transcript view toggle (briefView.defaultView)
                             and proactive delivery to background agents
  --file <specs...>          Download file resources at startup.
                             file_id:relative_path, repeatable:
                             --file file_abc:doc.txt file_def:img.png
                             Saved under <cwd>/<sessionId>/uploads/.
                             Failures are reported per file and never abort
                             the session. Deviation: official authenticates
                             with the Claude.ai OAuth token against its own
                             gateway; this CLI uses the session's configured
                             provider key/base URL, so a gateway without the
                             Files API yields a per-file error
  --betas <betas...>         Beta headers to include in API requests
                             (API key users only). Only
                             context-1m-2025-08-07 is accepted; anything
                             else is warned about and dropped, not sent.
                             Values are header strings, not short names
  --from-pr [value]           Resume the session linked to a PR, by PR number
                              or PR URL. Requires the gh CLI (a missing gh is
                              a hard error, not a silent skip). The linked PR
                              is stored on the session, so the first
                              --from-pr 42 links a fresh session to PR #42 and
                              later ones resume it. Cannot be combined with
                              --resume/--continue. Not implemented: official's
                              interactive PR picker (a bare --from-pr) and the
                              automatic branch->PR linkage official gets from
                              its GitHub integration. Deviation: official falls
                              through to a plain fresh session, in silence, when
                              no session is linked; this CLI reports it
  --resume <id>              Resume a session (alias for --session)
  --continue                 Continue the most recent session
  --fork-session             Fork the resumed session
  --session-id <id>          Use an explicit session id
  -n, --name <name>          Display name for this session (shown in /resume, /sessions)
  --add-dir <path>           Add an additional workspace directory
  --model <model>            Model for this session (overrides LLM_MODEL)
  --effort <level>           low, medium, high (default), xhigh, max, ultracode
  --fallback-model <list>    Comma-separated fallback models tried in order
  --tools <list>             Restrict the session to these built-in tools
                             (comma or space separated; "" = none, "default" = all)
  --allowedTools, --allowed-tools <list>
                             Extra permission allow rules, comma separated
                             (e.g. --allowedTools "Bash(git *),Edit")
  --disallowedTools, --disallowed-tools <list>
                             Extra permission deny rules, comma separated
  --append-system-prompt <text> Append text to the system prompt
  --system-prompt <text>     Replace the default system prompt
  --max-turns <n>            Turn bound (positive integer, or "unlimited")
  --disable-slash-commands   Disable all skills (disk + plugin); built-in
                             slash commands and MCP prompts stay available
  -w, --worktree [name]      Run the session in a new git worktree; the name
                             is generated when omitted. Not combinable with
                             --resume / --continue. The worktree is NOT
                             removed when the session ends
  --tmux                      Rejected: tmux pane creation is not implemented
                             in this build, so --tmux always exits 1. On
                             Windows the message matches official verbatim
                             ("--tmux is not supported on Windows").
                             (Official's own help advertises
                             --tmux=classic, but its CLI rejects that
                             spelling as an unknown option.)
  --ax-screen-reader         Screen-reader friendly output: flat text, no
                             borders, no colors, no frame throttling, and
                             no alternate-screen (--fullscreen is dropped).
                             TUI only — --print output is unchanged.
                             Overridden by CLAUDE_AX_SCREEN_READER and by
                             screenReader.axScreenReader in settings.json
                             (the flag wins over both)
  --bg, --background          Recognised, refused. Background sessions need a
                             background service daemon; this CLI does not run
                             one. claude agents and the logs/attach/stop/kill/
                             respawn/rm subcommands are refused the same way.
                             --print is a hard conflict with --bg
  --cloud, --remote           Recognised, refused. No cloud backend. Internal
                             worker entry points (--bg-spare, --preload,
                             --daemon-worker, --bg-pty-host, the chrome MCP
                             spawns) and the Remote-Control bridge aliases
                             (remote-control, rc, remote, sync, bridge) are
                             refused too, never fed to the model as a prompt
  <subcommand>                Official's top-level subcommands agents, auth,
                             auto-mode, doctor, gateway, install, mcp,
                             plugin|plugins, project, setup-token, ultrareview,
                             update|upgrade are recognised and refused (no
                             background/account/updater/gateway/cloud/
                             management backend), never fed to the model.
                             Matched on the first token only
  --agent <name>             Use this agent's persona for the current session
  --agents <json>            Agent definitions for this session only, as a
                             JSON object of name -> {description, prompt, ...}
  -d, --debug [filter]       Debug logging (info,text,tools,commit or "all")
  --debug-file <path>        Write the debug log to a file (implies --debug)
  --verbose                  Verbose startup + token accounting
  --quiet                    Suppress non-essential output (default)
  --show-tokens              Show per-turn token usage
  --no-tui                   Force the line-based REPL (skip the Ink TUI)
  --no-speculation           Disable speculative prefetch
  --llm-perm-classifier      Use the LLM permission-risk classifier
  --safe-mode                Disable project customizations for troubleshooting
  --read-only                Read-only session (force plan mode)
  --bare                     Skip instructions, extensions and MCP auto-loading
  --settings <file|json>      Additional settings, below managed policy
  --setting-sources <list>    user,project,local (managed policy always applies)
  --json-schema <json>       Validate the final headless JSON answer
  --max-budget-usd <usd>     Stop requests when estimated budget is exhausted
  --no-session-persistence   Do not save headless conversations
  --mcp-config <file|json>    Explicit MCP configuration (repeatable)
  --strict-mcp-config        Load only explicit MCP configurations
  --plugin-dir <path>        Load a local plugin for this session
  --permission-mode <mode>   Set the permission mode (default/acceptEdits/bypassPermissions/plan/auto/dontAsk)
  --dangerously-skip-permissions
                             Pre-allow all ORDINARY tool prompts (allow "*").
                             Honest semantics note: unlike the official flag's
                             name suggests, it does NOT skip the safety floor —
                             dangerous-pattern confirmations and blocked paths
                             still apply. Deliberately safer than the name.

Configuration:
  .env                       LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL
  .claude/mcp.json           MCP server definitions (optional; project-level
                             configs ask for a one-time trust confirmation)
  .claude/settings.json      Workspace permission mode, hooks, telemetry

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
