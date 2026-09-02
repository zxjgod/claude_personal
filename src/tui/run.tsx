// ============================================================
// TUI runner — Ink render + REPL orchestration (9.1, 9.6)
// ============================================================
// The TTY counterpart to cli.ts's line-based while-loop. Owns the TuiStore,
// renders <App>, and drives one async-generator agent loop per submitted
// prompt, translating LoopEvents into store mutations. Slash commands run
// here too; their console.log output is captured into a transcript log item
// so it doesn't corrupt the Ink frame.
// ============================================================

import { render, useApp, useInput } from "ink";
import { type RefObject, useCallback, useRef } from "react";
import { agentLoop } from "./../agent-loop.js";
import { formatCliError } from "./../cli-errors.js";
import type { CommandContext } from "./../commands.js";
import { handleSlashCommand } from "./../commands.js";
import { debugLogger } from "../debug-logger.js";
import {
  applyProfile,
  loadProviderProfiles,
  type ProviderProfile,
} from "./../provider-profiles.js";
import type { TaskState } from "../session-memory.js";
import { normalizeFinishReason } from "../session-memory.js";
import { formatSpeculationLine } from "./../speculation.js";
import { expandFileRefs } from "../tools/utils/file-refs.js";
import type {
  AskUserFn,
  HookRunner,
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
  Tool,
  UserQuestion,
} from "./../types.js";
import { App } from "./App.js";
import { printBanner, renderBannerLines } from "./banner.js";
import { EFFORT_DESCRIPTIONS, getEffort } from "./effort.js";
import { completeFiles as completeFilesInRoot } from "./file-completions.js";
import { messagesToTranscript } from "./history-replay.js";
import type { CommandInfo } from "./InputBox.js";
import { InputQueue } from "./input-queue.js";
import { createResolver, DEFAULT_BINDINGS, loadUserBindings } from "./keybindings/index.js";
import { lookupContextWindow } from "./session-stats.js";
import { type ProviderPickerItem, type SessionPickerItem, TuiStore } from "./store.js";
import { StreamBuffer } from "./stream-buffer.js";
import { isToolExpandable } from "./ToolCard.js";
import { truncateVisual } from "./terminal-width.js";

// Debug monitoring - enabled via DEBUG_STREAM env var
const DEBUG_STREAM = process.env.DEBUG_STREAM;

// Global-hotkey resolver for the runner-owned hotkeys (tool:expandLast):
// defaults + user overrides from ~/.claude/keybindings.json. App.tsx keeps
// its own instance for its hotkeys; both read the same sources.
const globalResolver = createResolver(DEFAULT_BINDINGS, loadUserBindings());

export interface TuiDeps {
  messages: Message[];
  tools: Tool[];
  callModel: ModelCaller;
  modelConfig: ModelConfig;
  systemPrompt: string;
  workspaceRoot: string;
  /** Live workspace-root reader (for /cd). Falls back to `workspaceRoot` when absent. */
  getWorkspaceRoot?: () => string;
  sessionId: string;
  permissionMode: PermissionMode;
  commands: CommandInfo[];
  hooks?: HookRunner;
  makeCommandContext: () => CommandContext;
  alwaysAllow: Set<string>;
  permissionKey: (toolName: string, input: Record<string, unknown>) => string;
  /** M15.3: optional LLM permission classifier (opt-in via CLI flag). */
  permissionClassifier?: PermissionClassifier;
  /** M36: background memory/skill prefetch (returns a <system-reminder> or null). */
  prefetch?: (latestUserText: string) => Promise<string | null>;
  /** M36: opt-in tool-batch digest (undefined = disabled). */
  summarizeToolBatch?: (prompt: string) => Promise<string | null>;
  /** M25.2: opt-in full-screen alt-screen layout (default off). */
  fullscreen?: boolean;
  onSave: (taskState?: TaskState, lastTerminalReason?: string) => void;
}

/** Run one user turn through the agent loop, pushing events into the store. */
async function runTurn(
  store: TuiStore,
  deps: TuiDeps,
  controller: AbortController,
  askUser: AskUserFn,
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>,
  queue: InputQueue,
): Promise<void> {
  // Initialize debug monitoring if enabled via DEBUG_STREAM env var
  if (DEBUG_STREAM && DEBUG_STREAM !== "off") {
    debugLogger.enable(DEBUG_STREAM);
    debugLogger.info("tui", "TUI debug mode enabled", { env: DEBUG_STREAM });
  }

  store.setBusy(true);
  store.setSpinner("thinking");
  store.startTurnClock();

  // Each tool lands the instant it finishes — no artificial display delay. The
  // UI shows tools as they complete, which is the natural behaviour users expect.
  // Previously a MIN_TOOL_DISPLAY_MS delay made abort responsiveness lag by up to
  // 800ms × N tools; removing it also makes single-tool turns feel snappier.

  // M18.12: append the session goal (if set) to this turn's system prompt.
  const goal = deps.makeCommandContext().goal?.value;
  const turnSystemPrompt = goal
    ? `${deps.systemPrompt}\n\n[SESSION GOAL]\nThe user set this objective for the session. Keep it in view and steer toward it:\n${goal}`
    : deps.systemPrompt;
  const loop = agentLoop(deps.messages, deps.tools, deps.callModel, deps.modelConfig, {
    systemPrompt: turnSystemPrompt,
    toolContext: {
      workspaceRoot: deps.getWorkspaceRoot?.() ?? deps.workspaceRoot,
      sessionId: deps.sessionId,
      permissionMode: store.getPermissionMode(),
      getPermissionMode: () => store.getPermissionMode(),
      setPermissionMode: (mode) => store.setPermissionMode(mode),
      modelConfig: deps.modelConfig,
      askUserQuestion,
      // M15.3: thread the LLM permission classifier (when enabled) so flagged
      // dangerous calls get a model-assessed risk hint/block in the TUI too.
      permissionClassifier: deps.permissionClassifier,
      // Stream nested sub-agent (Task) activity into the transcript live, so
      // its Reads/Greps appear as they happen rather than dumping in a block
      // when the Task finishes.
      onSubAgentProgress: (ev) => {
        if (ev.phase === "tool_use") {
          const d = toolDetail(ev.input);
          store.addSubAgentActivity(
            `    ⎿ [${ev.subagentName}] ${capitalize(ev.toolName ?? "tool")}${d ? `(${truncate(d, 80)})` : ""}`,
          );
        } else if (ev.phase === "done") {
          store.addSubAgentActivity(`    ⎿ [${ev.subagentName}] done`);
        }
      },
    },
    askUser,
    abortSignal: controller.signal,
    hooks: deps.hooks,
    // M36: background memory/skill prefetch + (opt-in) tool-batch digest.
    prefetch: deps.prefetch,
    summarizeToolBatch: deps.summarizeToolBatch,
    // M36: type-ahead. The loop drains queued input at each turn boundary and
    // continues the SAME turn with it (kernel §9), so a message typed while the
    // agent works is picked up without waiting for the turn to end. The TUI
    // echoes the queued line at push time (see Root.onSubmit); here the loop
    // injects it into `messages` so the model actually sees it. The drain also
    // re-syncs the status bar's "queued N" badge.
    drainQueuedInput: () => {
      const drained = queue.drain();
      store.setQueuedInputs(queue.size);
      return drained;
    },
  });

  let thinkingStart = Date.now();
  let thoughtReported = false;
  // Settle the "Thought for Ns" marker when the thinking phase ENDS (first
  // text delta / tool call / turn end), so the seconds reflect the FULL
  // reasoning duration — reporting at the first thinking_delta (which arrives
  // early in the stream) would systematically under-count. For providers
  // without thinking content this still fires on the first text delta,
  // measuring time-to-first-token as before.
  const settleThinking = () => {
    if (!thoughtReported && thinkingStart > 0) {
      const secs = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
      store.addThought(secs);
      thoughtReported = true;
    }
    store.commitThinking();
  };
  // Real output tokens reconciled with a live estimate: each model call ends
  // with a `usage` event carrying the true output_tokens, which we accumulate
  // into `committedOutputTokens`. Between usage events we show that committed
  // total plus a char/4 estimate of the in-flight stream, so the counter rises
  // live and then snaps to the exact value when usage lands.
  let committedOutputTokens = 0;
  let streamedCharsThisCall = 0;
  const liveTokens = () => committedOutputTokens + Math.round(streamedCharsThisCall / 4);
  // Coalesce high-frequency text deltas: buffer them and flush text + token
  // estimate together at ~30fps (one store emit per frame, not per token).
  const streamBuffer = new StreamBuffer((text) => {
    store.appendStreamingWithTokens(text, liveTokens());
  });
  // Map tool-call id → its display detail, so the result card keeps the input
  // (filePath/command/…) the start card showed.
  const toolDetails = new Map<string, string>();

  try {
    for await (const event of loop) {
      switch (event.type) {
        case "thinking":
          deps.onSave("waiting_for_model");
          thinkingStart = Date.now();
          thoughtReported = false;
          store.setSpinner("thinking");
          break;
        case "thinking_delta":
          // Live reasoning content: dims in the live region, commits to the
          // transcript when text/tool events arrive or the turn ends. The
          // duration marker is deferred to settleThinking (commit time).
          store.appendThinking(event.delta);
          break;
        case "text_delta":
          settleThinking();
          store.setSpinner("responding");
          streamedCharsThisCall += event.delta.length;
          streamBuffer.push(event.delta);
          // Log delta for debugging
          debugLogger.logDelta(event.delta, streamedCharsThisCall);
          break;
        case "tool_use": {
          deps.onSave("waiting_for_tool");
          streamBuffer.flush();
          settleThinking();
          store.commitStreaming();
          const detail = toolDetail(event.input);
          toolDetails.set(event.id, detail);
          store.startTool(event.name, detail, event.id);
          store.setSpinner("tool");
          break;
        }
        case "tool_result": {
          store.finishTool(event.result, toolDetails.get(event.id) ?? "", event.id);
          // Todo tool → live region: the pinned list is a projection of the
          // tool's session state, delivered on every call via metadata.todos.
          const todos = event.result.result?.metadata?.todos;
          if (event.result.toolName === "todo" && Array.isArray(todos)) {
            store.setTodos(todos);
          }
          break;
        }
        case "tool_results":
          // Batch boundary: every tool in this turn is done. Persist now.
          deps.onSave("waiting_for_model");
          break;
        case "usage":
          store.addUsage(
            event.usage.input_tokens,
            event.usage.output_tokens,
            {
              read: event.usage.cache_read_input_tokens,
              creation: event.usage.cache_creation_input_tokens,
            },
            estimateContextUsed(event.usage, deps.modelConfig.provider),
          );
          // Reconcile the live estimate to the real output-token count.
          committedOutputTokens += event.usage.output_tokens;
          streamedCharsThisCall = 0;
          store.setSpinnerTokens(committedOutputTokens);
          break;
        case "compacting":
          deps.onSave("recovering");
          store.addNotice("Compacting context…");
          break;
        case "error":
          deps.onSave("failed");
          streamBuffer.flush();
          settleThinking();
          store.commitStreaming();
          store.addNotice(`⎿ ${formatCliError(event.error)}`);
          break;
        case "aborted":
          deps.onSave("stopped_by_user", "aborted_by_user");
          streamBuffer.flush();
          settleThinking();
          store.commitStreaming();
          store.addNotice(`⎿ Aborted: ${event.reason}`);
          break;
        case "done":
          streamBuffer.flush();
          settleThinking();
          store.commitStreaming();
          // Log commit for debugging
          debugLogger.logCommit(store.getSnapshot().streamingText, streamedCharsThisCall);
          // M15.2: surface speculation cost/benefit (only if prefetched anything).
          if (event.speculation) {
            const line = formatSpeculationLine(event.speculation);
            if (line) store.addNotice(line);
          }
          deps.onSave("paused", normalizeFinishReason(event.finishReason));
          break;
      }
    }
  } finally {
    streamBuffer.stop();
    store.setSpinner("idle");
    store.setSpinnerTokens(0);
    store.stopTurnClock();
    store.setBusy(false);
    // Drain any frame-coalesced notify so the idle state (spinner cleared,
    // input re-enabled) paints immediately rather than waiting on a trailing
    // frame after the turn ends.
    store.flush();
    // Log turn summary
    debugLogger.info("tui", "Turn ended", {
      streamedChars: streamedCharsThisCall,
      committedOutputTokens,
    });
  }
}

function toolDetail(input?: Record<string, unknown>): string {
  if (!input) return "";
  for (const k of ["command", "filePath", "pattern", "url", "query"]) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Tokens occupying the context window after one model call — the estimate the
 * status-bar gauge plots. The two adapter families report input differently:
 * Anthropic's input_tokens EXCLUDES cache read/creation (sum all three),
 * OpenAI's prompt_tokens already INCLUDES cached tokens (summing again would
 * double-count). Mirrors the accounting note in session-stats.ts.
 */
function estimateContextUsed(
  u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
  provider: string,
): number {
  const base = u.input_tokens + u.output_tokens;
  if (provider === "anthropic") {
    return base + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return base;
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function truncate(value: string, max: number): string {
  // P3-15: column-aware truncation (see truncateVisual).
  return truncateVisual(value, max);
}

/** Capture console.log output produced while `fn` runs, returning the lines. */
async function captureConsole<T>(
  fn: () => Promise<T> | T,
): Promise<{ lines: string[]; result: T }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  let result: T;
  try {
    result = await fn();
  } finally {
    console.log = orig;
  }
  return { lines, result };
}

/**
 * Drive the interactive /resume flow: list saved sessions, let the user pick
 * one from the scrollable overlay, then restore it. Restoration mutates the
 * live `messages` array in place (via the shared CommandContext.resumeSession)
 * and replays the prior conversation into the transcript — all without an LLM
 * call, so it costs zero tokens. The picked session also becomes the save
 * target for subsequent turns (resumeSession updates the REPL's sessionId).
 */
async function runResumePicker(store: TuiStore, deps: TuiDeps): Promise<void> {
  const ctx = deps.makeCommandContext();
  const persistence = ctx.persistence;
  if (!persistence || !ctx.resumeSession) {
    store.addNotice("  Session persistence is not available.");
    return;
  }

  const metas = await persistence.searchSessions("");
  if (metas.length === 0) {
    store.addNotice("  No saved sessions to resume.");
    return;
  }

  // Cap the picker so a huge history dir can't trigger hundreds of file reads
  // (metas are already sorted pinned-first, most-recent-first).
  const MAX_SHOWN = 50;
  const shown = metas.slice(0, MAX_SHOWN);

  const items: SessionPickerItem[] = [];
  for (const meta of shown) {
    const when = new Date(meta.updatedAt).toLocaleString();
    const plural = meta.messageCount === 1 ? "msg" : "msgs";
    items.push({
      sessionId: meta.sessionId,
      label: `${meta.pinned ? "📌 " : ""}${meta.sessionId.slice(0, 8)} · ${meta.messageCount} ${plural} · ${when} · ${meta.completed ? "done" : "open"}`,
      preview: meta.preview || undefined,
      current: meta.sessionId === ctx.sessionId,
    });
  }

  const chosen = await store.pickSession(items);
  if (!chosen) {
    store.addNotice("  Resume cancelled.");
    return;
  }

  // Restore. resumeSession console.logs a one-liner; capture it so it doesn't
  // corrupt the Ink frame, then surface our own notice instead.
  const { result: ok } = await captureConsole(() => ctx.resumeSession!(chosen));
  if (!ok) {
    store.addNotice(`  Could not resume session ${chosen.slice(0, 8)}.`);
    return;
  }

  // `messages` was mutated in place by resumeSession — replay it on screen so
  // the restored conversation is visible and scrollable.
  const transcript = messagesToTranscript(deps.messages);
  store.addNotice(
    `  ── Resumed ${chosen.slice(0, 8)} · ${deps.messages.length} messages restored (0 tokens) ──`,
  );
  store.loadTranscript(transcript);
}

/**
 * Drive the interactive /provider flow: list saved API endpoint profiles from
 * .claude/providers.json, let the user pick one from the overlay, then swap the
 * live ModelConfig in place. No LLM call — the next turn uses the new endpoint.
 */
async function runProviderPicker(store: TuiStore, deps: TuiDeps): Promise<void> {
  const profiles = loadProviderProfiles(deps.workspaceRoot);
  if (profiles.length === 0) {
    store.addNotice("  No provider profiles. Create .claude/providers.json to use /provider.");
    return;
  }

  const cfg = deps.modelConfig;
  const items: ProviderPickerItem[] = profiles.map((p: ProviderProfile) => ({
    name: p.name,
    label: `${p.provider ?? "openai"}/${p.model ?? "default"}`,
    detail: p.baseURL,
    current: (p.provider ?? "openai") === cfg.provider && (!p.model || p.model === cfg.model),
  }));

  const chosen = await store.pickProvider(items);
  if (!chosen) {
    store.addNotice("  Provider switch cancelled.");
    return;
  }
  const profile = profiles.find((p) => p.name === chosen);
  if (!profile) return;

  const prev = `${cfg.provider}/${cfg.model}`;
  applyProfile(cfg, profile);
  store.setModel(cfg.model, `${cfg.provider}/${cfg.model}`);
  // The new model may have a different context window (and price) — the gauge
  // must resize with it or it would plot the next model's usage against the
  // previous model's limit.
  store.setContextLimit(lookupContextWindow(cfg.model) ?? 0);
  store.addNotice(`  Provider: ${prev} → ${cfg.provider}/${cfg.model} (${profile.name})`);
}

/**
 * Drive the interactive /help command palette: list every registered slash
 * command in a scrollable, arrow-navigable overlay. Resolves with the chosen
 * command name (without the slash) or null on cancel. The caller dispatches the
 * chosen command through the normal path — this only picks.
 */
async function runCommandPicker(store: TuiStore, deps: TuiDeps): Promise<string | null> {
  const items = deps.commands.map((c) => ({ name: c.name, description: c.description }));
  if (items.length === 0) {
    store.addNotice("  No commands available.");
    return null;
  }
  return store.pickCommand(items);
}

/**
 * Root that wires the InputBox submit handler to slash-command dispatch and
 * the agent loop, and installs a process-level SIGINT handler that aborts the
 * current turn (9.6) without tearing down the session.
 */
function Root({ store, deps }: { store: TuiStore; deps: TuiDeps }) {
  // M36: one type-ahead queue per session. Stable across renders so a message
  // typed while the agent is busy survives until the loop drains it.
  const queueRef = useRef<InputQueue>(new InputQueue());
  // The AbortController of the in-flight turn, so the Ctrl+C hotkey can
  // interrupt it. Ink keeps stdin in raw mode, so Ctrl+C never raises SIGINT —
  // the process-level handler below only covers non-TUI fallbacks.
  const turnControllerRef = useRef<AbortController | null>(null);

  const askUser: AskUserFn = useCallback(
    async (tool, input, riskHint) => {
      const key = deps.permissionKey(tool.name, input);
      if (deps.alwaysAllow.has(key)) return true;
      const detail = toolDetail(input);
      const choice = await store.askPermission(
        `${tool.name[0]!.toUpperCase()}${tool.name.slice(1)} request`,
        detail || undefined,
        riskHint,
      );
      if (choice === "always") {
        deps.alwaysAllow.add(key);
        return true;
      }
      return choice === "yes";
    },
    [store, deps],
  );

  const askUserQuestion = useCallback(
    (q: UserQuestion) => store.askQuestion(q.header, q.question, q.options, q.multiSelect === true),
    [store],
  );

  // P2-10: "@" path completion against the live workspace root (TTL-cached
  // listing — see file-completions.ts). /cd changes the root, so read it per
  // query rather than capturing the startup value.
  const completeFiles = useCallback(
    (query: string) => completeFilesInRoot(deps.getWorkspaceRoot?.() ?? deps.workspaceRoot, query),
    [deps],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      if (value.toLowerCase() === "exit" || value.toLowerCase() === "/exit") {
        // Tear down resources before exiting. Previously this was a bare
        // process.exit(0) that skipped onSave (session lost), MCP disconnect,
        // and LSP dispose. onSave() flushes the session; Ink unmounts on exit.
        try {
          deps.onSave();
        } catch {
          /* best-effort: don't block exit on a save failure */
        }
        // Give the (synchronous) save a tick to flush, then exit. The CLI's
        // top-level signal/cleanup handlers cover MCP/LSP teardown for the
        // process, but a prompt exit here avoids orphaned stdio children.
        setTimeout(() => process.exit(0), 50);
        return;
      }

      // M36 type-ahead: if the agent is busy, queue this message instead of
      // starting a competing turn. The running loop drains the queue at its
      // next turn boundary and continues with it (kernel §9). We echo the line
      // now so the user sees it captured; the loop injects it into `messages`
      // when it drains. Slash commands typed while busy are queued as plain
      // follow-up text (run them when idle for local handling).
      if (store.getSnapshot().busy) {
        store.addUserMessage(value);
        store.addNotice("  ⏎ queued — will run after the current turn");
        queueRef.current.push(value);
        store.setQueuedInputs(queueRef.current.size);
        return;
      }

      // Echo the user's input line once. For prompt-injecting slash commands
      // the echoed line is the command itself (e.g. "/review"); the injected
      // prompt is pushed only into `deps.messages`, not re-echoed.
      store.addUserMessage(value);

      void (async () => {
        // /help (or /commands) with no args → open the interactive command
        // palette overlay instead of dumping a static list. Selecting a command
        // dispatches it exactly as if the user had typed "/name"; Esc cancels.
        if (/^\/(help|commands)\s*$/i.test(value)) {
          const chosen = await runCommandPicker(store, deps);
          if (chosen) onSubmit("/" + chosen);
          return;
        }

        // /effort with no args → open the interactive slider overlay (TUI).
        // With an arg (e.g. /effort max) it falls through to the static handler.
        if (/^\/effort\s*$/i.test(value)) {
          deps.modelConfig.options ??= {};
          const options = deps.modelConfig.options;
          const chosen = await store.askEffort(getEffort(options));
          if (chosen) {
            options.effort = chosen;
            store.addNotice(
              `  Effort: ${chosen} — ${EFFORT_DESCRIPTIONS[chosen]} (applies to the next turn)`,
            );
          }
          return;
        }

        // /resume with no args → open the interactive session picker overlay.
        // With an arg (e.g. /resume a1b2) it falls through to the static handler
        // which resolves the prefix directly. Selecting a session replays its
        // history into the transcript and costs no tokens (no LLM call).
        if (/^\/resume\s*$/i.test(value)) {
          await runResumePicker(store, deps);
          return;
        }

        // /provider with no args → open the interactive endpoint-profile picker.
        // With an arg (e.g. /provider deepseek) it falls through to the static
        // handler which switches by name. Switching costs no tokens (no LLM call).
        if (/^\/provider\s*$/i.test(value)) {
          await runProviderPicker(store, deps);
          return;
        }

        // Slash commands run locally; capture their console output and read
        // the CommandResult in one dispatch (no double-execution). A command
        // may return `prompt` to inject a user message and run the loop
        // (/review /recap /fork /onboarding); otherwise it's fully local.
        let effectiveText: string | null = null;
        if (value.startsWith("/")) {
          const { lines, result } = await captureConsole(() => {
            const commandContext = deps.makeCommandContext();
            commandContext.permissionMode = store.getPermissionMode();
            commandContext.getPermissionMode = () => store.getPermissionMode();
            commandContext.setPermissionMode = (mode: string) => {
              store.setPermissionMode(mode as PermissionMode);
            };
            commandContext.input = {
              askConfirmation: (question: string) => store.askConfirmation(question),
            };
            return handleSlashCommand(value, commandContext);
          });
          if (lines.length > 0) store.addLog(lines);
          if (result.exit) return;
          if (result.handled && !result.prompt) {
            // /clear wiped the conversation (and the tool's todo state) — the
            // pinned todo projection in the live region must go too.
            if (/^\/clear\b/i.test(value)) store.setTodos([]);
            return; // purely local command
          }
          if (result.prompt) effectiveText = result.prompt;
        }

        // Determine the effective user text: either a prompt injected by a
        // slash command, or the raw input.
        const inputText = effectiveText ?? value;

        // Expand @file refs, then push the user message + run the loop.
        const { attachments, notes } = expandFileRefs(
          inputText,
          deps.getWorkspaceRoot?.() ?? deps.workspaceRoot,
        );
        for (const note of notes) store.addNotice(note);
        const contentText =
          attachments.length > 0 ? `${inputText}\n\n${attachments.join("\n\n")}` : inputText;
        deps.messages.push({ role: "user", content: [{ type: "text", text: contentText }] });

        const controller = new AbortController();
        turnControllerRef.current = controller;
        const onSigint = () => controller.abort("用户中断");
        process.on("SIGINT", onSigint);
        try {
          await runTurn(store, deps, controller, askUser, askUserQuestion, queueRef.current);
          // M36 race window: a message queued AFTER the loop's final drain (but
          // before busy flipped off) is still pending here. The loop already
          // ended, so drain it ourselves and run it as a follow-up turn. The
          // line was already echoed at queue time; just feed it to the model.
          // Defensive bound: every queued line costs a full LLM turn, so an
          // unbounded drain lets type-ahead (or scripted stdin) stack unlimited
          // back-to-back turns. 10 consecutive follow-ups is already
          // pathological; beyond that, drop with a notice rather than spin.
          const MAX_FOLLOWUP_TURNS = 10;
          let followUps = 0;
          while (queueRef.current.hasPending && followUps < MAX_FOLLOWUP_TURNS) {
            followUps++;
            for (const text of queueRef.current.drain()) {
              deps.messages.push({ role: "user", content: [{ type: "text", text }] });
            }
            store.setQueuedInputs(queueRef.current.size);
            await runTurn(store, deps, controller, askUser, askUserQuestion, queueRef.current);
          }
          if (queueRef.current.hasPending) {
            const dropped = queueRef.current.drain();
            store.setQueuedInputs(0);
            store.addNotice(
              `  ⎿ 连续排队回合已达上限（${MAX_FOLLOWUP_TURNS}），丢弃 ${dropped.length} 条排队输入`,
            );
          }
        } catch (err) {
          store.addNotice(`⎿ ${formatCliError(err)}`);
          store.setBusy(false);
        } finally {
          turnControllerRef.current = null;
          process.removeListener("SIGINT", onSigint);
        }
      })().catch((err) => {
        // Floating async IIFE — without this, an internal throw becomes an
        // unhandled rejection that crashes the process with no UI feedback.
        store.addNotice(`⎿ ${formatCliError(err)}`);
        store.setBusy(false);
      });
    },
    [store, deps, askUser, askUserQuestion],
  );

  return (
    <>
      <InterruptHotkey
        store={store}
        controllerRef={turnControllerRef}
        editorMode={deps.makeCommandContext().editorMode}
      />
      <ExpandHotkey store={store} />
      <App
        store={store}
        commands={deps.commands}
        onSubmit={onSubmit}
        editorMode={deps.makeCommandContext().editorMode}
        completeFiles={completeFiles}
        fullscreen={deps.fullscreen}
      />
    </>
  );
}

/**
 * Ctrl+R (remappable via keybindings.json → "tool:expandLast"): expand the
 * latest collapsed tool card. Ink's <Static> is write-once, so the collapsed
 * card in scrollback can't be re-rendered in place — store.expandTool appends
 * a full-output copy below it (idempotent per card). The "(ctrl+r to expand)"
 * hint on collapsed cards refers to THIS handler.
 */
function ExpandHotkey({ store }: { store: TuiStore }) {
  useInput((input, key) => {
    const result = globalResolver(input, key, ["Global"]);
    if (result.type !== "match" || result.action !== "tool:expandLast") return;
    // Overlays and the transcript pager own the keyboard while active.
    const s = store.getSnapshot();
    if (s.overlay || s.reviewing) return;
    const items = s.transcript;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.kind === "tool" && item.result && !item.expanded && isToolExpandable(item.result)) {
        store.expandTool(item.id);
        return;
      }
    }
  });
  return null;
}

/**
 * Ctrl+C / Esc in the TUI: interrupt the in-flight turn when busy; Ctrl+C
 * exits when idle. Esc-interrupt matches Claude Code's muscle memory (Esc
 * while streaming stops the turn). Guards:
 *   • overlays own their input (their Esc cancels the overlay itself);
 *   • the transcript pager owns the keyboard while reviewing;
 *   • vim editor mode keeps Esc for normal-mode — vim users still have
 *     Ctrl+C (Esc-to-normal is too frequent a key to hijack mid-edit).
 * Ink runs stdin in raw mode, so Ctrl+C arrives as a keypress (not SIGINT) —
 * with exitOnCtrlC disabled at the render() call sites, THIS is the only
 * Ctrl+C behavior.
 */
export function InterruptHotkey({
  store,
  controllerRef,
  editorMode,
}: {
  store: TuiStore;
  controllerRef: RefObject<AbortController | null>;
  editorMode?: { value: "default" | "vim" };
}) {
  const { exit } = useApp();
  useInput((input, key) => {
    const isCtrlC = key.ctrl && input === "c";
    const isEsc = key.escape === true;
    if (!isCtrlC && !isEsc) return;
    if (store.getSnapshot().overlay || store.getSnapshot().reviewing) return;
    if (isEsc && editorMode?.value === "vim") return;
    const controller = controllerRef.current;
    if (controller && store.getSnapshot().busy) {
      controller.abort("用户中断");
    } else if (isCtrlC) {
      exit();
    }
    // Esc while idle: intentionally nothing — too easy to lose the session.
  });
  return null;
}

/** Launch the Ink TUI. Resolves when the user exits. */
export function runTui(deps: TuiDeps): Promise<void> {
  // M25.2: in full-screen mode we switch to the alternate screen buffer (DEC
  // 1049) so the layout owns the whole viewport and the main-screen scrollback
  // is left untouched on exit. CRITICAL: every exit path must restore the main
  // screen — a leaked alt-screen leaves the user's terminal blank. We install a
  // restore on Ink unmount AND on process exit/signals, and guard against double
  // restore. (See archive/终端界面bug修复-20260626.md for the history that makes
  // this opt-in and carefully torn down.)
  const ENTER_ALT = "\x1B[?1049h\x1B[2J\x1B[H";
  const EXIT_ALT = "\x1B[?1049l";
  let altRestored = false;
  const restoreScreen = () => {
    if (altRestored) return;
    altRestored = true;
    if (deps.fullscreen) process.stdout.write(EXIT_ALT);
  };
  if (deps.fullscreen) {
    process.stdout.write(ENTER_ALT);
    // Belt-and-suspenders: restore on any abrupt exit so the terminal isn't
    // left on the alternate screen.
    process.once("exit", restoreScreen);
    process.once("SIGTERM", restoreScreen);
  }

  // In full-screen mode the layout is the whole viewport (the banner becomes the
  // first scroll line); in the default mode we print the banner into scrollback
  // above Ink's live region as before.
  if (deps.fullscreen) {
    const store = new TuiStore(`${deps.modelConfig.provider}/${deps.modelConfig.model}`, {
      batching: true,
      permissionMode: deps.permissionMode,
      modelId: deps.modelConfig.model,
    });
    store.setContextLimit(lookupContextWindow(deps.modelConfig.model) ?? 0);
    store.loadTranscript(
      renderBannerLines({
        version: "1.0.0",
        model: deps.modelConfig.model,
        provider: deps.modelConfig.provider,
        workspaceRoot: deps.workspaceRoot,
      }).map((line) => ({ kind: "log", lines: [line] })),
    );
    const { waitUntilExit } = render(<Root store={store} deps={deps} />, {
      // Ctrl+C is handled by Root's InterruptHotkey (interrupt turn / exit when
      // idle) — Ink's default would hard-exit the process mid-turn.
      exitOnCtrlC: false,
      // Enable mouse input for scrolling support
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    return (waitUntilExit() as Promise<void>).finally(restoreScreen);
  }

  // Print the startup banner once into scrollback (above Ink's live region).
  printBanner({
    version: "1.0.0",
    model: deps.modelConfig.model,
    provider: deps.modelConfig.provider,
    workspaceRoot: deps.workspaceRoot,
  });
  const store = new TuiStore(`${deps.modelConfig.provider}/${deps.modelConfig.model}`, {
    // Coalesce the high-frequency stream of store mutations (text deltas, token
    // ticks) into one notify per frame so a fast stream doesn't trigger a React
    // re-render per write. Tests construct the store without this (synchronous).
    batching: true,
    permissionMode: deps.permissionMode,
    modelId: deps.modelConfig.model,
  });
  // Context gauge: unknown models get 0 → gauge hidden rather than mis-sized.
  store.setContextLimit(lookupContextWindow(deps.modelConfig.model) ?? 0);
  const { waitUntilExit } = render(<Root store={store} deps={deps} />, {
    // See the fullscreen render above: Ctrl+C belongs to InterruptHotkey.
    exitOnCtrlC: false,
    // Enable mouse input for scrolling support
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  return waitUntilExit() as Promise<void>;
}
