#!/usr/bin/env node

// ============================================================
// Claude Code Replica — CLI Entry Point
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import chalk from "chalk";
import dotenv from "dotenv";

import { agentLoop } from "./agent-loop.js";
import { formatCliError } from "./cli-errors.js";
import { createCliInputReader } from "./cli-input.js";
import { createRawInputReader, promptPermissionMenu, promptSelectMenu } from "./cli-interactive.js";
import {
  renderPermissionPrompt,
  renderSubAgentActivity,
  renderToolResult,
  renderToolStart,
  renderWelcome,
  StreamingRenderer,
} from "./cli-renderer.js";
import { Spinner } from "./cli-spinner.js";
import type { ToolSource } from "./commands.js";
import { COMMANDS, handleSlashCommand } from "./commands.js";
import { expandFileRefs } from "./file-refs.js";
import { formatGitContext, gatherGitContext } from "./git-context.js";
import { HookRegistry } from "./hooks.js";
import { createModelCaller, resolveProviderConfig } from "./llm-adapter.js";
import { discoverMCPConfigs, MCPManager } from "./mcp.js";
import { PersistenceManager } from "./persistence.js";
import { SessionStats } from "./session-stats.js";
import { SessionTranscript } from "./session-transcript.js";
import { loadSkillsDir } from "./skills/loadSkillsDir.js";
import { formatSpeculationLine } from "./speculation.js";
import { setCoreToolsForSubagents } from "./subagents.js";
import { buildSystemPrompt, renderSystemPrompt } from "./system-prompt.js";
import { Telemetry } from "./telemetry.js";
import { CORE_TOOLS } from "./tools/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { createMcpResourceTools, createToolSearchTool } from "./tools-m8.js";
import type {
  AskUserFn,
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
  Tool,
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

  return resolveProviderConfig({
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
];

function getPermissionMode(): PermissionMode {
  const mode = process.env.PERMISSION_MODE as PermissionMode | undefined;
  if (mode && VALID_PERMISSION_MODES.includes(mode)) {
    return mode;
  }
  return "default";
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
  const workspaceRoot = getWorkspaceRoot();
  let permissionMode = getPermissionMode();
  const permissionModeState = {
    get: () => permissionMode,
    set: (mode: PermissionMode) => {
      permissionMode = mode;
    },
  };
  const claudeMdContent = loadClaudeMd(workspaceRoot);

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
    const sessions = await persistence.listSessions();
    const incomplete = sessions.filter((s) => !s.completed);
    if (incomplete.length > 0) {
      console.log("Recent incomplete sessions:");
      for (const s of incomplete.slice(0, 5)) {
        console.log(
          `  ${s.sessionId.slice(0, 8)}... — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()}`,
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
  const toolSources: Array<{ tool: Tool; source: ToolSource }> = [];
  for (const tool of CORE_TOOLS) {
    toolRegistry.register(tool);
    toolSources.push({ tool, source: "core" });
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

  // MCP Setup
  const mcpManager = new MCPManager();
  const mcpConfigs = discoverMCPConfigs(workspaceRoot);
  for (const configPath of mcpConfigs) {
    await mcpManager.loadConfig(configPath);
  }
  for (const mcpTool of mcpManager.getAllTools()) {
    toolRegistry.register(mcpTool);
    toolSources.push({ tool: mcpTool, source: "mcp" });
  }

  // MCP resource tools (8.6) — list/read resources from connected servers.
  for (const resTool of createMcpResourceTools(mcpManager)) {
    toolRegistry.register(resTool);
    toolSources.push({ tool: resTool, source: "core" });
  }

  // ToolSearch (8.5) registered last so it can see the full tool set.
  const toolSearchTool = createToolSearchTool(() => toolRegistry.getEnabledTools());
  toolRegistry.register(toolSearchTool);
  toolSources.push({ tool: toolSearchTool, source: "core" });

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

  const systemPrompt = renderSystemPrompt(
    buildSystemPrompt({
      workspaceRoot,
      tools: toolRegistry.getEnabledTools(),
      claudeMdContent,
      model: modelConfig.model,
      // 12.4: inject a compact git snapshot (branch / dirty files / recent
      // commits). Read-only, best-effort — null in non-git dirs.
      gitStatus: await (async () => {
        const ctx = await gatherGitContext(workspaceRoot);
        return ctx ? formatGitContext(ctx) : undefined;
      })(),
    }),
  );

  // --- Model Caller ---

  // Dispatch by provider at *call* time, not once at startup. createModelCaller
  // binds Anthropic vs OpenAI-compatible by `provider`; resolving it per call
  // means /provider (and any in-session config mutation) can switch provider
  // families — including to/from Anthropic — without rebuilding the closure.
  // The branch is a cheap function-ref lookup, so per-turn cost is negligible.
  const callModel: ModelCaller = (messages, tools, systemPrompt, cfg, abortSignal) =>
    createModelCaller(cfg)(messages, tools, systemPrompt, cfg, abortSignal);

  // M15.3: LLM-assisted permission classifier. OFF by default — enable with
  // --llm-perm-classifier or CCR_PERM_CLASSIFIER=1. When enabled, tool calls
  // the regex dangerous-pattern detector already flags get a model-assessed
  // risk hint (or outright block) before the approval prompt. It never relaxes
  // the prompt for ordinary tools, and degrades fail-safe (still prompts with
  // the regex reason) on any API/timeout/unavailable error.
  const llmPermClassifierEnabled =
    process.argv.includes("--llm-perm-classifier") || process.env.CCR_PERM_CLASSIFIER === "1";
  const permissionClassifier: PermissionClassifier | undefined = llmPermClassifierEnabled
    ? {
        callModel,
        modelConfig,
        // Bound classifier latency so a slow/hung provider can't stall the
        // approval flow; on timeout we defer to the regex reason.
        timeoutMs: 4000,
      }
    : undefined;

  // --- Conversation ---

  const tools = toolRegistry.getEnabledTools();

  // --- Hooks ---
  // Empty by default. Register PreToolUse/PostToolUse hooks here (or load
  // them from project config) to intercept, block, or rewrite tool calls.
  const hooks = new HookRegistry();

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
    const sessions = await persistence.listSessions();
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

  const goalHolder = { value: "" };
  const editorModeHolder = { value: "default" } as { value: "default" | "vim" };

  const makeCommandContext = () => ({
    messages,
    modelConfig,
    callModel,
    workspaceRoot,
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
      onSave: () => {
        persistence.save(sessionId!, messages).catch((err) => {
          console.error("Warning: TUI save failed:", formatCliError(err));
        });
      },
    });
    await persistence.save(sessionId!, messages, { completed: true });
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

  // eslint-disable-next-line no-constant-condition
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
      controller.abort("用户中断");
    };
    process.on("SIGINT", onSigint);

    const renderer = new StreamingRenderer();
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

    // Run agent loop. M18.12: append the session goal (if any) so the model
    // keeps the objective in view this turn.
    const turnSystemPrompt = goalHolder.value
      ? `${systemPrompt}\n\n[SESSION GOAL]\nThe user set this objective for the session. Keep it in view and steer toward it:\n${goalHolder.value}`
      : systemPrompt;
    const loop = agentLoop(messages, tools, callModel, modelConfig, {
      systemPrompt: turnSystemPrompt,
      maxTurns: 50,
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
    });

    let lastText = "";
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let streamedChars = 0;
    let thinkingStart = 0;
    let thoughtReported = false;

    for await (const event of loop) {
      switch (event.type) {
        case "thinking":
          thinkingStart = Date.now();
          thoughtReported = false;
          spinner.setMode("thinking");
          spinner.start();
          break;

        case "text_delta":
          // First visible text ends the "thinking" phase: print the
          // "Thought for Ns" line, then switch the spinner to responding.
          if (!thoughtReported && thinkingStart > 0) {
            const secs = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
            spinner.stop();
            console.log(chalk.dim(`  Thought for ${secs}s (ctrl+o to expand)`));
            thoughtReported = true;
          }
          spinner.stop();
          renderer.write(event.delta);
          streamedChars += event.delta.length;
          spinner.update({ tokens: Math.round(streamedChars / 4) });
          lastText += event.delta;
          break;

        case "tool_use":
          spinner.stop();
          renderer.flush();
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

        case "tool_results":
          spinner.stop();
          renderer.flush();
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

        case "compacting":
          spinner.stop();
          renderer.flush();
          console.log("\n  Compacting context…");
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
          persistence.save(sessionId!, messages).catch((err) => {
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
    // Ensure Windows terminals paint the final buffered line before readline
    // waits for the next prompt; otherwise the user may need to press Enter.
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  }

  // --- Cleanup ---
  // Centralized resource teardown. Registered as the SIGINT/SIGTERM handler
  // and also called on the normal + error exit paths so we never leak the
  // long-lived tsserver LSP connection or leave MCP stdio children orphaned
  // (previously a fatal error skipped all of this). Idempotent — safe to call
  // multiple times.
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
      await persistence.save(sessionId!, messages, { completed: true });
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
  }

  // Top-level signal handlers. The per-turn SIGINT handler (installed inside
  // the REPL loop) aborts just the current turn; these fire on a second Ctrl+C
  // or SIGTERM and tear the whole process down cleanly.
  const onFatalSignal = () => {
    void cleanup().finally(() => {
      console.log("\nInterrupted. Goodbye!");
      process.exit(130);
    });
  };
  process.on("SIGTERM", onFatalSignal);
  // The REPL loop installs its own SIGINT handler for per-turn abort; this
  // one is a safety net for signals arriving outside a turn.
  process.on("SIGINT", () => {
    // If we're between turns (no per-turn handler active), exit. The per-turn
    // handler calls preventDefault-equivalent by aborting the controller; if
    // it's installed it consumes the signal and this never runs.
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
}

main().catch(async (error) => {
  console.error("Fatal error:", formatCliError(error));
  process.exit(1);
});
