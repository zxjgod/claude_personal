// ============================================================
// CLI line-based REPL — welcome banner, cleanup + signal handlers,
// the read/turn loop, and per-turn event rendering. Used when the
// Ink TUI is unavailable (non-TTY) or disabled via --no-tui.
// ============================================================

import chalk from "chalk";

import { agentLoop } from "./agent-loop.js";
import { beginUserTurn } from "./checkpoint.js";
import { resolveMaxTurns } from "./cli-config.js";
import { formatCliError } from "./cli-errors.js";
import type { SessionState } from "./cli-session.js";
import type { CommandContext } from "./commands/types.js";
import { handleSlashCommand } from "./commands.js";
import type { HookRegistry } from "./hooks.js";
import type { MCPManager } from "./mcp/index.js";
import { normalizeFinishReason } from "./session-memory.js";
import { formatSpeculationLine } from "./speculation.js";
import { startScheduler } from "./tools/extended/scheduler.js";
import { drainNotifications, formatNotificationLine } from "./tools/notifications.js";
import { expandFileRefs } from "./tools/utils/file-refs.js";
import {
  renderSubAgentActivity,
  renderToolResult,
  renderToolStart,
  renderWelcome,
  StreamingRenderer,
} from "./tui/cli-renderer.js";
import { Spinner } from "./tui/cli-spinner.js";
import { SessionTranscript } from "./tui/session-transcript.js";
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

export interface ReplDeps {
  messages: Message[];
  tools: Tool[];
  callModel: ModelCaller;
  modelConfig: ModelConfig;
  /** Rebuilt each turn so /goal or /output-style changes take effect. */
  buildTurnSystemPrompt: () => string;
  /** Live getter — /cd can move the workspace mid-session. */
  getWorkspaceRoot: () => string;
  permissionModeState: {
    get: () => PermissionMode;
    set: (mode: PermissionMode) => void;
  };
  permissionClassifier: PermissionClassifier | undefined;
  permissionPolicy?: import("./permission-policy.js").PermissionPolicy;
  allowedDirectories?: string[];
  prefetch: (latestUserText: string) => Promise<string | null>;
  summarizeToolBatch: ((prompt: string) => Promise<string | null>) | undefined;
  /** M5: optional fast-model factory (resolved per turn; null = use main). */
  fastModelFactory?: () => import("./auto-compact.js").FastModelOption | null;
  hooks: HookRegistry;
  mcpManager: MCPManager;
  state: SessionState;
  askUser: AskUserFn;
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>;
  readInput: () => Promise<string | null>;
  closeInput: () => void;
  /** Scheduler delivery: inject a synthetic user line (idle REPL only). */
  injectInput: (line: string) => void;
  /** M41 race guard: a pending permission/question prompt counts as busy. */
  getPendingPromptCount: () => number;
  makeCommandContext: () => CommandContext;
  isInteractive: boolean;
  quiet: boolean;
  showTokens: boolean;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  const {
    messages,
    tools,
    callModel,
    modelConfig,
    buildTurnSystemPrompt,
    getWorkspaceRoot,
    permissionModeState,
    permissionClassifier,
    permissionPolicy,
    allowedDirectories,
    prefetch,
    summarizeToolBatch,
    fastModelFactory,
    hooks,
    mcpManager,
    askUser,
    askUserQuestion,
    readInput,
    closeInput,
    injectInput,
    getPendingPromptCount,
    makeCommandContext,
    isInteractive,
    quiet,
    showTokens,
  } = deps;
  const { persistence, session, recordTranscript, stats: sessionStats, telemetry } = deps.state;

  // Best-effort mid-turn session save. Every floating (non-awaited) save MUST
  // go through this: an uncaught rejection here reaches the process-level
  // unhandledRejection handler, which tears the whole REPL down (review
  // follow-up H1 — the cross-process session lock added a new, realistic
  // rejection source: ELOCKED while another terminal holds the file).
  const floatingSave = (opts?: {
    taskState?: import("./session-memory.js").TaskState;
    lastTerminalReason?: string;
  }): void => {
    persistence.save(session.id, messages, opts).catch((err) => {
      console.error("Warning: session auto-save failed:", formatCliError(err));
    });
  };

  if (isInteractive && !quiet) {
    renderWelcome({
      version: "1.0.0",
      model: modelConfig.model,
      provider: modelConfig.provider,
      workspaceRoot: getWorkspaceRoot(),
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
      stopScheduler();
    } catch {
      /* scheduler already stopped */
    }
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
      await persistence.save(session.id, messages, { taskState: "stopped_by_user" });
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

  // M41: the scheduler loop — fires due cron jobs / sleeps / wakeups as
  // synthetic user input while the REPL is idle, and surfaces background
  // completions to the user. Deliveries deferred mid-turn are parked inside
  // the scheduler and delivered at the busy→idle flip.
  const stopScheduler = startScheduler({
    sessionId: () => session.id,
    workspaceRoot: getWorkspaceRoot,
    isBusy: () => turnInProgress || getPendingPromptCount() > 0,
    deliver: (prompt) => injectInput(prompt),
    displayNotifications: (items) => {
      for (const item of items) console.log(chalk.dim(`  ⎿ ${formatNotificationLine(item)}`));
    },
    displayParked: (p) => console.log(chalk.dim(`  ⏰ ${p.label} —— 当前回合结束后送达`)),
  });

  try {
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
      const { attachments, notes } = expandFileRefs(userInput, getWorkspaceRoot());
      for (const note of notes) console.log(chalk.gray(note));

      // M41: background completions that arrived while the REPL was idle ride
      // along with the new user message — the model sees them without having
      // polled, and they don't start a turn on their own.
      const pendingNotes = drainNotifications(session.id);
      const contentText = [pendingNotes.join("\n\n"), userInput, ...attachments]
        .filter(Boolean)
        .join("\n\n");

      // Add user message. P0-3: tagged checkpoint turn boundary so the
      // line-based path's /rewind restores files exactly like the TUI's.
      const userMsg: Message = {
        role: "user",
        content: [{ type: "text", text: contentText }],
      };
      beginUserTurn(session.id, userMsg);
      messages.push(userMsg);
      recordTranscript({ type: "user_prompt", text: contentText });

      // Per-turn abort handling: first Ctrl+C aborts the current turn and
      // returns to the prompt; a second (at the idle prompt) exits.
      const controller = new AbortController();
      const onSigint = () => {
        controller.abort("User interrupted");
      };
      process.on("SIGINT", onSigint);
      // Pre-turn save of the just-pushed user message. Best-effort like every
      // other mid-loop save (saveChain keeps ordering; a failure must not kill
      // the turn or the REPL — review follow-up H1).
      floatingSave({ taskState: "waiting_for_model" });

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
      await hooks
        .runEvent("UserPromptSubmit", { prompt: userInput, session_id: session.id })
        .catch(() => {});
      const turnSystemPrompt = buildTurnSystemPrompt();
      const loop = agentLoop(messages, tools, callModel, modelConfig, {
        systemPrompt: turnSystemPrompt,
        maxTurns: resolveMaxTurns(),
        toolContext: {
          workspaceRoot: getWorkspaceRoot(),
          sessionId: session.id,
          permissionMode: permissionModeState.get(),
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
          permissionPolicy,
          allowedDirectories,
          hooks,
        },
        askUser: askUserGuarded,
        abortSignal: controller.signal,
        hooks,
        // 12.2: opt-in speculative prefetch of likely follow-up Reads.
        // M15.2: ON by default; --no-speculation / CCR_SPECULATION=0 disable.
        speculation:
          !process.argv.includes("--no-speculation") && process.env.CCR_SPECULATION !== "0",
        // M36: background memory/skill prefetch + (opt-in) tool-batch digest.
        prefetch,
        summarizeToolBatch,
        fastModel: fastModelFactory?.() ?? undefined,
        // M41: mid-turn background completions are injected at the
        // tool_results boundary (budget-free) and gate end_turn continuations.
        drainNotifications: () => drainNotifications(session.id),
      });

      let turnInputTokens = 0;
      let turnOutputTokens = 0;
      let streamedChars = 0;
      let thinkingStart = 0;
      let thoughtReported = false;
      let thinkingStreamed = false;
      // P2-1: Track idle time for long response warning
      let lastActivityTime = Date.now();
      let idleWarningShown = false;

      // Helper to reset idle tracking
      const resetIdleTimer = () => {
        lastActivityTime = Date.now();
        idleWarningShown = false;
      };

      // One-line "⏱ 推理耗时 Ns" report, fired at the first sign of reasoning
      // (thinking delta) or answer text — whichever arrives first.
      const reportThought = () => {
        if (thoughtReported || thinkingStart <= 0) return;
        const secs = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
        spinner.stop();
        // P1-3: Enhanced thinking report with context
        const contextTip =
          secs > 30
            ? chalk.gray(" (模型正在推理复杂任务)")
            : secs > 10
              ? chalk.gray(" (等待模型响应)")
              : "";
        console.log(chalk.dim(`  ⏱ 推理耗时 ${secs}s${contextTip}`));
        thoughtReported = true;
      };

      for await (const event of loop) {
        switch (event.type) {
          case "thinking":
            floatingSave({ taskState: "waiting_for_model" });
            thinkingStart = Date.now();
            thoughtReported = false;
            thinkingStreamed = false;
            resetIdleTimer();
            spinner.setMode("thinking");
            spinner.start();
            break;

          case "thinking_delta": {
            // Live reasoning content (Anthropic extended thinking). Raw prose —
            // bypass the markdown renderer and stream inline, dimmed. The
            // "⏱ 推理耗时 Ns" report is deferred to the END of the thinking
            // segment (first text/tool/done) so the seconds reflect the full
            // reasoning duration, not the time to the first delta.
            resetIdleTimer();
            spinner.stop();
            if (!thinkingStreamed) {
              thinkingStreamed = true;
              process.stdout.write(chalk.dim("  💭 "));
            }
            process.stdout.write(chalk.dim(event.delta));
            break;
          }

          case "text_delta": {
            // Terminate the dimmed thinking line BEFORE printing the "Thought
            // for Ns" report — otherwise the report glues onto the thinking
            // text tail mid-line.
            if (thinkingStreamed) {
              process.stdout.write("\n");
              thinkingStreamed = false;
            }
            // First visible text ends the "thinking" phase: print the
            // "Thought for Ns" line, then switch the spinner to responding.
            reportThought();
            spinner.stop();
            renderer.write(event.delta);
            streamedChars += event.delta.length;
            spinner.update({ tokens: Math.round(streamedChars / 4) });
            // P2-1: Check for long idle (model streaming slowly)
            const idleMs = Date.now() - lastActivityTime;
            if (idleMs > 45000 && !idleWarningShown) {
              idleWarningShown = true;
              console.log(chalk.cyan("\n  💡 模型响应时间较长，请稍候..."));
            }
            break;
          }

          case "tool_use": {
            floatingSave({ taskState: "waiting_for_tool" });
            resetIdleTimer();
            spinner.stop();
            if (thinkingStreamed) {
              // Thinking → tool call with no intervening text: terminate the
              // dimmed line before the tool card renders.
              process.stdout.write("\n");
              thinkingStreamed = false;
            }
            // A thinking-only prefix (no text before this tool call) still
            // gets its duration report, now that thinking has ended.
            reportThought();
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
            persistence.save(session.id, messages).catch((err) => {
              console.error("Warning: auto-save after tool calls failed:", formatCliError(err));
            });
            spinner.start();
            break;
          }

          case "compacting":
            floatingSave({ taskState: "recovering" });
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
            floatingSave({ taskState: "failed" });
            spinner.stop();
            renderer.flush();
            recordTranscript({ type: "error", message: formatCliError(event.error) });
            console.error(`\n  ${chalk.red("⎿")} ${formatCliError(event.error)}`);
            break;

          case "done":
            spinner.stop();
            if (thinkingStreamed) {
              // Thinking-only turn (no text, no tool call): terminate the
              // dimmed line and emit the deferred duration report.
              process.stdout.write("\n");
              thinkingStreamed = false;
              reportThought();
            }
            renderer.flush();
            if (showTokens && (turnInputTokens || turnOutputTokens)) {
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
              .save(session.id, messages, {
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
            floatingSave({
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
    await hooks
      .runEvent("SessionEnd", { session_id: session.id, workspace_root: getWorkspaceRoot() })
      .catch(() => {});
    // Normal exit (EOF / "exit" / /exit) AND a loop-breaking error both land
    // here — the session is saved and long-lived children (MCP stdio servers,
    // tsserver, REPL sessions) are torn down either way.
    await cleanup();
  }
}
