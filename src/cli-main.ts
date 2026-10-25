// ============================================================
// Claude Code Replica — CLI main flow
// ------------------------------------------------------------
// Loaded by the slim entry cli.ts ONLY after the info flags and the
// fast-path rejects have had their chance to short-circuit. Everything
// heavy (agent loop, provider SDKs, TUI) hangs off this module graph.
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
import { registerInlineAgents } from "./agents/inlineAgents.js";
import { betaWarnings, resolveBetas } from "./api-betas.js";
import { isAxScreenReaderEnabled } from "./ax-screen-reader.js";
import {
  BG_SUBCOMMAND_USAGE,
  BG_SUPERVISOR_NOUN,
  resolveBgStartup,
  resolveJobIdArg,
} from "./bg-startup.js";
import { listChanges } from "./change-tracker.js";
import { bindCheckpointSession, setCheckpointWorkspaceRootResolver } from "./checkpoint.js";
import {
  DEFAULT_CLASSIFIER_RULES,
  mergeClassifierRules,
  parseClassifierRules,
} from "./classifier-rules.js";
import { parseCliArgs } from "./cli-args.js";
import { resolveCliCommand } from "./cli-commands.js";
import {
  confirmProjectAllowRules,
  getPermissionMode,
  getPermissionPolicy,
  getWorkspaceRoot,
  loadClaudeMd,
  loadConfig,
} from "./cli-config.js";
import { checkOrCreateEnv, maybeHandleInfoFlags } from "./cli-env.js";
import { formatCliError } from "./cli-errors.js";
import { createCliInputReader } from "./cli-input.js";
import { createResumeSession, initSession } from "./cli-session.js";
import {
  parseBetaTokens,
  parseDebugFlags,
  parseFileSpecTokens,
  parseFromPrFlag,
  parseInlineAgentsJson,
  parseSessionAgent,
  parseWorktreeFlag,
} from "./cli-session-flags.js";
import { setupTools } from "./cli-tools.js";
// commands.js (full slash-command graph) and cli-prompts.js (TUI render
// chain -> markdown -> highlight.js, ~200 files) are deliberately NOT static
// imports: headless `-p` runs return before either is needed, so both are
// dynamic-imported at their interactive-only use sites below.
import { debugLogger } from "./debug-logger.js";
import { handleUrlElicitation, openExternalUrl } from "./external-url.js";
import { resolveFastPath } from "./fast-path.js";
import {
  describePullRequest,
  lookupPullRequestSession,
  PullRequestLookupError,
  type PullRequestRef,
  parsePullRequestRef,
} from "./from-pr.js";
import { formatGitContext, gatherGitContext } from "./git-context.js";
import { releaseSessionGoal, sessionGoal } from "./goal-runtime.js";
import { installHookEventStream, runHeadless } from "./headless.js";
import { clearHookLifecycleSink } from "./hook-events.js";
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
import { initMemoryApproval } from "./memory-approval.js";
import { autoExtractMemoriesOnExit, MemoryStore } from "./memory-extract.js";
import { savePersistentAlwaysAllow } from "./permission-policy.js";
import { PersistenceManager } from "./persistence.js";
import { pluginDirs, pluginHookSettings } from "./plugins.js";
import { renderPrefetchAttachment, startPrefetch } from "./prefetch.js";
import { memoryIndex } from "./project-memory.js";
import { resolveFastModelConfig } from "./provider-profiles.js";
import { normalizeFinishReason } from "./session-memory.js";
import { settingSources } from "./settings.js";
import { listSkills } from "./skills.js";
import {
  describeFileResult,
  downloadFileResources,
  type FileResourceResult,
  parseFileSpecs,
} from "./startup-files.js";
import { getSubagentType, listSubagentNames } from "./subagents.js";
import { buildSystemPrompt, renderSystemPrompt } from "./system-prompt.js";
import { resolveTmuxStartup } from "./tmux.js";
import { loadDurableJobs } from "./tools/extended/cron-shared.js";
import { releaseSessionSchedules } from "./tools/extended/scheduler.js";
import { killRunningJobs } from "./tools/job-store.js";
import { registerNotificationHook, resetNotifications } from "./tools/notifications.js";
import { createRawInputReader } from "./tui/cli-interactive.js";
import { detectLanguage } from "./tui/i18n.js";
import type {
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
} from "./types.js";
import {
  createIsolatedWorktree,
  pushWorktree,
  randomWorktreeName,
  type WorktreeInfo,
} from "./worktrees.js";

// --- Main ---

async function main() {
  // Info flags first — print + return before touching config / API key / stdin.
  if (await maybeHandleInfoFlags(process.argv)) return;

  // Official `--debug [filter]` / `--debug-file <path>`. Enabled before any
  // other startup work so the earliest provider/tool decisions are covered.
  // A malformed value must fail here rather than silently log nothing.
  const debugFlags = parseDebugFlags(process.argv);
  if (debugFlags) debugLogger.enable(debugFlags.filter, { file: debugFlags.file });

  // Parsed ONCE here and reused: the worktree/agent gates below need
  // `resume`/`continue` before the session exists, and a second parse of the
  // same argv could only ever disagree with the first.
  const cliArgs = parseCliArgs(process.argv);
  if (cliArgs.print) console.log = (...args: unknown[]) => console.error(...args);
  // P0-1: First-run onboarding - guide user to create .env if missing
  if (!cliArgs.print && !(await checkOrCreateEnv())) {
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
  // Official `--betas`. Validated here (not at the adapter) so a rejected value
  // is reported once at startup, where the user can see and fix it — official
  // does the same, warning per value before the first request.
  {
    const resolution = resolveBetas(parseBetaTokens(process.argv));
    for (const warning of betaWarnings(resolution)) console.warn(chalk.yellow(warning));
    if (resolution.allowed.length > 0) {
      modelConfig.options = { ...modelConfig.options, betas: resolution.allowed };
    }
  }
  let workspaceRoot = getWorkspaceRoot();
  // Official `--ax-screen-reader`, resolved ONCE here so the TUI and the
  // startup notice cannot disagree. Read before the worktree swap so the
  // settings it consults are the ones the user actually launched in.
  const axScreenReader = isAxScreenReaderEnabled(readSettings(workspaceRoot));
  const sessionStorageRoot = workspaceRoot;
  setCheckpointWorkspaceRootResolver(() => sessionStorageRoot);

  // Official `-w, --worktree [name]`: run the whole session inside a fresh git
  // worktree. Placed BEFORE the permission mode, settings, trust gate and
  // CLAUDE.md reads on purpose — the point of the flag is that the session
  // behaves as if it were started in that directory.
  //
  // sessionStorageRoot stays on the ORIGINAL checkout: sessions and checkpoints
  // keep living in one place instead of scattering per worktree, and /cd back
  // to the main checkout still finds them.
  // Official `--tmux`: tmux pane backend for the worktree. Checked BEFORE
  // the worktree is created because official serves this flag from a fast
  // path that runs ahead of commander entirely, so on Windows a rejected
  // `--tmux` never touches the filesystem. This project has no tmux pane
  // backend, so every reachable outcome is a failure — which makes
  // failing loudly the only honest option.
  const tmuxDecision = await resolveTmuxStartup(process.argv);
  if (tmuxDecision.kind !== "absent") {
    console.error(tmuxDecision.message);
    process.exitCode = 1;
    return;
  }

  // Official's hidden fast-path: the internal worker entry points, the
  // Remote-Control bridge aliases, and the --cloud / --remote backend flags.
  // These dispatch ahead of the background path in official, so this check
  // runs first; every reachable outcome is a named refusal.
  const fastPathDecision = resolveFastPath(process.argv.slice(2), {
    isTTY: process.stdout.isTTY === true,
  });
  if (fastPathDecision.kind === "reject") {
    console.error(fastPathDecision.message);
    process.exitCode = 1;
    return;
  }

  // Official `--bg` / `--background` and the six background subcommands it
  // advertises. Placed ahead of the worktree/tmux work on purpose: official's
  // fast path runs before everything else, and a background job must never
  // touch a worktree or a tmux pane on its way to being refused. Same reason
  // it sits below the trust check and nothing else that writes.
  const bgDecision = resolveBgStartup(process.argv.slice(2), {
    settings: readSettings(workspaceRoot),
  });
  if (bgDecision.kind === "reject") {
    console.error(bgDecision.message);
    process.exitCode = 1;
    return;
  }
  if (bgDecision.kind === "subcommand") {
    const { usage, summary } = BG_SUBCOMMAND_USAGE[bgDecision.name];
    // Reproduce the branches of official's shared id resolver that are
    // reachable without a job store, then refuse with the gap named. `rm`
    // alone drops the agents hint — official's inline resolver does too.
    const resolved = resolveJobIdArg(bgDecision.arg, usage, [], {
      agentsHint: bgDecision.name !== "rm",
    });
    console.error(
      resolved.kind === "id"
        ? `'${bgDecision.name}' is recognised but not implemented in this project: ${usage} needs a ${BG_SUPERVISOR_NOUN} that this CLI does not run. Nothing was touched.`
        : resolved.message,
    );
    if (resolved.kind !== "id") console.error(summary);
    process.exitCode = 1;
    return;
  }

  // Official's eleven non-background top-level subcommands (auth, doctor,
  // mcp, plugin, update, ...). Commander dispatches these after the
  // pre-commander fast path, so this check sits below the bg block and above
  // everything that builds a session. Each is a named refusal, never a prompt.
  const cliCommandDecision = resolveCliCommand(process.argv.slice(2));
  if (cliCommandDecision.kind === "reject") {
    console.error(cliCommandDecision.message);
    process.exitCode = 1;
    return;
  }

  const worktreeFlag = parseWorktreeFlag(process.argv);
  let worktreeEntry: WorktreeInfo | undefined;
  if (worktreeFlag) {
    // Official documents these as incompatible. Resuming would replay a history
    // recorded in a different directory, and --continue would pick whichever
    // session was last active, which is not the one the user is looking at.
    if (cliArgs.resume || cliArgs.continue) {
      console.error("--worktree cannot be combined with --resume or --continue.");
      process.exitCode = 1;
      return;
    }
    const requested = worktreeFlag.name ?? randomWorktreeName("ccr");
    try {
      worktreeEntry = await createIsolatedWorktree(workspaceRoot, requested);
    } catch (error) {
      console.error(`Cannot create a worktree named "${requested}": ${String(error)}`);
      process.exitCode = 1;
      return;
    }
    workspaceRoot = worktreeEntry.path;
    console.log(
      chalk.gray(
        `Worktree: ${worktreeEntry.path} (branch ${worktreeEntry.branch}, from ${worktreeEntry.baseCommit.slice(0, 8)})`,
      ),
    );
  }

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
            return (await import("./cli-prompts.js")).askYesNo(
              "Trust these project language server commands? [y/N] ",
            );
          }
        : undefined,
    );
  let permissionPolicy = getPermissionPolicy(workspaceRoot);
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

  // --- Official `--from-pr [value]` — resume the session linked to a PR ---
  //
  // Resolved BEFORE initSession so the linked session id flows into the
  // normal startup-resume path rather than being swapped in afterwards
  // (the checkpoint binding and the runtime restore both key off the id
  // that initSession settles on).
  let pullRequestSessionId: string | undefined;
  let pullRequest: PullRequestRef | undefined;
  {
    const fromPr = parseFromPrFlag(process.argv);
    if (fromPr) {
      // Official pairs these two explicitly in its mutual-exclusion
      // check: both select which stored session to load, so accepting
      // both would silently drop one of the two requests.
      if (cliArgs.resume || cliArgs.continue) {
        console.error("--from-pr cannot be combined with --resume or --continue.");
        process.exitCode = 1;
        return;
      }
      if (fromPr.picker) {
        // The interactive picker is not implemented. Say so instead of
        // opening an unrelated fresh session that looks like it worked.
        console.error(
          "Error: --from-pr without a value opens the official interactive PR picker, which is not implemented. Pass a PR number or URL instead, e.g. --from-pr 42.",
        );
        process.exitCode = 1;
        return;
      }
      let ref: PullRequestRef;
      try {
        ref = parsePullRequestRef(fromPr.raw);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      try {
        // A throwaway reader: the lookup is read-only and initSession
        // builds its own manager on the same sessions directory.
        const sessions = await new PersistenceManager(workspaceRoot).listSessions();
        const lookup = await lookupPullRequestSession(ref, workspaceRoot, sessions);
        pullRequest = lookup.ref;
        if (lookup.kind === "resumed") {
          pullRequestSessionId = lookup.session.sessionId;
          console.log(
            chalk.gray(
              `--from-pr ${describePullRequest(lookup.ref)} → session ${lookup.session.sessionId.slice(0, 8)}...`,
            ),
          );
        } else {
          // Official falls through to a plain fresh session here, silently.
          // Reported AND linked instead: the user asked for a specific PR,
          // and an unlinked session is exactly the thing a later
          // `--from-pr <same>` is supposed to find.
          console.log(
            chalk.gray(
              `No session linked to ${describePullRequest(lookup.ref)} yet — starting a new one and linking it to that PR.`,
            ),
          );
        }
      } catch (error) {
        // Every path out of the lookup is fatal by construction: an
        // unresolved PR must not degrade into an unrelated session.
        const message =
          error instanceof PullRequestLookupError || error instanceof Error
            ? error.message
            : String(error);
        console.error(`Error: ${message}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // --- Persistence / session ---

  const messages: Message[] = [];
  const state = await initSession({
    workspaceRoot,
    messages,
    verbose,
    pullRequestSessionId,
    pullRequest,
  });
  const { persistence, session, telemetry } = state;

  // The worktree is pushed onto the session's stack only now that the id
  // exists. Everything below already runs with workspaceRoot = the worktree.
  if (worktreeEntry) pushWorktree(session.id, worktreeEntry);

  // --- Official `--file <specs...>` — startup file resources ---
  //
  // Runs after initSession (the destination is namespaced by session id) and
  // before the system prompt is built, so the model learns what landed in the
  // same prompt that tells it where to look. Never throws: a gateway without
  // the Files API degrades to per-file errors and the session still starts —
  // the failures are reported AND injected, so the model cannot invent files
  // it does not have.
  const startupFiles: FileResourceResult[] = [];
  {
    const { specs, warnings } = parseFileSpecs(parseFileSpecTokens(process.argv));
    for (const warning of warnings) console.warn(chalk.yellow(`Warning: ${warning}`));
    if (specs.length > 0) {
      startupFiles.push(
        ...(await downloadFileResources(specs, workspaceRoot, session.id, {
          baseUrl: modelConfig.baseURL ?? "https://api.anthropic.com",
          apiKey: modelConfig.apiKey,
        })),
      );
      for (const result of startupFiles) console.log(chalk.gray(describeFileResult(result)));
    }
  }

  // Hook lifecycle events go on the stream-json output. Installed here, before
  // any hook runs, because official reports SessionStart unconditionally and
  // that hook fires below — long before the print path is entered.
  if (cliArgs.print && cliArgs.outputFormat === "stream-json")
    installHookEventStream(
      (line) => process.stdout.write(line),
      session.id,
      cliArgs.includeHookEvents,
    );

  // --- Tool Setup ---

  const { toolRegistry, mcpManager, tools } = await setupTools({
    workspaceRoot,
    verbose,
  });

  // --- Session agent (official `--agents` / `--agent`) ---
  //
  // Registered AFTER setupTools so an inline definition overrides a same-named
  // disk or plugin agent: a definition typed on the command line is the most
  // explicit statement of intent available.
  const inlineAgentsJson = parseInlineAgentsJson(process.argv);
  if (inlineAgentsJson !== undefined) {
    const inline = registerInlineAgents(inlineAgentsJson);
    for (const warning of inline.warnings) console.warn(chalk.yellow(`Warning: ${warning}`));
    if (inline.errors.length > 0) {
      for (const error of inline.errors) console.error(chalk.red(`Error: ${error}`));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.gray(`Session agents: ${inline.agents.map((a) => a.name).join(", ")}`));
  }

  const sessionAgentName = parseSessionAgent(process.argv);
  let agentPersona: { name: string; prompt: string } | undefined;
  if (sessionAgentName) {
    const type = getSubagentType(sessionAgentName);
    if (!type) {
      // A typo that silently fell back to the default persona would look
      // exactly like the flag having worked.
      console.error(
        chalk.red(
          `Unknown --agent "${sessionAgentName}". Available agents: ${listSubagentNames().join(", ")}`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    agentPersona = { name: type.name, prompt: type.systemPrompt };
    console.log(chalk.gray(`Session agent: ${type.name} — ${type.description}`));
  }

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
  // Set once the TUI takes stdin — inside it, askYesNo's cooked readline cannot
  // run, so /cd into a workspace with untrusted allow rules strips them
  // (getPermissionPolicy) instead of prompting.
  let tuiActive = false;
  const setWorkspaceRoot = async (next: string): Promise<boolean> => {
    try {
      if (!fs.statSync(next).isDirectory()) return false;
    } catch {
      return false;
    }
    workspaceRoot = next;
    claudeMdContent = loadClaudeMd(next);
    // Review fix ("/cd 后沿用旧工作区权限策略"): every security-relevant
    // derivation must be recomputed for the NEW workspace — otherwise the new
    // workspace's deny/ask rules never apply and the OLD workspace's trusted
    // allow rules keep skipping prompts there. The memory-approval gate is
    // equally workspace-scoped (its strict mode can be set per project).
    permissionMode = getPermissionMode(next);
    permissionPolicy = getPermissionPolicy(next);
    initMemoryApproval(next);
    await confirmProjectAllowRules(next, { interactive: !tuiActive });
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
        // Official `--agent <name>`: persona prepended to the identity block.
        agentPersona,
        // Official `--brief`: the SendUserMessage channel exists this session
        // (the tool is registered in cli-tools.ts under the same flag).
        brief: cliArgs.brief,
        // Official `--file`: startup resources fetched before the first turn.
        startupFiles,
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
      return (await import("./cli-prompts.js")).askYesNo("Trust and enable these hooks? [y/N] ");
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
    // Detached here rather than in runHeadless: the SessionEnd hook above is
    // the last thing that can report lifecycle events on the stream.
    clearHookLifecycleSink();
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
    const { COMMANDS } = await import("./commands.js");
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
  const { createUserPrompters } = await import("./cli-prompts.js");
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
      // Review fix ("统计状态泄漏"): the resumed session must start its own
      // /cost and /status counters — the shared SessionStats otherwise kept
      // accumulating the previous session's tokens/cost into this one.
      state.stats.reset();
    },
  });

  const makeCommandContext = () => ({
    messages,
    modelConfig,
    callModel,
    fastModelFactory: getFastModel,
    workspaceRoot,
    setWorkspaceRoot,
    rotateSessionId: () => {
      // /sessions delete --force of the CURRENT session: the deleted id must
      // stop being the save target, or the next auto-save resurrects the file
      // the user just deleted (review fix). Everything bound to the old id is
      // released the same way /resume does — schedules, the goal cell, and
      // (self-review fix) the old session's queued notifications, which would
      // otherwise strand or ride into the fresh session's first prompt.
      releaseSessionSchedules(session.id);
      releaseSessionGoal(session.id);
      resetNotifications(session.id);
      session.id = persistence.generateId();
      goalHolder.value = "";
      bindCheckpointSession(session.id, workspaceRoot);
      return session.id;
    },
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
    // Official announces the mode on the TTY only, and not under --print
    // (`if (!M && process.stdout.isTTY && qP())`). Reaching here already means
    // interactive, so the guard collapses to this one line.
    if (axScreenReader) console.log("[Accessible screen reader mode: on]");
    // M25.2: opt-in full-screen layout (alt-screen + in-app scrollback). Default
    // OFF — the proven <Static> native-scrollback path stays the default so
    // there's zero regression for anyone not asking for it.
    //
    // Official `--ax-screen-reader` wins over an explicit --fullscreen: its
    // alternate-screen predicate short-circuits on the flag, so the request is
    // dropped rather than half-honoured. Announced below so the ignored flag
    // is not silent.
    const requestedFullscreen =
      process.argv.includes("--fullscreen") || process.env.CCR_FULLSCREEN === "1";
    const fullscreen = requestedFullscreen && !axScreenReader;
    if (requestedFullscreen && axScreenReader) {
      console.error(
        "Warning: --fullscreen is ignored while screen-reader mode is on (the alternate screen buffer is not used).",
      );
    }
    const { runTui } = await import("./tui/run.js");
    const { COMMANDS } = await import("./commands.js");
    const { permissionKey } = await import("./cli-prompts.js");
    tuiActive = true;
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
      // Live policy — /cd reloads it for the new workspace mid-session.
      getPermissionPolicy: () => permissionPolicy,
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
      // Returns the save PROMISE (review fix "TUI /exit 未等待保存"): the TUI's
      // exit path awaits it before process.exit instead of racing a 50ms timer.
      onSave: (taskState, lastTerminalReason) =>
        persistence
          .save(session.id, messages, {
            taskState,
            lastTerminalReason: normalizeFinishReason(lastTerminalReason),
            waitForLock: true,
          })
          .catch((err) => {
            console.error("Warning: TUI save failed:", formatCliError(err));
          }),
    });
    // Review fix ("正常 TUI 退出不触发 SessionEnd"): every other surface
    // (headless, line REPL) fires the SessionEnd hook — the TUI path skipped
    // it, silently breaking exit-time hook workflows.
    await hooks
      .runEvent("SessionEnd", { session_id: session.id, workspace_root: workspaceRoot })
      .catch(() => {});
    await mcpManager.disconnectAll();
    await disposeAllLspClients();
    // The TUI ended (exit/EOF): running background jobs must not keep the
    // process or their TTL timers alive past the user's exit (review fix).
    killRunningJobs(session.id, "session exited");

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
  // Dynamic import: the REPL pulls the markdown/highlight.js render chain
  // (~200 files); headless runs return above without paying for it.
  const { runRepl } = await import("./cli-repl.js");
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
    // Live policy — /cd reloads it for the new workspace mid-session.
    getPermissionPolicy: () => permissionPolicy,
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
