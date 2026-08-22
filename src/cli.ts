#!/usr/bin/env node

// ============================================================
// Claude Code Replica — CLI Entry Point
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import chalk from "chalk";
import dotenv from "dotenv";

import { agentLoop } from "./agent-loop.js";
import { loadAgentsDir } from "./agents/loadAgentsDir.js";
import {
  DEFAULT_CLASSIFIER_RULES,
  mergeClassifierRules,
  parseClassifierRules,
} from "./classifier-rules.js";
import { formatCliError } from "./cli-errors.js";
import { createCliInputReader } from "./cli-input.js";
import { COMMANDS, handleSlashCommand, loadCommandsDir } from "./commands.js";
import { formatGitContext, gatherGitContext } from "./git-context.js";
import { HookRegistry } from "./hooks.js";
import { loadHooksFromSettingsTrusted, readSettings } from "./hooks-config.js";
import { createModelCaller, resolveProviderConfig } from "./llm-adapter.js";
import { discoverMCPConfigs, MCPManager } from "./mcp/index.js";
import { MemoryStore } from "./memory-extract.js";
import { PersistenceManager } from "./persistence.js";
import { renderPrefetchAttachment, startPrefetch } from "./prefetch.js";
import { normalizeFinishReason } from "./session-memory.js";
import { loadSkillsDir } from "./skills/loadSkillsDir.js";
import { listSkills } from "./skills.js";
import { formatSpeculationLine } from "./speculation.js";
import { setCoreToolsForSubagents } from "./subagents.js";
import { buildSystemPrompt, renderSystemPrompt } from "./system-prompt.js";
import { Telemetry } from "./telemetry.js";
import { CORE_TOOLS } from "./tools/index.js";
import { createMcpResourceTools, createToolSearchTool } from "./tools/m8/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { expandFileRefs } from "./tools/utils/file-refs.js";
import {
  createRawInputReader,
  promptPermissionMenu,
  promptSelectMenu,
} from "./tui/cli-interactive.js";
import {
  renderPermissionPrompt,
  renderSubAgentActivity,
  renderToolResult,
  renderToolStart,
  renderWelcome,
  StreamingRenderer,
} from "./tui/cli-renderer.js";
import { Spinner } from "./tui/cli-spinner.js";
import { detectLanguage } from "./tui/i18n.js";
import { SessionStats } from "./tui/session-stats.js";
import { SessionTranscript } from "./tui/session-transcript.js";
import type {
  AskUserFn,
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
  UserQuestion,
} from "./types.js";

// Load environment variables
dotenv.config();

// --- CLI info flags (--version / --help) ---
// Handled before any config load so they work without an API key or network.
// The smoke test (scripts/smoke.mjs) exercises exactly this path:
//   build → `node dist/cli.js --version` → assert exit 0 + version string.

function readPackageVersion(): string {
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
async function checkOrCreateEnv(): Promise<boolean> {
  const envPath = ".env";
  const envExamplePath = ".env.example";

  // .env already exists, nothing to do
  if (fs.existsSync(envPath)) {
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

  // Check if .env.example exists
  if (!fs.existsSync(envExamplePath)) {
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
      fs.copyFileSync(envExamplePath, envPath);
      console.log(chalk.green("\n  ✓ 已复制 .env.example → .env"));
      console.log(chalk.gray("  请编辑 .env 文件填入您的 API Key 后重新启动。\n"));
      return false;
    }

    // Default: choice === "1" or any other input - copy and guide
    fs.copyFileSync(envExamplePath, envPath);
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
  fs.copyFileSync(envExamplePath, envPath);
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

function maybeHandleInfoFlags(argv: string[]): boolean {
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(readPackageVersion());
    return true;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP_TEXT);
    return true;
  }
  return false;
}

// --- Configuration ---

function loadConfig(): ModelConfig {
  const provider = (process.env.LLM_PROVIDER || "openai") as ModelConfig["provider"];
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    console.error(
      "Error: LLM_API_KEY is not set. Create a .env file or set the environment variable.",
    );
    // No resources to clean up yet (persistence/mcp not constructed), but flush
    // stdout/stderr before exiting so the message is not truncated on Windows.
    process.exitCode = 1;
    return {} as ModelConfig;
  }

  const config = resolveProviderConfig({
    provider,
    apiKey,
    model: process.env.LLM_MODEL || undefined,
    baseURL: process.env.LLM_BASE_URL || undefined,
    maxTokens: process.env.LLM_MAX_TOKENS ? parseInt(process.env.LLM_MAX_TOKENS, 10) : undefined,
    temperature: process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined,
    // Cloud gateway routing (11.3): LLM_GATEWAY=bedrock|vertex, plus region
    // and (Vertex) project. Resolved into an OpenAI-compatible base URL.
    options: process.env.LLM_GATEWAY
      ? {
          gateway: process.env.LLM_GATEWAY,
          gatewayRegion: process.env.LLM_GATEWAY_REGION || undefined,
          gatewayProject: process.env.LLM_GATEWAY_PROJECT || undefined,
        }
      : undefined,
  });

  // Fallback model chain (same provider): LLM_FALLBACK_MODELS="a,b,c".
  const fallbackModels = (process.env.LLM_FALLBACK_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fallbackModels.length > 0) {
    config.fallbackModels = fallbackModels;
  }
  return config;
}

// --- Workspace ---

function getWorkspaceRoot(): string {
  return process.env.WORKSPACE_ROOT || process.cwd();
}

const VALID_PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "auto",
  "dontAsk",
];

function getPermissionMode(workspaceRoot: string): PermissionMode {
  // Precedence (highest → lowest): CLI flag → --safe-mode → env → project
  // settings (settings.local.json > settings.json) → user settings (~/.claude).
  const flagIdx = process.argv.indexOf("--permission-mode");
  if (flagIdx !== -1) {
    const m = process.argv[flagIdx + 1] as PermissionMode | undefined;
    if (m && VALID_PERMISSION_MODES.includes(m)) return m;
  }
  // --safe-mode: force a read-only (plan) session regardless of env/config.
  if (process.argv.includes("--safe-mode")) {
    return "plan";
  }
  const envMode = process.env.PERMISSION_MODE as PermissionMode | undefined;
  if (envMode && VALID_PERMISSION_MODES.includes(envMode)) {
    return envMode;
  }
  // Project settings live inside the checked-out repository, so treat them as
  // UNTRUSTED: a cloned repo must not be able to silently opt the session into
  // a no-confirmation mode. Privileged modes are only honored from sources the
  // user controls directly — the CLI flag, PERMISSION_MODE, or user settings.
  const PROJECT_FORBIDDEN_MODES: PermissionMode[] = ["bypassPermissions", "auto"];
  const project = readSettings(workspaceRoot);
  const projectMode = project?.permissionMode as PermissionMode | undefined;
  if (projectMode && VALID_PERMISSION_MODES.includes(projectMode)) {
    if (PROJECT_FORBIDDEN_MODES.includes(projectMode)) {
      console.error(
        `Warning: project .claude/settings.json requests permissionMode ` +
          `"${projectMode}", which is not honored from project settings. ` +
          `Use --permission-mode, PERMISSION_MODE, or user settings instead.`,
      );
    } else {
      return projectMode;
    }
  }
  const user = readSettings(os.homedir());
  const userMode = user?.permissionMode as PermissionMode | undefined;
  if (userMode && VALID_PERMISSION_MODES.includes(userMode)) {
    return userMode;
  }
  return "default";
}

// --- One-shot yes/no prompt ---

/**
 * Plain-cooked-mode y/N question used for pre-REPL trust prompts (project
 * hooks). Dedicated short-lived readline so it never tangles with the raw-mode
 * input reader created later; defaults to NO on empty/garbage input.
 */
function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// --- Max turns (loop bound) ---
/**
 * Parse a maxTurns value: a positive integer is used as-is; "unlimited" /
 * "infinity" / "0" disable the cap entirely. Returns undefined for anything
 * invalid so callers fall back to the default.
 */
function parseMaxTurns(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "unlimited" || trimmed === "infinity" || trimmed === "0") {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the main agent loop's maxTurns bound. Precedence: CLI `--max-turns <n>`
 * → env `CCR_MAX_TURNS` → unlimited by default. A finite value is an explicit
 * operator safety ceiling, never an implicit reason to cut off a main task.
 */
function resolveMaxTurns(): number {
  const flagIdx = process.argv.indexOf("--max-turns");
  if (flagIdx !== -1) {
    const parsed = parseMaxTurns(process.argv[flagIdx + 1]);
    if (parsed !== undefined) return parsed;
  }
  const envParsed = parseMaxTurns(process.env.CCR_MAX_TURNS);
  if (envParsed !== undefined) return envParsed;
  return Number.POSITIVE_INFINITY;
}

// --- Load CLAUDE.md ---

function loadClaudeMd(workspaceRoot: string): string | undefined {
  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");
  try {
    return fs.readFileSync(claudeMdPath, "utf-8");
  } catch {
    return undefined;
  }
}

// --- Main ---

async function main() {
  // Info flags first — print + return before touching config / API key / stdin.
  if (maybeHandleInfoFlags(process.argv)) return;

  // P0-1: First-run onboarding - guide user to create .env if missing
  if (!(await checkOrCreateEnv())) {
    return;
  }

  const verbose = process.argv.includes("--verbose") || process.env.CCR_VERBOSE === "1";
  const quiet = process.argv.includes("--quiet") || process.env.CCR_QUIET === "1" || !verbose;
  const uiState = {
    showTokens:
      process.argv.includes("--show-tokens") || process.env.SHOW_TOKENS === "1" || verbose,
    verbose,
  };

  if (verbose) {
    console.log("╔══════════════════════════════════════╗");
    console.log("║   Claude Code Replica — v1.0.0      ║");
    console.log("║   Local AI Coding Assistant         ║");
    console.log("╚══════════════════════════════════════╝");
    console.log("");
  }

  // Load configuration
  const modelConfig = loadConfig();
  // loadConfig sets process.exitCode = 1 and returns {} when LLM_API_KEY is
  // missing. Bail out cleanly here instead of limping on with an empty config
  // (which would otherwise fail deep inside the agent loop). Also makes the
  // no-key path deterministic for the smoke test.
  if (!modelConfig.provider) return;
  let workspaceRoot = getWorkspaceRoot();
  let permissionMode = getPermissionMode(workspaceRoot);
  const permissionModeState = {
    get: () => permissionMode,
    set: (mode: PermissionMode) => {
      permissionMode = mode;
    },
  };
  let claudeMdContent = loadClaudeMd(workspaceRoot);

  if (verbose) {
    console.log(`Provider: ${modelConfig.provider}`);
    console.log(`Model:    ${modelConfig.model}`);
    console.log(`Workspace: ${workspaceRoot}`);
    console.log(`Permission mode: ${permissionMode}`);
    console.log("");
  }

  // --- Persistence ---

  const messages: Message[] = [];
  const persistence = new PersistenceManager(workspaceRoot);
  // M19.2: append-only event log (tool_use/tool_result/usage/…) alongside the
  // session snapshot. Best-effort: every record call is wrapped so a write
  // failure warns but never blocks the turn.
  const transcript = new SessionTranscript(workspaceRoot);
  const recordTranscript = (entry: Parameters<SessionTranscript["append"]>[1]) => {
    transcript.append(sessionId!, entry).catch((err) => {
      console.error("Warning: transcript append failed:", formatCliError(err));
    });
  };
  const sessionStats = new SessionStats();

  // Local telemetry (11.4) — disabled unless explicitly opted in. Local-only,
  // never sent over the network; records event names + counts, not content.
  const telemetry = Telemetry.fromWorkspace(workspaceRoot);
  if (telemetry.enabled && verbose) {
    console.log("Telemetry: enabled (local JSONL, no network egress)");
  }

  // Parse --session from CLI args
  const sessionArg = process.argv.find((a) => a.startsWith("--session="));
  let sessionId = sessionArg?.split("=")[1];

  // If no session specified, list available ones in verbose mode only.
  // Use /sessions during normal use.
  if (!sessionId && verbose) {
    const sessions = await persistence.searchSessions("");
    const incomplete = sessions.filter((s) => s.taskState !== "stopped_by_user");
    if (incomplete.length > 0) {
      console.log("Recent incomplete sessions:");
      for (const s of incomplete.slice(0, 5)) {
        const pin = s.pinned ? "📌 " : "";
        const preview = s.preview ? ` — ${s.preview}` : "";
        console.log(
          `  ${pin}${s.sessionId.slice(0, 8)}... — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()}${preview}`,
        );
      }
      console.log("  Use --session=<id> to resume, or continue for a new session.");
      console.log("");
    }
  }

  // Generate or resume session
  if (sessionId) {
    const existing = await persistence.load(sessionId);
    if (existing) {
      messages.push(...existing.messages);
      if (verbose) {
        console.log(
          `Resumed session ${sessionId.slice(0, 8)}... (${existing.messageCount} messages)`,
        );
      }
    } else {
      console.log(`Session ${sessionId.slice(0, 8)}... not found. Starting new session.`);
      sessionId = persistence.generateId();
    }
  } else {
    sessionId = persistence.generateId();
  }
  if (verbose) {
    console.log(`Session: ${sessionId.slice(0, 8)}...`);
    console.log("");
  }

  // --- Tool Setup ---

  const toolRegistry = new ToolRegistry();
  for (const tool of CORE_TOOLS) {
    toolRegistry.register(tool, "core");
  }
  // 16.9: inject the core tool set into the subagents registry so sub-agent
  // loops (Task/Team) resolve tool names without dynamically importing
  // tools.ts (which would re-enter the tools.ts → TaskTool → tools.ts cycle).
  setCoreToolsForSubagents(CORE_TOOLS);

  // M37: discover disk skills (<root>/.claude/skills/<name>/SKILL.md and the
  // user-level equivalent). Cheap — only frontmatter is read here; each skill's
  // body stays lazy until the Skill tool or /<name> sugar invokes it.
  try {
    const loaded = loadSkillsDir(workspaceRoot);
    if (loaded.length > 0) {
      console.log(chalk.gray(`Loaded ${loaded.length} disk skill(s): ${loaded.join(", ")}`));
    }
  } catch {
    // Disk skills are optional; a malformed skills dir never blocks startup.
  }

  // Custom slash commands (<root>/.claude/commands/<name>.md and the user-level
  // equivalent). Each file's body is a prompt template injected via /<name>.
  try {
    const loadedCommands = loadCommandsDir(workspaceRoot);
    if (loadedCommands.length > 0) {
      console.log(
        chalk.gray(
          `Loaded ${loadedCommands.length} custom command(s): ${loadedCommands.join(", ")}`,
        ),
      );
    }
  } catch {
    // Custom commands are optional; a malformed commands dir never blocks startup.
  }

  // Custom sub-agents (<root>/.claude/agents/<name>.md and the user-level
  // equivalent). Registered into the sub-agent type registry so the Task tool's
  // `subagent_name` enum and /agents pick them up.
  try {
    const loadedAgents = loadAgentsDir(workspaceRoot);
    if (loadedAgents.length > 0) {
      console.log(
        chalk.gray(`Loaded ${loadedAgents.length} custom agent(s): ${loadedAgents.join(", ")}`),
      );
    }
  } catch {
    // Custom agents are optional; a malformed agents dir never blocks startup.
  }

  // MCP Setup
  const mcpManager = new MCPManager();
  const mcpConfigs = discoverMCPConfigs(workspaceRoot);
  for (const configPath of mcpConfigs) {
    const isProjectConfig = path.resolve(configPath) === path.resolve(workspaceRoot, ".mcp.json");
    await mcpManager.loadConfig(configPath, {
      requireTrust: isProjectConfig,
      confirm:
        isProjectConfig && process.stdin.isTTY && process.stdout.isTTY
          ? async (descriptions) => {
              console.log(
                chalk.yellow(
                  "\nThis project defines MCP servers that can execute external actions:",
                ),
              );
              for (const description of descriptions) console.log(chalk.gray(`   ${description}`));
              return askYesNo("Trust and enable these project MCP servers? [y/N] ");
            }
          : undefined,
    });
  }
  for (const mcpTool of mcpManager.getAllTools()) {
    toolRegistry.register(mcpTool, "mcp");
  }

  // MCP resource tools (8.6) — list/read resources from connected servers.
  for (const resTool of createMcpResourceTools(mcpManager)) {
    toolRegistry.register(resTool, "core");
  }

  // ToolSearch (8.5) registered last so it can see the full tool set.
  const toolSearchTool = createToolSearchTool(() => toolRegistry.getEnabledTools());
  toolRegistry.register(toolSearchTool, "core");

  // /tools listing derives from the registry — single source of truth.
  const toolSources = toolRegistry.listSources();

  if (verbose) {
    console.log(`Tools loaded: ${toolRegistry.enabledCount}`);
    if (mcpManager.serverCount > 0) {
      console.log(`MCP servers:  ${mcpManager.serverCount}`);
    }
    console.log("");
  }

  // --- System Prompt ---

  telemetry.record("session_start", {
    provider: modelConfig.provider,
    model: modelConfig.model,
    tools: toolRegistry.enabledCount,
    mcpServers: mcpManager.serverCount,
    permissionMode,
  });

  // Mutable session holders read by both the system-prompt builder and the
  // corresponding slash commands (/goal, /output-style). Stored as `{ value }`
  // references so a command and the REPL share the same cell.
  const goalHolder = { value: "" };
  const editorModeHolder = { value: "default" } as { value: "default" | "vim" };
  const outputStyleHolder = { value: "default" };

  // 12.4: a compact git snapshot (branch / dirty files / recent commits) is
  // gathered once at startup and injected into the dynamic suffix. Read-only,
  // best-effort — null in non-git dirs. Mutable so /cd re-gathers it.
  let gitSnapshot = await (async () => {
    const ctx = await gatherGitContext(workspaceRoot);
    return ctx ? formatGitContext(ctx) : undefined;
  })();

  // /cd support: move the session to a new directory mid-conversation. Updates
  // the workspace root + CLAUDE.md + git snapshot; the system-prompt env section
  // recomputes each turn, so it picks up the new root on the next turn.
  const setWorkspaceRoot = (next: string): boolean => {
    try {
      if (!fs.statSync(next).isDirectory()) return false;
    } catch {
      return false;
    }
    workspaceRoot = next;
    claudeMdContent = loadClaudeMd(next);
    // Re-gather git context in the background (best-effort; may lag a turn).
    gatherGitContext(next)
      .then((ctx) => {
        gitSnapshot = ctx ? formatGitContext(ctx) : undefined;
      })
      .catch(() => {
        gitSnapshot = undefined;
      });
    return true;
  };

  // Build the full turn system prompt from the live goal + output-style
  // holders. buildSystemPrompt memoizes its static sections (the output-style
  // block is keyed by style name), so rebuilding each turn is cheap — only the
  // dynamic suffix (and the output-style block when the style changes) recompute.
  const buildTurnSystemPrompt = (): string => {
    const base = renderSystemPrompt(
      buildSystemPrompt({
        workspaceRoot,
        tools: toolRegistry.getEnabledTools(),
        claudeMdContent,
        model: modelConfig.model,
        outputStyle: outputStyleHolder.value,
        gitStatus: gitSnapshot,
        // MCP servers connect/disconnect at runtime, so this is recomputed each
        // turn (see DANGEROUS_uncachedSystemPromptSection in system-prompt.ts).
        mcpInstructions: mcpManager.describeServersForPrompt(),
        // Only surface an explicit preference when a non-default language is
        // detected; otherwise the output-style's "respond in the user's
        // language" rule already governs.
        languagePreference: detectLanguage() === "zh-CN" ? "Chinese" : undefined,
      }),
    );
    return goalHolder.value
      ? `${base}\n\n[SESSION GOAL]\nThe user set this objective for the session. Keep it in view and steer toward it:\n${goalHolder.value}`
      : base;
  };

  const systemPrompt = buildTurnSystemPrompt();

  // --- Model Caller ---

  // Dispatch by provider at *call* time, not once at startup. createModelCaller
  // binds Anthropic vs OpenAI-compatible by `provider`; resolving it per call
  // means /provider (and any in-session config mutation) can switch provider
  // families — including to/from Anthropic — without rebuilding the closure.
  // The branch is a cheap function-ref lookup, so per-turn cost is negligible.
  const callModel: ModelCaller = (messages, tools, systemPrompt, cfg, abortSignal) =>
    createModelCaller(cfg)(messages, tools, systemPrompt, cfg, abortSignal);

  // M36: memory + skill prefetch (kernel §9). Kicks off concurrently with the
  // model stream so the NEXT turn can inject relevant memories/skills as a
  // <system-reminder> without paying latency. Pure keyword-overlap ranking — no
  // model call, no I/O beyond the already-loaded lists.
  const memoryStore = new MemoryStore(workspaceRoot);
  const prefetchMemories = (latestUserText: string): Promise<string | null> =>
    startPrefetch({
      query: latestUserText,
      memories: () => memoryStore.list(),
      skills: () => listSkills(),
    }).then(renderPrefetchAttachment);

  // M36: fast-model digest of a finished tool batch (kernel §9). OFF by default
  // — it fires a concurrent model call per large batch, and there's no separate
  // fast-model config yet, so enable explicitly with CCR_TOOL_SUMMARY=1.
  const summarizeToolBatch =
    process.env.CCR_TOOL_SUMMARY === "1"
      ? async (prompt: string): Promise<string | null> => {
          try {
            let text = "";
            for await (const event of callModel(
              [{ role: "user", content: [{ type: "text", text: prompt }] }],
              [],
              "",
              modelConfig,
            )) {
              if (event.type === "text_delta") text += event.delta;
            }
            return text.trim() || null;
          } catch {
            return null;
          }
        }
      : undefined;

  // M15.3: LLM-assisted permission classifier. OFF by default — enable with
  // --llm-perm-classifier or CCR_PERM_CLASSIFIER=1. When enabled, tool calls
  // the regex dangerous-pattern detector already flags get a model-assessed
  // risk hint (or outright block) before the approval prompt. It never relaxes
  // the prompt for ordinary tools, and degrades fail-safe (still prompts with
  // the regex reason) on any API/timeout/unavailable error.
  const llmPermClassifierEnabled =
    process.argv.includes("--llm-perm-classifier") || process.env.CCR_PERM_CLASSIFIER === "1";
  // Auto mode needs the LLM classifier as its background safety check, so
  // starting in auto mode implies the classifier is on. (Switching to auto at
  // runtime without the flag still works — but conservatively denies anything
  // the classifier can't clear, since no classifier is available.)
  // Rule layer for the classifier: sensible defaults + user overrides from
  // CCR_CLASSIFIER_RULES (JSON: {"allow":[...],"soft_deny":[...],"environment":[...]}).
  const classifierRules = mergeClassifierRules(
    DEFAULT_CLASSIFIER_RULES,
    parseClassifierRules(process.env.CCR_CLASSIFIER_RULES) ?? {},
  );
  const permissionClassifier: PermissionClassifier | undefined =
    llmPermClassifierEnabled || permissionMode === "auto"
      ? {
          callModel,
          modelConfig,
          // Bound classifier latency so a slow/hung provider can't stall the
          // approval flow; on timeout we defer to the regex reason.
          timeoutMs: 4000,
          rules: classifierRules,
        }
      : undefined;

  // --- Conversation ---

  const tools = toolRegistry.getEnabledTools();

  // --- Hooks ---
  // Empty by default. Register PreToolUse/PostToolUse hooks here (or load
  // them from project config) to intercept, block, or rewrite tool calls.
  // Config-driven hooks are loaded from .claude/settings.json (+ settings.local.json).
  //
  // SECURITY: project hooks execute arbitrary shell commands with our full
  // environment, so an untrusted repo must never auto-enable them. The gated
  // loader only registers hooks whose config fingerprint was previously
  // trusted, or that the user confirms right now (interactive only — piped/CI
  // sessions skip untrusted hooks, fail-closed).
  const hooks = new HookRegistry();
  try {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const hookResult = await loadHooksFromSettingsTrusted(
      workspaceRoot,
      hooks,
      interactive
        ? async (descriptions) => {
            console.log(
              chalk.yellow("\nThis project defines hooks that execute shell commands on tool use:"),
            );
            for (const d of descriptions) console.log(chalk.gray(`   ${d}`));
            const answer = await askYesNo("Trust and enable these project hooks? [y/N] ");
            return answer;
          }
        : null,
    );
    if (hookResult.loaded > 0 && verbose) {
      console.log(`Hooks loaded: ${hookResult.loaded} from .claude/settings.json`);
    }
    if (hookResult.skippedUntrusted) {
      console.error(
        "Warning: project hooks were NOT loaded (untrusted). Run interactively to review " +
          "and trust them, or remove the hooks block from .claude/settings.json.",
      );
    }
  } catch {
    // Hooks are optional; a malformed settings.json never blocks startup.
  }

  // --- REPL ---

  // Interactive (raw-mode) input when attached to a TTY: bordered input box,
  // "/" autocomplete, and selectable permission menus. Otherwise fall back to
  // the line-based readline reader (pipes, CI, non-TTY).
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let rl: readline.Interface | null = null;
  let askQuestion: (prompt: string) => Promise<string | null>;
  let readInput: () => Promise<string | null>;
  let closeInput: () => void;

  if (isInteractive) {
    const reader = createRawInputReader({
      commands: COMMANDS.map((c) => ({ name: c.name, description: c.description })),
    });
    askQuestion = reader.askQuestion;
    readInput = reader.readInput;
    closeInput = reader.close;
  } else {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const inputReader = createCliInputReader(rl);
    askQuestion = inputReader.askQuestion;
    readInput = inputReader.readInput;
    closeInput = () => rl?.close();
  }

  // Tool+target combos the user chose to "always" allow this session.
  const alwaysAllow = new Set<string>();
  const permissionKey = (toolName: string, input: Record<string, unknown>): string => {
    const target =
      (typeof input.filePath === "string" && input.filePath) ||
      (typeof input.command === "string" && input.command) ||
      (typeof input.url === "string" && input.url) ||
      "";
    return `${toolName}::${target}`;
  };

  const resumeSession = async (idOrPrefix: string): Promise<boolean> => {
    const sessions = await persistence.searchSessions(idOrPrefix);
    const matches = sessions.filter((s) => s.sessionId.startsWith(idOrPrefix));
    if (matches.length !== 1) return false;
    const existing = await persistence.load(matches[0].sessionId);
    if (!existing) return false;
    sessionId = existing.sessionId;
    messages.length = 0;
    messages.push(...existing.messages);
    console.log(
      chalk.gray(`  Resumed session ${sessionId.slice(0, 8)}... (${messages.length} messages)`),
    );
    return true;
  };

  const makeCommandContext = () => ({
    messages,
    modelConfig,
    callModel,
    workspaceRoot,
    setWorkspaceRoot,
    sessionId: sessionId!,
    persistence,
    ui: uiState,
    permissions: {
      listAlwaysAllow: () => Array.from(alwaysAllow),
      clearAlwaysAllow: () => alwaysAllow.clear(),
    },
    resumeSession,
    stats: sessionStats,
    tools: toolSources,
    permissionMode,
    getPermissionMode: permissionModeState.get,
    setPermissionMode: (mode: string) => permissionModeState.set(mode as PermissionMode),
    systemPrompt,
    mcpServerCount: mcpManager.serverCount,
    mcpManager,
    hooks,
    goal: goalHolder,
    editorMode: editorModeHolder,
    outputStyle: outputStyleHolder,
    input: {
      askConfirmation: async (question: string): Promise<boolean> => {
        const answer = await askQuestion(question);
        return /^y(es)?$/i.test(answer ?? "");
      },
    },
  });

  // --- TUI path (9.1, 9.7) ---
  // On a TTY (and unless --no-tui), run the Ink-based TUI. Non-TTY / piped
  // input, or an explicit opt-out, falls through to the line-based REPL below.
  const tuiDisabled = process.argv.includes("--no-tui") || process.env.CCR_NO_TUI === "1";
  if (isInteractive && !tuiDisabled) {
    // M25.2: opt-in full-screen layout (alt-screen + in-app scrollback). Default
    // OFF — the proven <Static> native-scrollback path stays the default so
    // there's zero regression for anyone not asking for it.
    const fullscreen = process.argv.includes("--fullscreen") || process.env.CCR_FULLSCREEN === "1";
    const { runTui } = await import("./tui/run.js");
    await runTui({
      messages,
      tools,
      callModel,
      modelConfig,
      systemPrompt,
      workspaceRoot,
      getWorkspaceRoot: () => workspaceRoot,
      sessionId: sessionId!,
      permissionMode,
      commands: COMMANDS.map((c) => ({ name: c.name, description: c.description })),
      hooks,
      makeCommandContext,
      alwaysAllow,
      permissionKey,
      fullscreen,
      // M15.3: opt-in LLM permission classifier, threaded into the TUI's
      // agent loop the same way as the line-based REPL path.
      permissionClassifier,
      // M36: background memory/skill prefetch + (opt-in) tool-batch digest.
      prefetch: prefetchMemories,
      summarizeToolBatch,
      onSave: (taskState, lastTerminalReason) => {
        persistence
          .save(sessionId!, messages, {
            taskState,
            lastTerminalReason: normalizeFinishReason(lastTerminalReason),
          })
          .catch((err) => {
            console.error("Warning: TUI save failed:", formatCliError(err));
          });
      },
    });
    await mcpManager.disconnectAll();
    return;
  }

  // Permission prompt callback. On TTY this draws a bordered Yes/No menu;
  // otherwise it prints a text prompt and reads a y/a/n line. The mutex
  // prevents concurrent tool calls from prompting at the same time.
  let permissionPromptChain: Promise<unknown> = Promise.resolve();
  const askUserImpl: AskUserFn = async (tool, input, riskHint) => {
    const key = permissionKey(tool.name, input);
    // Already approved as "always" for this tool+target this session.
    if (alwaysAllow.has(key)) return true;

    if (isInteractive) {
      const detail =
        (typeof input.command === "string" && input.command) ||
        (typeof input.filePath === "string" && input.filePath) ||
        (typeof input.url === "string" && input.url) ||
        undefined;
      const choice = await promptPermissionMenu({
        header: `${tool.name[0]!.toUpperCase()}${tool.name.slice(1)} request`,
        detail,
        riskHint,
      });
      if (choice === "always") {
        alwaysAllow.add(key);
        // P2-2: Show confirmation feedback for "always allow"
        const target = detail || tool.name;
        console.log(chalk.green(`  ✓ 已记住: ${target} (本会话内不再询问)`));
        return true;
      }
      return choice === "yes";
    }

    renderPermissionPrompt(tool.name, input, riskHint);
    const raw = await askQuestion("     > ");
    // EOF while awaiting a permission decision → treat as deny (safe default).
    if (raw === null) return false;
    const answer = raw.trim().toLowerCase();

    if (answer === "a" || answer === "always") {
      alwaysAllow.add(key);
      // P2-2: Show confirmation feedback for "always allow"
      const target =
        (typeof input.command === "string" && input.command) ||
        (typeof input.filePath === "string" && input.filePath) ||
        tool.name;
      console.log(chalk.green(`  ✓ 已记住: ${target.slice(0, 50)} (本会话内不再询问)`));
      return true;
    }
    return answer === "y" || answer === "yes";
  };

  const askUser: AskUserFn = (tool, input, riskHint) => {
    const run = permissionPromptChain.then(() => askUserImpl(tool, input, riskHint));
    permissionPromptChain = run.catch(() => {});
    return run;
  };

  // Structured question callback for the AskUserQuestion tool. On TTY this
  // draws a selectable menu; otherwise it falls back to a numbered text prompt
  // read line-by-line. Serialized through the same chain as permission prompts.
  const askUserQuestionImpl = async (q: UserQuestion): Promise<string[] | null> => {
    if (isInteractive) {
      return promptSelectMenu({
        header: q.header,
        question: q.question,
        options: q.options,
        multiSelect: q.multiSelect,
      });
    }
    // Non-TTY: print the question + numbered options, read one line.
    console.log(`\n  ${chalk.bold(q.header)}: ${q.question}`);
    q.options.forEach((o, i) => {
      console.log(`    ${i + 1}. ${o.label}`);
    });
    const hint = q.multiSelect ? "numbers separated by commas" : "a number";
    const raw = await askQuestion(`  Choose ${hint}: `);
    if (raw === null) return null;
    const picks = raw
      .split(/[\s,]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => n >= 1 && n <= q.options.length)
      .map((n) => q.options[n - 1]!.label);
    return picks;
  };

  const askUserQuestion = (q: UserQuestion): Promise<string[] | null> => {
    const run = permissionPromptChain.then(() => askUserQuestionImpl(q));
    permissionPromptChain = run.catch(() => {}) as Promise<unknown>;
    return run;
  };

  if (isInteractive && !quiet) {
    renderWelcome({
      version: "1.0.0",
      model: modelConfig.model,
      provider: modelConfig.provider,
      workspaceRoot,
    });
  } else if (quiet) {
    console.log(
      `Claude Code Replica (${modelConfig.provider}/${modelConfig.model}) — /help for commands, exit to quit`,
    );
  } else {
    console.log('Type your request, /help for commands (or "exit" to quit):\n');
  }

  // --- Cleanup ---
  // Centralized resource teardown. Registered as the SIGINT/SIGTERM handler
  // and also called from the try/finally around the REPL loop so normal exits
  // (EOF, "exit", /exit) and fatal errors BOTH get it — previously it was
  // defined and wired AFTER the loop, so it never ran on a normal exit and the
  // signal handlers didn't exist for the whole session. Idempotent — safe to
  // call multiple times.
  let cleanedUp = false;
  async function cleanup(): Promise<void> {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      closeInput();
    } catch {
      /* already closed */
    }
    try {
      telemetry.record("session_end", { toolCalls: sessionStats.toolCalls });
    } catch {
      /* telemetry is best-effort */
    }
    try {
      await persistence.save(sessionId!, messages, { taskState: "stopped_by_user" });
    } catch (err) {
      console.error("Warning: failed to save session on exit:", formatCliError(err));
    }
    try {
      await mcpManager.disconnectAll();
    } catch {
      /* MCP teardown is best-effort */
    }
    try {
      const { disposeAllLspClients } = await import("./lsp.js");
      await disposeAllLspClients();
    } catch {
      /* LSP teardown is best-effort */
    }
    try {
      const { disposeAllReplSessions } = await import("./tools/extended/repl.js");
      disposeAllReplSessions();
    } catch {
      /* REPL teardown is best-effort */
    }
  }

  // Tracks whether the per-turn SIGINT handler is installed. process.emit
  // delivers a signal to EVERY listener, so without this flag a mid-turn
  // Ctrl+C would BOTH abort the turn (per-turn handler) and kill the process
  // (top-level handler) at the same time.
  let turnInProgress = false;

  // Top-level signal handlers. The per-turn SIGINT handler (installed inside
  // the REPL loop) aborts just the current turn; these fire on SIGTERM, or on
  // Ctrl+C at the idle prompt, and tear the whole process down cleanly.
  const onFatalSignal = () => {
    void cleanup().finally(() => {
      console.log("\nInterrupted. Goodbye!");
      process.exit(130);
    });
  };
  process.on("SIGTERM", onFatalSignal);
  process.on("SIGINT", () => {
    if (turnInProgress) return; // the per-turn handler aborts just the turn
    onFatalSignal();
  });

  // Catch-all for unhandled promise rejections and synchronous exceptions so a
  // stray reject (e.g. a floating save) tears down resources instead of
  // leaving the process in a half-dead state.
  const onUnhandledRejection = (reason: unknown) => {
    console.error("Unhandled rejection:", formatCliError(reason));
    void cleanup().finally(() => process.exit(1));
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const onUncaughtException = (err: Error) => {
    console.error("Uncaught exception:", formatCliError(err));
    void cleanup().finally(() => process.exit(1));
  };
  process.on("uncaughtException", onUncaughtException);

  // eslint-disable-next-line no-constant-condition
  try {
    while (true) {
      let userInput = await readInput();

      // null = stdin closed (EOF / Ctrl+D). Exit the REPL cleanly.
      if (userInput === null) break;
      if (!userInput.trim()) continue;
      if (userInput.toLowerCase() === "exit") break;

      // Local slash commands run before anything is sent to the model.
      if (userInput.startsWith("/")) {
        const result = await handleSlashCommand(userInput, makeCommandContext());
        if (result.exit) break;
        // M18: a command may return a prompt to inject as a user message and
        // run through the agent loop (e.g. /review, /recap, /fork). Fall through
        // to the normal turn machinery with that prompt replacing the input.
        if (result.handled) {
          if (result.prompt) {
            userInput = result.prompt;
          } else {
            continue;
          }
        }
      }

      // Expand @file references into context attachments.
      const { attachments, notes } = expandFileRefs(userInput, workspaceRoot);
      for (const note of notes) console.log(chalk.gray(note));

      const contentText =
        attachments.length > 0 ? `${userInput}\n\n${attachments.join("\n\n")}` : userInput;

      // Add user message
      messages.push({
        role: "user",
        content: [{ type: "text", text: contentText }],
      });
      recordTranscript({ type: "user_prompt", text: contentText });

      // Per-turn abort handling: first Ctrl+C aborts the current turn and
      // returns to the prompt; a second (at the idle prompt) exits.
      const controller = new AbortController();
      const onSigint = () => {
        controller.abort("User interrupted");
      };
      process.on("SIGINT", onSigint);
      await persistence.save(sessionId!, messages, { taskState: "waiting_for_model" });

      const renderer = new StreamingRenderer();
      turnInProgress = true;
      const spinner = new Spinner();

      // The permission callback must pause the spinner while a menu is shown.
      const askUserGuarded: AskUserFn = async (tool, input, riskHint) => {
        const wasSpinning = spinner.isActive;
        spinner.stop();
        try {
          return await askUser(tool, input, riskHint);
        } finally {
          if (wasSpinning) spinner.start();
        }
      };

      // Same spinner-pausing guard for structured questions.
      const askUserQuestionGuarded = async (q: UserQuestion): Promise<string[] | null> => {
        const wasSpinning = spinner.isActive;
        spinner.stop();
        renderer.flush();
        try {
          return await askUserQuestion(q);
        } finally {
          if (wasSpinning) spinner.start();
        }
      };

      // Run agent loop. Rebuild the turn system prompt so a /goal or /output-style
      // change made earlier this session takes effect next turn.
      const turnSystemPrompt = buildTurnSystemPrompt();
      const loop = agentLoop(messages, tools, callModel, modelConfig, {
        systemPrompt: turnSystemPrompt,
        maxTurns: resolveMaxTurns(),
        toolContext: {
          workspaceRoot,
          sessionId: sessionId!,
          permissionMode,
          getPermissionMode: permissionModeState.get,
          setPermissionMode: permissionModeState.set,
          modelConfig,
          askUserQuestion: askUserQuestionGuarded,
          // Thread the approver into sub-agent (Task/Team) loops so their
          // destructive tools prompt the user instead of auto-approving.
          askUser: askUserGuarded,
          onSubAgentProgress: (event) => {
            spinner.stop();
            renderer.flush();
            renderSubAgentActivity(event);
          },
          // M15.3: opt-in LLM permission classifier for flagged dangerous calls.
          permissionClassifier,
        },
        askUser: askUserGuarded,
        abortSignal: controller.signal,
        hooks,
        // 12.2: opt-in speculative prefetch of likely follow-up Reads.
        // M15.2: ON by default; --no-speculation / CCR_SPECULATION=0 disable.
        speculation:
          !process.argv.includes("--no-speculation") && process.env.CCR_SPECULATION !== "0",
        // M36: background memory/skill prefetch + (opt-in) tool-batch digest.
        prefetch: prefetchMemories,
        summarizeToolBatch,
      });

      let lastText = "";
      let turnInputTokens = 0;
      let turnOutputTokens = 0;
      let streamedChars = 0;
      let thinkingStart = 0;
      let thoughtReported = false;
      // P2-1: Track idle time for long response warning
      let lastActivityTime = Date.now();
      let idleWarningShown = false;

      // Helper to reset idle tracking
      const resetIdleTimer = () => {
        lastActivityTime = Date.now();
        idleWarningShown = false;
      };

      for await (const event of loop) {
        switch (event.type) {
          case "thinking":
            void persistence.save(sessionId!, messages, { taskState: "waiting_for_model" });
            thinkingStart = Date.now();
            thoughtReported = false;
            resetIdleTimer();
            spinner.setMode("thinking");
            spinner.start();
            break;

          case "text_delta": {
            // First visible text ends the "thinking" phase: print the
            // "Thought for Ns" line, then switch the spinner to responding.
            if (!thoughtReported && thinkingStart > 0) {
              const secs = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
              spinner.stop();
              // P1-3: Enhanced thinking report with context
              const contextTip =
                secs > 30
                  ? chalk.gray(" (模型正在推理复杂任务)")
                  : secs > 10
                    ? chalk.gray(" (等待模型响应)")
                    : "";
              console.log(
                chalk.dim(`  ⏱ 推理耗时 ${secs}s${contextTip}`) +
                  chalk.gray(" (ctrl+o 查看完整思考过程)"),
              );
              thoughtReported = true;
            }
            spinner.stop();
            renderer.write(event.delta);
            streamedChars += event.delta.length;
            spinner.update({ tokens: Math.round(streamedChars / 4) });
            lastText += event.delta;
            // P2-1: Check for long idle (model streaming slowly)
            const idleMs = Date.now() - lastActivityTime;
            if (idleMs > 45000 && !idleWarningShown) {
              idleWarningShown = true;
              console.log(chalk.cyan("\n  💡 模型响应时间较长，请稍候..."));
            }
            break;
          }

          case "tool_use": {
            void persistence.save(sessionId!, messages, { taskState: "waiting_for_tool" });
            resetIdleTimer();
            spinner.stop();
            renderer.flush();
            // Official Claude Code style: orange ● + Name(detail).
            renderToolStart(event.name, event.input);
            recordTranscript({
              type: "tool_use",
              id: event.id,
              name: event.name,
              input: event.input,
            });
            spinner.setMode("tool");
            spinner.start();
            break;
          }

          case "tool_results": {
            resetIdleTimer();
            spinner.stop();
            renderer.flush();
            // Each tool renders its own "⎿ result" line (a compact summary for
            // Read/Grep/Glob). No redundant batch line — matches official output.
            for (const result of event.results) {
              renderToolResult(result);
              recordTranscript({
                type: "tool_result",
                name: result.toolName,
                durationMs: result.durationMs,
                error: result.error,
                preview: SessionTranscript.preview(result.formatted),
              });
            }
            sessionStats.addToolCalls(event.results.length);
            telemetry.record("tool_results", { count: event.results.length });
            // Auto-save after tool execution. Best-effort: a save failure is
            // logged (not silently swallowed) but never blocks the turn.
            persistence.save(sessionId!, messages).catch((err) => {
              console.error("Warning: auto-save after tool calls failed:", formatCliError(err));
            });
            spinner.start();
            break;
          }

          case "compacting":
            void persistence.save(sessionId!, messages, { taskState: "recovering" });
            spinner.stop();
            renderer.flush();
            console.log("\n  " + chalk.cyan("⏳") + " " + chalk.gray("正在压缩上下文…"));
            break;

          case "compacted":
            // P1-1: Enhanced compaction summary with detailed statistics
            spinner.stop();
            renderer.flush();
            console.log("\n  " + chalk.green("✓") + " " + chalk.bold("上下文已压缩"));
            if (event.summary) {
              console.log("  " + chalk.gray("  ") + event.summary);
            }
            console.log(chalk.gray("  ──────────────────────────────────────"));
            console.log(chalk.gray("  提示: /context 可查看当前上下文状态"));
            break;

          case "usage":
            turnInputTokens += event.usage.input_tokens;
            turnOutputTokens += event.usage.output_tokens;
            sessionStats.addUsage(event.usage.input_tokens, event.usage.output_tokens, {
              read: event.usage.cache_read_input_tokens,
              creation: event.usage.cache_creation_input_tokens,
            });
            recordTranscript({
              type: "usage",
              input: event.usage.input_tokens,
              output: event.usage.output_tokens,
              cacheRead: event.usage.cache_read_input_tokens,
              cacheCreation: event.usage.cache_creation_input_tokens,
            });
            spinner.update({ tokens: turnOutputTokens || Math.round(streamedChars / 4) });
            break;

          case "error":
            void persistence.save(sessionId!, messages, { taskState: "failed" });
            spinner.stop();
            renderer.flush();
            recordTranscript({ type: "error", message: formatCliError(event.error) });
            console.error(`\n  ${chalk.red("⎿")} ${formatCliError(event.error)}`);
            break;

          case "done":
            spinner.stop();
            renderer.flush();
            if (uiState.showTokens && (turnInputTokens || turnOutputTokens)) {
              console.log(
                chalk.gray(`\n  [tokens: ${turnInputTokens} in / ${turnOutputTokens} out]`),
              );
            }
            // M15.2: surface speculation cost/benefit (only if anything was
            // prefetched — empty line otherwise).
            if (event.speculation) {
              const line = formatSpeculationLine(event.speculation);
              if (line) console.log(chalk.gray(`  ${line}`));
            }
            // Final assistant text was added to messages in the loop
            persistence
              .save(sessionId!, messages, {
                taskState: "paused",
                lastTerminalReason: normalizeFinishReason(event.finishReason),
              })
              .catch((err) => {
                console.error("Warning: end-of-turn save failed:", formatCliError(err));
              });
            recordTranscript({
              type: "done",
              finishReason: event.finishReason,
              turns: event.turns,
            });
            telemetry.record("turn", {
              inputTokens: turnInputTokens,
              outputTokens: turnOutputTokens,
            });
            break;

          case "aborted":
            void persistence.save(sessionId!, messages, {
              taskState: "stopped_by_user",
              lastTerminalReason: "aborted_by_user",
            });
            spinner.stop();
            renderer.flush();
            recordTranscript({ type: "aborted", reason: event.reason });
            console.log(`\n  ${chalk.dim("⎿")} Aborted: ${event.reason}`);
            break;
        }
      }

      spinner.stop();

      // Detach this turn's SIGINT handler so handlers don't stack up.
      process.removeListener("SIGINT", onSigint);

      console.log(""); // New line after response
      turnInProgress = false;
      // Ensure Windows terminals paint the final buffered line before readline
      // waits for the next prompt; otherwise the user may need to press Enter.
      await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    }
  } finally {
    // Normal exit (EOF / "exit" / /exit) AND a loop-breaking error both land
    // here — the session is saved and long-lived children (MCP stdio servers,
    // tsserver, REPL sessions) are torn down either way.
    await cleanup();
  }
}

main().catch(async (error) => {
  console.error("Fatal error:", formatCliError(error));
  process.exit(1);
});
