#!/usr/bin/env node

// ============================================================
// Claude Code Replica — CLI Entry Point
// ------------------------------------------------------------
// Orchestration only. The implementation lives in dedicated modules:
//   cli-env.ts      .env loading, info flags, first-run onboarding
//   cli-config.ts   provider config, workspace, permission mode, maxTurns
//   cli-session.ts  persistence / transcript / stats / telemetry, resume
//   cli-tools.ts    ToolRegistry assembly: core tools, skills, MCP
//   cli-prompts.ts  trust y/N, permission + structured-question prompts
//   cli-repl.ts     line-based REPL: signals, cleanup, turn rendering
// cli-env must be imported first — it performs dotenv loading at module
// evaluation time, before any other module can read process.env.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import chalk from "chalk";
import { agentLoop } from "./agent-loop.js";
import { listChanges } from "./change-tracker.js";
import { setCheckpointWorkspaceRootResolver } from "./checkpoint.js";
import {
  DEFAULT_CLASSIFIER_RULES,
  mergeClassifierRules,
  parseClassifierRules,
} from "./classifier-rules.js";
import { parseCliArgs } from "./cli-args.js";
import {
  confirmProjectAllowRules,
  getPermissionMode,
  getPermissionPolicy,
  getWorkspaceRoot,
  loadClaudeMd,
  loadConfig,
  resolveMaxTurns,
} from "./cli-config.js";
import { checkOrCreateEnv, maybeHandleInfoFlags } from "./cli-env.js";
import { formatCliError } from "./cli-errors.js";
import { createCliInputReader } from "./cli-input.js";
import { askYesNo, createUserPrompters, permissionKey } from "./cli-prompts.js";
import { runRepl } from "./cli-repl.js";
import { createResumeSession, initSession } from "./cli-session.js";
import { setupTools } from "./cli-tools.js";
import { COMMANDS } from "./commands.js";
import { handleUrlElicitation, openExternalUrl } from "./external-url.js";
import { formatGitContext, gatherGitContext } from "./git-context.js";
import { sessionGoal } from "./goal-runtime.js";
import { runHeadless } from "./headless.js";
import { HookRegistry } from "./hooks.js";
import {
  configureHookServices,
  loadHooksConfigTrusted,
  loadHooksFromSettingsTrusted,
  parseHooksConfig,
  readSettings,
  registerHooksFromConfig,
  warnUnknownSettings,
} from "./hooks-config.js";
import { confirmProjectLspConfig } from "./language-servers.js";
import { createModelCaller } from "./llm-adapter.js";
import { disposeAllLspClients } from "./lsp.js";
import { autoExtractMemoriesOnExit, MemoryStore } from "./memory-extract.js";
import { savePersistentAlwaysAllow } from "./permission-policy.js";
import { pluginDirs, pluginHookSettings } from "./plugins.js";
import { renderPrefetchAttachment, startPrefetch } from "./prefetch.js";
import { memoryIndex } from "./project-memory.js";
import { resolveFastModelConfig } from "./provider-profiles.js";
import { normalizeFinishReason } from "./session-memory.js";
import { settingSources } from "./settings.js";
import { listSkills } from "./skills.js";
import { buildSystemPrompt, renderSystemPrompt } from "./system-prompt.js";
import { loadDurableJobs } from "./tools/extended/cron-shared.js";
import { registerNotificationHook } from "./tools/notifications.js";
import { createRawInputReader } from "./tui/cli-interactive.js";
import { detectLanguage } from "./tui/i18n.js";
import type {
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
} from "./types.js";

// --- Main ---

async function main() {
  // Info flags first — print + return before touching config / API key / stdin.
  if (maybeHandleInfoFlags(process.argv)) return;

  const startupArgs = parseCliArgs(process.argv);
  if (startupArgs.print) console.log = (...args: unknown[]) => console.error(...args);
  // P0-1: First-run onboarding - guide user to create .env if missing
  if (!startupArgs.print && !(await checkOrCreateEnv())) {
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
  const sessionStorageRoot = workspaceRoot;
  setCheckpointWorkspaceRootResolver(() => sessionStorageRoot);
  let permissionMode = getPermissionMode(workspaceRoot);
  // A3 trust gate: a cloned repo's project allow rules need a one-time
  // fingerprint confirmation BEFORE the policy is assembled (untrusted allow
  // rules are stripped inside getPermissionPolicy).
  await confirmProjectAllowRules(workspaceRoot);
  if (!process.argv.includes("--safe-mode") && !process.argv.includes("--bare"))
    await confirmProjectLspConfig(
      workspaceRoot,
      process.stdin.isTTY && process.stdout.isTTY
        ? async (description) => {
            console.log(description);
            return askYesNo("Trust these project language server commands? [y/N] ");
          }
        : undefined,
    );
  const permissionPolicy = getPermissionPolicy(workspaceRoot);
  warnUnknownSettings(readSettings(workspaceRoot));
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

  // --- Persistence / session ---

  const messages: Message[] = [];
  const state = await initSession({ workspaceRoot, messages, verbose });
  const { persistence, session, telemetry } = state;

  // --- Tool Setup ---

  const { toolRegistry, mcpManager, tools } = await setupTools({
    workspaceRoot,
    verbose,
  });

  // --- System Prompt ---

  telemetry.record("session_start", {
    provider: modelConfig.provider,
    model: modelConfig.model,
    tools: toolRegistry.enabledCount,
    mcpServers: mcpManager.serverCount,
    permissionMode,
    permissionPolicy,
  });

  // Mutable session holders read by both the system-prompt builder and the
  // corresponding slash commands (/goal, /output-style). Stored as `{ value }`
  // references so a command and the REPL share the same cell.
  const goalHolder = { value: sessionGoal(session.id)?.objective ?? "" };
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
  // holders. buildSystemPrompt memoizes ALL of its static sections — the
  // output-style block is keyed by style name and the tool-descriptions block
  // by a fingerprint of the enabled tool set (Top10 #10) — so rebuilding each
  // turn is cheap: only the dynamic suffix recomputes, and an MCP tool-set
  // change recomputes just the tools block.
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
        // Withhold denied tools from the AVAILABLE TOOLS index so it matches
        // the `tools` payload the adapters actually send.
        permissionPolicy,
      }),
    );
    const memory = memoryIndex(workspaceRoot);
    const withMemory =
      memory && !process.argv.includes("--safe-mode")
        ? `${base}\n\n[PROJECT MEMORY INDEX]\n${memory}`
        : base;
    return goalHolder.value
      ? `${withMemory}\n\n[SESSION GOAL]\nThe user set this objective for the session. Keep it in view and steer toward it:\n${goalHolder.value}`
      : withMemory;
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
      memories: () => [...memoryStore.list(), ...new MemoryStore(workspaceRoot, "user").list()],
      skills: () => listSkills(),
    }).then(renderPrefetchAttachment);

  // M5: optional fast-model side channel (CCR_FAST_MODEL, "provider/model").
  // Resolved lazily per call so /provider and /model switches mid-session are
  // picked up. Null when unset — callers then use the main model.
  const getFastModel = (): { callModel: ModelCaller; modelConfig: ModelConfig } | null => {
    const fastConfig = resolveFastModelConfig(modelConfig);
    if (fastConfig && modelConfig.options?.ccrBudget)
      fastConfig.options = { ...fastConfig.options, ccrBudget: modelConfig.options.ccrBudget };
    return fastConfig
      ? {
          callModel: (m, t, s, c, a) => createModelCaller(c)(m, t, s, c, a),
          modelConfig: fastConfig,
        }
      : null;
  };

  // M36: fast-model digest of a finished tool batch (kernel §9). OFF by default
  // — it fires a concurrent model call per large batch — so enable explicitly
  // with CCR_TOOL_SUMMARY=1. When a fast model is configured (M5) the digest
  // rides it instead of the main model.
  const summarizeToolBatch =
    process.env.CCR_TOOL_SUMMARY === "1"
      ? async (prompt: string): Promise<string | null> => {
          try {
            const fast = getFastModel();
            let text = "";
            for await (const event of (fast?.callModel ?? callModel)(
              [{ role: "user", content: [{ type: "text", text: prompt }] }],
              [],
              "",
              fast?.modelConfig ?? modelConfig,
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
          // Session-level verdict cache: repeat flagged calls skip the model.
          cache: new Map(),
        }
      : undefined;

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
  const customizations = !process.argv.includes("--safe-mode") && !process.argv.includes("--bare");
  configureHookServices({
    async evaluate(prompt, payload, useAgent) {
      const input = prompt.replaceAll("$ARGUMENTS", JSON.stringify(payload));
      const hookMessages: Message[] = [{ role: "user", content: [{ type: "text", text: input }] }];
      const config = getFastModel()?.modelConfig ?? modelConfig;
      let response = "";
      if (useAgent) {
        const readonly = tools.filter((tool) => ["read", "glob", "grep"].includes(tool.name));
        for await (const event of agentLoop(hookMessages, readonly, callModel, config, {
          systemPrompt:
            'Evaluate the hook condition. Return only JSON {"ok":true} or {"ok":false,"reason":"..."}.',
          maxTurns: 8,
          askUser: async () => false,
          toolContext: {
            workspaceRoot,
            sessionId: `${session.id}-hook`,
            permissionMode: "plan",
            permissionPolicy,
          },
        }))
          if (event.type === "text_delta") response += event.delta;
      } else
        for await (const event of callModel(
          hookMessages,
          [],
          'Return only JSON {"ok":true} or {"ok":false,"reason":"..."}.',
          config,
        ))
          if (event.type === "text_delta") response += event.delta;
      return JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<
        string,
        unknown
      >;
    },
    async callMcpTool(name, input) {
      const tool = mcpManager.getAllTools().find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Unknown hook MCP tool: ${name}`);
      const result = await tool.call(input, {
        workspaceRoot,
        sessionId: session.id,
        permissionMode,
        permissionPolicy,
      });
      if (result.error) throw new Error(result.error);
      return JSON.parse(result.content) as Record<string, unknown>;
    },
  });
  const unregisterNotificationHook = registerNotificationHook(async (payload) => {
    await hooks.runEvent("Notification", payload);
  });
  // Session context for the official hook stdin envelope (session_id /
  // transcript_path / cwd) and the directory hook commands run in.
  const hookCtx = {
    get sessionId() {
      return session.id;
    },
    get workspaceRoot() {
      return workspaceRoot;
    },
    transcriptRoot: sessionStorageRoot,
  };
  if (customizations)
    registerHooksFromConfig(
      hooks,
      parseHooksConfig(
        readSettings(workspaceRoot, settingSources().includes("user") ? ["user"] : []),
      ),
      hookCtx,
    );
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const confirmHooks = (label: string) => {
    const ask = async (descriptions: string[]): Promise<boolean> => {
      console.log(
        chalk.yellow(`\n${label} defines hooks that execute shell commands on tool use:`),
      );
      for (const d of descriptions) console.log(chalk.gray(`   ${d}`));
      return askYesNo("Trust and enable these hooks? [y/N] ");
    };
    return ask;
  };
  try {
    const hookResult = customizations
      ? await loadHooksFromSettingsTrusted(
          workspaceRoot,
          hooks,
          interactive ? confirmHooks("This project") : null,
          hookCtx,
        )
      : { loaded: 0, skippedUntrusted: false };
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
  for (const pluginDir of customizations ? pluginDirs(workspaceRoot) : []) {
    try {
      // Plugin hooks get the SAME trust gate as project hooks. The confirm
      // callback used to be null, so a plugin shipping hooks could never be
      // trusted — silently dead config (same failure class as the inert
      // remote-plugin manifest fixed in a9e50bc).
      const name = path.basename(pluginDir);
      const result = await loadHooksFromSettingsTrusted(
        pluginDir,
        hooks,
        interactive ? confirmHooks(`Plugin ${name}`) : null,
        hookCtx,
      );
      const standard = await loadHooksConfigTrusted(
        pluginDir,
        parseHooksConfig(pluginHookSettings(pluginDir)),
        hooks,
        interactive ? confirmHooks(`Plugin ${name}`) : null,
        hookCtx,
      );
      if (result.skippedUntrusted || standard.skippedUntrusted) {
        console.error(
          `Warning: hooks from plugin ${name} were NOT loaded (untrusted). ` +
            "Run interactively to review and trust them.",
        );
      }
    } catch {
      /* isolated plugin */
    }
  }
  const startupHook = await hooks.runEvent("SessionStart", {
    session_id: session.id,
    workspace_root: workspaceRoot,
    source: "startup",
  });
  if (startupHook?.additionalContext)
    messages.push({ role: "system", content: startupHook.additionalContext });

  // Official-compatible one-shot/headless mode. It deliberately uses the same
  // agent loop and permission policy as the interactive clients, while never
  // opening an approval prompt (unsafe calls are denied in CI).
  const cliArgs = parseCliArgs(process.argv);
  const allowedDirectories = cliArgs.addDirs.map((dir) => path.resolve(workspaceRoot, dir));
  if (cliArgs.print) {
    try {
      await runHeadless({
        args: cliArgs,
        input: process.stdin,
        emit: (value) => process.stdout.write(value),
        messages,
        tools,
        callModel,
        config: modelConfig,
        context: {
          workspaceRoot,
          allowedDirectories,
          sessionId: session.id,
          permissionMode,
          permissionPolicy,
          modelConfig,
        },
        hooks,
        systemPrompt: buildTurnSystemPrompt(),
        save: (saved) => persistence.save(session.id, saved, { taskState: "paused" }),
      });
    } finally {
      await mcpManager.disconnectAll();
      await disposeAllLspClients();
    }
    await hooks
      .runEvent("SessionEnd", { session_id: session.id, workspace_root: workspaceRoot })
      .catch(() => {});
    await mcpManager.disconnectAll();
    await disposeAllLspClients();
    unregisterNotificationHook();
    return;
  }

  // --- Input ---
  // Interactive (raw-mode) input when attached to a TTY: bordered input box,
  // "/" autocomplete, and selectable permission menus. Otherwise fall back to
  // the line-based readline reader (pipes, CI, non-TTY).
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let rl: readline.Interface | null = null;
  let askQuestion: (prompt: string) => Promise<string | null>;
  let readInput: () => Promise<string | null>;
  let closeInput: () => void;
  /** Scheduler delivery: inject a synthetic user line (idle REPL only). */
  let injectInput: (line: string) => void;

  if (isInteractive) {
    const reader = createRawInputReader({
      commands: COMMANDS.map((c) => ({ name: c.name, description: c.description })),
    });
    askQuestion = reader.askQuestion;
    readInput = reader.readInput;
    closeInput = reader.close;
    injectInput = reader.inject;
  } else {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const inputReader = createCliInputReader(rl);
    askQuestion = inputReader.askQuestion;
    readInput = inputReader.readInput;
    closeInput = () => rl?.close();
    injectInput = inputReader.inject;
  }

  // MCP elicitation bridge. The same callback serves TTY and non-TTY modes:
  // TUI/raw readers already own the terminal, while piped CI sessions receive
  // deterministic line prompts. Invalid or incomplete answers are declined.
  mcpManager.setElicitationHandler(async (request) => {
    if (request.mode === "url")
      return handleUrlElicitation(request, {
        confirmOpen: async (url) =>
          /^y(?:es)?$/i.test(
            (await askQuestion(`\n${request.message}\nOpen ${url}? [y/N] `))?.trim() ?? "",
          ),
        open: openExternalUrl,
        confirmComplete: async () =>
          (await askQuestion("After completing authentication, type accept (or cancel): "))
            ?.trim()
            .toLowerCase() === "accept",
      });
    const schema = request.requestedSchema ?? {};
    const properties = (
      schema.properties && typeof schema.properties === "object" ? schema.properties : {}
    ) as Record<
      string,
      {
        type?: string;
        title?: string;
        description?: string;
        enum?: string[];
        minimum?: number;
        maximum?: number;
      }
    >;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === "string")
      : [];
    console.log(`\nMCP request: ${request.message}`);
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [name, field] of Object.entries(properties)) {
      const hint = field.enum?.length ? ` [${field.enum.join("/")}]` : "";
      const raw = await askQuestion(`${field.title ?? name}${hint}: `);
      if (raw === null || raw.trim().toLowerCase() === "cancel") return { action: "cancel" };
      const value = raw.trim();
      if (!value && required.includes(name)) return { action: "decline" };
      if (!value) continue;
      if (field.enum && !field.enum.includes(value)) return { action: "decline" };
      if (field.type === "boolean") content[name] = /^(true|yes|y)$/i.test(value);
      else if (field.type === "number" || field.type === "integer") {
        const n = Number(value);
        if (
          !Number.isFinite(n) ||
          (field.minimum !== undefined && n < field.minimum) ||
          (field.maximum !== undefined && n > field.maximum)
        )
          return { action: "decline" };
        content[name] = n;
      } else if (field.type === "array")
        content[name] = value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      else content[name] = value;
    }
    return { action: "accept", content };
  });

  // Permission + structured-question prompts, sharing one serialization chain.
  const { alwaysAllow, askUser, askUserQuestion, getPendingPromptCount } = createUserPrompters({
    isInteractive,
    askQuestion,
  });

  const resumeSession = createResumeSession({
    persistence,
    session,
    messages,
    onResume: () => {
      goalHolder.value = sessionGoal(session.id)?.objective ?? "";
      mcpManager.clearApprovals();
    },
  });

  const makeCommandContext = () => ({
    messages,
    modelConfig,
    callModel,
    fastModelFactory: getFastModel,
    workspaceRoot,
    setWorkspaceRoot,
    sessionId: session.id,
    persistence,
    ui: uiState,
    permissions: {
      listAlwaysAllow: () => Array.from(alwaysAllow),
      clearAlwaysAllow: () => {
        alwaysAllow.clear();
        savePersistentAlwaysAllow(alwaysAllow);
      },
    },
    resumeSession,
    stats: state.stats,
    tools: toolRegistry.listSources(),
    permissionMode,
    getPermissionMode: permissionModeState.get,
    setPermissionMode: (mode: string) => permissionModeState.set(mode as PermissionMode),
    systemPrompt: buildTurnSystemPrompt(),
    contextMemoryFiles: claudeMdContent
      ? [{ path: path.join(workspaceRoot, "CLAUDE.md"), content: claudeMdContent }]
      : [],
    mcpServerCount: mcpManager.serverCount,
    mcpManager,
    hooks,
    goal: goalHolder,
    editorMode: editorModeHolder,
    outputStyle: outputStyleHolder,
    permissionPolicy,
    input: {
      askConfirmation: async (question: string): Promise<boolean> => {
        const answer = await askQuestion(question);
        return /^y(es)?$/i.test(answer ?? "");
      },
    },
  });

  // --- TUI path (9.1, 9.7) ---
  // M41: durable cron jobs registered in a previous run (schedule_cron with
  // durable=true). Loaded before either UI path runs; the firing loop lives
  // in the scheduler (started by the TUI root or the line REPL below).
  {
    const durable = loadDurableJobs(workspaceRoot);
    if (durable.loaded > 0) {
      console.log(
        chalk.gray(
          `Restored ${durable.loaded} durable scheduled job(s)${durable.skipped > 0 ? `, skipped ${durable.skipped} invalid` : ""}`,
        ),
      );
    }
  }

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
      // B1: live per-turn rebuild (memoized, so cheap) — MCP servers that
      // connect mid-session and /memory or git refreshes now reach the model
      // in the TUI path too, instead of being frozen at startup.
      buildTurnSystemPrompt,
      workspaceRoot,
      getWorkspaceRoot: () => workspaceRoot,
      sessionId: session.id,
      // Live reader: /resume rewrites session.id in place (cli-session.ts);
      // the captured string above would go stale and split checkpoint buckets
      // away from /rewind's (live) ctx.sessionId.
      getSessionId: () => session.id,
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
      permissionPolicy,
      allowedDirectories,
      setupElicitation: (store) => {
        mcpManager.setElicitationHandler(async (request) => {
          if (request.mode === "url")
            return handleUrlElicitation(request, {
              confirmOpen: (url) => store.askConfirmation(`${request.message}\nOpen ${url}?`),
              open: openExternalUrl,
              confirmComplete: () =>
                store.askConfirmation("After completing authentication in the browser, continue?"),
            });
          const schema = request.requestedSchema ?? {};
          const properties = (
            schema.properties && typeof schema.properties === "object" ? schema.properties : {}
          ) as Record<
            string,
            {
              type?: string;
              title?: string;
              description?: string;
              enum?: string[];
              minimum?: number;
              maximum?: number;
            }
          >;
          const fields = Object.entries(properties).map(([name, field]) => ({
            ...field,
            name,
            required: Array.isArray(schema.required) && schema.required.includes(name),
          }));
          return store.askElicitation(request.message, fields);
        });
      },
      // M36: background memory/skill prefetch + (opt-in) tool-batch digest.
      prefetch: prefetchMemories,
      summarizeToolBatch,
      fastModelFactory: getFastModel,
      onSave: (taskState, lastTerminalReason) => {
        persistence
          .save(session.id, messages, {
            taskState,
            lastTerminalReason: normalizeFinishReason(lastTerminalReason),
          })
          .catch((err) => {
            console.error("Warning: TUI save failed:", formatCliError(err));
          });
      },
    });
    await mcpManager.disconnectAll();
    await disposeAllLspClients();

    // F1: session-exit auto-extraction. Heuristic pass is offline/cheap and on
    // by default; the model-assisted pass costs one call and is opt-in via
    // CCR_AUTO_MEMORY_EXTRACT=1 (=0 disables auto-extraction entirely).
    if (process.env.CCR_AUTO_MEMORY_EXTRACT !== "0") {
      const fast = getFastModel();
      const written = await autoExtractMemoriesOnExit({
        workspaceRoot,
        messages,
        changes: listChanges(session.id),
        useModel: process.env.CCR_AUTO_MEMORY_EXTRACT === "1",
        callModel: fast?.callModel ?? callModel,
        modelConfig: fast?.modelConfig ?? modelConfig,
      });
      if (written.length > 0) {
        console.log(`Remembered ${written.length} new memor${written.length === 1 ? "y" : "ies"}.`);
      }
    }
    return;
  }

  // --- Line-based REPL (non-TTY / --no-tui) ---
  await runRepl({
    messages,
    tools,
    callModel,
    modelConfig,
    buildTurnSystemPrompt,
    getWorkspaceRoot: () => workspaceRoot,
    permissionModeState,
    permissionClassifier,
    permissionPolicy,
    allowedDirectories,
    prefetch: prefetchMemories,
    summarizeToolBatch,
    fastModelFactory: getFastModel,
    hooks,
    mcpManager,
    state,
    askUser,
    askUserQuestion,
    readInput,
    closeInput,
    injectInput,
    getPendingPromptCount,
    makeCommandContext,
    isInteractive,
    quiet,
    showTokens: uiState.showTokens,
  });

  // F1: same session-exit auto-extraction for the line-based REPL path.
  if (process.env.CCR_AUTO_MEMORY_EXTRACT !== "0") {
    const fast = getFastModel();
    const written = await autoExtractMemoriesOnExit({
      workspaceRoot,
      messages,
      changes: listChanges(session.id),
      useModel: process.env.CCR_AUTO_MEMORY_EXTRACT === "1",
      callModel: fast?.callModel ?? callModel,
      modelConfig: fast?.modelConfig ?? modelConfig,
    });
    if (written.length > 0) {
      console.log(`Remembered ${written.length} new memor${written.length === 1 ? "y" : "ies"}.`);
    }
  }
}

main().catch(async (error) => {
  console.error("Fatal error:", formatCliError(error));
  process.exit(1);
});
