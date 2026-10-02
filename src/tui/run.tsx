// ============================================================
// TUI runner — Ink render + REPL orchestration (9.1, 9.6)
// ============================================================
// The TTY counterpart to cli.ts's line-based while-loop. Owns the TuiStore,
// renders <App>, and drives one async-generator agent loop per submitted
// prompt, translating LoopEvents into store mutations. Slash commands run
// here too; their console.log output is captured into a transcript log item
// so it doesn't corrupt the Ink frame.
// ============================================================

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { render, useApp, useInput } from "ink";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { agentLoop } from "./../agent-loop.js";
import {
  beginUserTurn,
  changedFiles,
  listTurns,
  restoreToTurn,
  turnOfMessage,
} from "./../checkpoint.js";
import { formatCliError } from "./../cli-errors.js";
import type { CommandContext } from "./../commands.js";
import { handleSlashCommand } from "./../commands.js";
import { debugLogger } from "../debug-logger.js";
import type { ElicitationRequest, ElicitationResult } from "../mcp/index.js";
import {
  applyProfile,
  loadProviderProfiles,
  type ProviderProfile,
} from "./../provider-profiles.js";
import type { TaskState } from "../session-memory.js";
import { normalizeFinishReason } from "../session-memory.js";
import { formatSpeculationLine } from "./../speculation.js";
import { estimateContextUsed } from "../token-estimator.js";
import { startScheduler } from "../tools/extended/scheduler.js";
import { drainNotifications, formatNotificationLine } from "../tools/notifications.js";
import { expandFileRefs } from "../tools/utils/file-refs.js";
import type {
  AskUserFn,
  ContentBlock,
  HookRunner,
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
  Tool,
  UserQuestion,
} from "./../types.js";
import { APP_VERSION } from "../version.js";
import { App } from "./App.js";
import { printBanner, renderBannerLines } from "./banner.js";
import { readClipboardImageBase64 } from "./clipboard-image.js";
import { EFFORT_DESCRIPTIONS, getEffort } from "./effort.js";
import { completeFiles as completeFilesInRoot } from "./file-completions.js";
import { messagesToTranscript } from "./history-replay.js";
import type { CommandInfo } from "./InputBox.js";
import { t } from "./i18n.js";
import { appendHistory, loadHistory } from "./input-history.js";
import { InputQueue } from "./input-queue.js";
import { runModelPicker } from "./model-picker-flow.js";
import { expandPastedChips, makePasteChip } from "./paste-chip.js";
import { permissionPresentation } from "./permission-presentation.js";
import { lookupContextWindow } from "./session-stats.js";
import {
  EXIT_DOUBLE_PRESS_MS,
  type ProviderPickerItem,
  type RewindEntry,
  type SessionPickerItem,
  TuiStore,
} from "./store.js";
import { StreamBuffer } from "./stream-buffer.js";
import { truncateVisual } from "./terminal-width.js";
import { applyTheme } from "./theme.js";
import { buildPermissionDiff } from "./tool-output.js";
import { useStoreSelector } from "./useStoreSelector.js";

// Debug monitoring - enabled via DEBUG_STREAM env var
const DEBUG_STREAM = process.env.DEBUG_STREAM;

/**
 * The agent-loop wiring the TUI needs: model access, tool set, and the
 * per-turn prompt.
 */
export interface TuiAgentDeps {
  messages: Message[];
  tools: Tool[];
  callModel: ModelCaller;
  modelConfig: ModelConfig;
  systemPrompt: string;
  /**
   * Live per-turn system-prompt builder (Top10 follow-up B1). The startup
   * `systemPrompt` snapshot is FROZEN: MCP servers connecting mid-session,
   * /memory edits or git-status refreshes never reached the model in the TUI
   * path (the REPL rebuilds every turn). When provided, each turn rebuilds
   * through this — cheap, since buildSystemPrompt memoizes all static
   * sections including the tool-set fingerprint. Falls back to `systemPrompt`.
   */
  buildTurnSystemPrompt?: () => string;
  /** M5: optional fast-model factory (resolved per turn; null = use main). */
  fastModelFactory?: () => import("../auto-compact.js").FastModelOption | null;
  /** M36: background memory/skill prefetch (returns a <system-reminder> or null). */
  prefetch?: (latestUserText: string) => Promise<string | null>;
  /** M36: opt-in tool-batch digest (undefined = disabled). */
  summarizeToolBatch?: (prompt: string) => Promise<string | null>;
  /** Persist the turn's task state + terminal reason. */
  onSave: (taskState?: TaskState, lastTerminalReason?: string) => void;
}

/** Resolve one complete turn prompt. The live builder owns dynamic sections. */
export function resolveTurnSystemPrompt(
  deps: Pick<TuiAgentDeps, "systemPrompt" | "buildTurnSystemPrompt">,
  goal?: string,
): string {
  const prompt = deps.buildTurnSystemPrompt?.() ?? deps.systemPrompt;
  if (deps.buildTurnSystemPrompt || !goal) return prompt;
  return `${prompt}\n\n[SESSION GOAL]\nThe user set this objective for the session. Keep it in view and steer toward it:\n${goal}`;
}

/**
 * Session identity. `getSessionId` / `getWorkspaceRoot` are live readers
 * because /resume rewrites `session.id` in place and /cd moves the root —
 * a captured string goes stale and splits checkpoint buckets from /rewind's
 * (live) ctx.sessionId.
 */
export interface TuiSessionDeps {
  workspaceRoot: string;
  /** Live workspace-root reader (for /cd). Falls back to `workspaceRoot` when absent. */
  getWorkspaceRoot?: () => string;
  /**
   * Live session-id reader (P0-3 fix). /resume rewrites session.id in place;
   * the startup-captured `sessionId` string goes stale, which would split
   * checkpoint buckets from /rewind's (live) ctx.sessionId. Falls back to
   * `sessionId` when absent.
   */
  getSessionId?: () => string;
  sessionId: string;
  allowedDirectories?: string[];
}

/**
 * What the TUI renders and how it gates: command palette entries, the
 * approval surface, and the optional LLM risk classifier.
 */
export interface TuiUiDeps {
  commands: CommandInfo[];
  permissionMode: PermissionMode;
  hooks?: HookRunner;
  makeCommandContext: () => CommandContext;
  alwaysAllow: Set<string>;
  permissionKey: (toolName: string, input: Record<string, unknown>) => string;
  /** M15.3: optional LLM permission classifier (opt-in via CLI flag). */
  permissionClassifier?: PermissionClassifier;
  permissionPolicy?: import("../permission-policy.js").PermissionPolicy;
  /** M25.2: opt-in full-screen alt-screen layout (default off). */
  fullscreen?: boolean;
  setupElicitation?: (store: TuiStore) => void;
}

/**
 * The TUI's dependency contract, grouped by concern.
 *
 * It was one flat 24-field object, which read as an unstructured bag: nothing
 * said which fields are the model wiring, which are session identity, and
 * which are the approval surface. The groups are structural (extends, no
 * renames), so every call site and every `deps.x` read is unchanged — this
 * makes the contract legible without a 40-file migration.
 */
export interface TuiDeps extends TuiAgentDeps, TuiSessionDeps, TuiUiDeps {}

/** Run one user turn through the agent loop, pushing events into the store. */
export async function runTurn(
  store: TuiStore,
  deps: TuiDeps,
  controller: AbortController,
  askUser: AskUserFn,
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>,
  queue: InputQueue,
  prepareQueuedLine: (text: string) => Promise<ContentBlock[] | null>,
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

  // B1: rebuild the complete prompt per turn when a live builder is wired —
  // MCP tool changes, /memory edits and git refreshes reach the model instead
  // of being frozen at startup. Memoized sections keep this cheap.
  const goal = deps.makeCommandContext().goal?.value;
  const turnSystemPrompt = resolveTurnSystemPrompt(deps, goal);
  // Live session id (see TuiDeps.getSessionId): reads session.id at turn
  // start so /resume's in-place rewrite can't leave checkpoint buckets split.
  const sid = deps.getSessionId?.() ?? deps.sessionId;
  const cancelPrompts = () => store.cancelOverlays();
  controller.signal.addEventListener("abort", cancelPrompts, { once: true });
  const loop = agentLoop(deps.messages, deps.tools, deps.callModel, deps.modelConfig, {
    systemPrompt: turnSystemPrompt,
    toolContext: {
      workspaceRoot: deps.getWorkspaceRoot?.() ?? deps.workspaceRoot,
      sessionId: sid,
      permissionMode: store.getPermissionMode(),
      getPermissionMode: () => store.getPermissionMode(),
      setPermissionMode: (mode) => store.setPermissionMode(mode),
      modelConfig: deps.modelConfig,
      askUserQuestion,
      // M15.3: thread the LLM permission classifier (when enabled) so flagged
      // dangerous calls get a model-assessed risk hint/block in the TUI too.
      permissionClassifier: deps.permissionClassifier,
      permissionPolicy: deps.permissionPolicy,
      allowedDirectories: deps.allowedDirectories,
      hooks: deps.hooks,
      // Stream nested sub-agent (Task) activity into the transcript live, so
      // its Reads/Greps appear as they happen rather than dumping in a block
      // when the Task finishes.
      // Batch C2: ExitPlanMode surfaces the agent's plan as the official
      // "Ready to code?" overlay; the verdict (plus any editor-revised plan)
      // flows straight back into the tool's result.
      requestPlanApproval: (plan) => store.askPlanApproval(plan),
      onSubAgentProgress: (ev) => {
        if (ev.phase === "tool_use") {
          const d = toolDetail(ev.input);
          store.addSubAgentActivity(
            `    ⎿ [${ev.subagentName}] ${capitalize(ev.toolName ?? "tool")}${d ? `(${truncate(d, 80)})` : ""}`,
          );
        } else if (ev.phase === "done") {
          store.setActivityLabel(null);
          const doneLabel =
            ev.reason === "end_turn" ? "done" : `stopped (${ev.reason ?? "unknown"})`;
          store.addSubAgentActivity(`    ⎿ [${ev.subagentName}] ${doneLabel}`);
        }
      },
    },
    askUser,
    abortSignal: controller.signal,
    hooks: deps.hooks,
    // M36: background memory/skill prefetch + (opt-in) tool-batch digest.
    prefetch: deps.prefetch,
    summarizeToolBatch: deps.summarizeToolBatch,
    // M5: resolved per turn so /provider switches are picked up.
    fastModel: deps.fastModelFactory?.() ?? undefined,
    // M36: type-ahead. The loop drains queued input at each turn boundary and
    // continues the SAME turn with it (kernel §9), so a message typed while the
    // agent works is picked up without waiting for the turn to end. Each line
    // goes through prepareQueuedLine (echo at INJECTION time, `!`/`#` prefix
    // dispatch, chip expansion — see dispatchQueuedLine); null = handled
    // locally, nothing to inject. The drain also re-syncs the "queued N" badge.
    drainQueuedInput: async () => {
      const drained = queue.drain();
      const out: ContentBlock[][] = [];
      if (drained.length > 0) {
        // Commit the in-flight assistant segment BEFORE prepareQueuedLine
        // echoes the queued user message: the echo is appended during this
        // drain, and an uncommitted live segment would (a) land in the
        // transcript AFTER the echo it predates and (b) merge with the next
        // response. Settling here keeps response-then-user order.
        streamBuffer.flush();
        settleThinking();
        store.commitStreaming();
      }
      for (const text of drained) {
        const blocks = await prepareQueuedLine(text);
        if (blocks !== null) out.push(blocks);
      }
      store.setQueuedInputs(queue.size);
      store.setQueuedMessages(queue.snapshot());
      return out;
    },
    // P0-4: live retry countdown — the loop reports its pending backoff before
    // sleeping; the first event of the retried call clears it (see the loop).
    onModelRetry: (info) => {
      store.showRetry(
        t(info.kind === "rate_limit" ? "ui.retry.rateLimit" : "ui.retry.transient"),
        info.attempt,
        info.max,
        info.delayMs,
      );
    },
    // M41: background completion notifications are delivered at safe turn
    // boundaries without requiring a job_output polling call.
    drainNotifications: () => drainNotifications(sid),
  });

  let thinkingStart = Date.now();
  let thoughtReported = false;
  // Settle the "Thought for Ns" marker when the thinking phase ENDS (first
  // text delta / tool call / turn end), so the seconds reflect the FULL
  // reasoning duration — reporting at the first thinking_delta (which arrives
  // early in the stream) would systematically under-count. For providers
  // without thinking content this still fires on the first text delta,
  // measuring time-to-first-token as before.
  // P0-2: when thinking TEXT exists it commits as ONE collapsed line
  // ("✻ Thought for Ns · M lines") instead of dumping the full reasoning
  // into the transcript; the full text is visible in the Ctrl+O viewer.
  const settleThinking = () => {
    const hasText = store.getSnapshot().streamingThinking.trim().length > 0;
    if (!thoughtReported && thinkingStart > 0) {
      const secs = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
      if (hasText) {
        store.commitThinking(secs);
      } else {
        store.addThought(secs);
      }
      thoughtReported = true;
    } else {
      // Interleaved thinking (a second burst after text already settled the
      // first): still measure from this burst's start so the collapsed line
      // doesn't read "Thought for 0s".
      const secs =
        thinkingStart > 0
          ? Math.max(1, Math.round((Date.now() - thinkingStart) / 1000))
          : undefined;
      store.commitThinking(secs);
    }
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
      // P0-4: any event from the (retried) call retires the countdown.
      store.clearRetry();
      switch (event.type) {
        case "thinking": {
          // Continuation boundary (budget nudge / truncation recovery /
          // queued-input / notification continuation): the previous model
          // call's segment may still sit uncommitted in the live buffers.
          // Commit it FIRST so the new segment lands as its own transcript
          // item instead of silently merging. On a fresh turn the buffers are
          // empty and this is a no-op; a FAILED attempt was already discarded
          // by model_retry below, so it never reaches here.
          const snap = store.getSnapshot();
          if (snap.streamingText.trim() || snap.streamingThinking.trim() || thoughtReported) {
            streamBuffer.flush();
            settleThinking();
            store.commitStreaming();
          }
          store.clearActiveTools();
          store.setActivityLabel(null);
          deps.onSave("waiting_for_model");
          thinkingStart = Date.now();
          thoughtReported = false;
          store.setSpinner("thinking");
          break;
        }
        case "model_retry":
          // Attempt boundary. PLAIN retry: the failed call's partial stream
          // never entered model history — discard it (buffered deltas AND
          // store state) so the retry's text starts clean instead of
          // appending to a dead fragment, and reset the live token estimate
          // that counted the dead chars.
          // M1 CONTINUATION retry (CCR_RETRY_CONTINUE=1): the agent loop
          // COMMITTED the partial text to history as an assistant message —
          // discarding it here would fork the visible transcript from the
          // real session, so flush+commit instead and let the continuation
          // land as the next transcript segment.
          if (event.continuation) {
            streamBuffer.flush();
            settleThinking();
            store.commitStreaming();
          } else {
            streamBuffer.discard();
            store.discardStreaming();
          }
          streamedCharsThisCall = 0;
          thinkingStart = Date.now();
          thoughtReported = false;
          break;
        case "thinking_delta":
          // Live reasoning content: dims in the live region, commits to the
          // transcript when text/tool events arrive or the turn ends. The
          // duration marker is deferred to settleThinking (commit time).
          store.appendThinking(event.delta);
          break;
        case "text_delta":
          store.setActivityLabel(null);
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
          store.clearActiveTools();
          store.setActivityLabel(null);
          store.setSpinner("thinking");
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
          store.setActivityLabel(t("ui.compact.started"));
          deps.onSave("recovering");
          store.addNotice(t("ui.compact.started"));
          break;
        case "compacted":
          // Post-hoc result of a compaction (proactive or context-length
          // recovery). Without this the loop's silent multi-second compaction
          // LLM call reads as a dead spinner.
          store.addCompactSummary(event.summary, event.messages);
          break;
        case "model_switched":
          // Top10 follow-up E5: the fallback chain changed models — a
          // dedicated event, no longer smuggled in as a "compacted" summary.
          store.addNotice(`⇄ Switched to fallback model: ${event.to} (was ${event.from})`);
          deps.modelConfig.model = event.to;
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
          // The hint already says "interrupted"; the parenthetical reason only
          // adds signal when it's NOT the standard user-interrupt label.
          store.addNotice(
            event.reason === t("ui.abort.user")
              ? `  ⎿ ${t("ui.interrupted.hint")}`
              : `  ⎿ ${t("ui.interrupted.hint")} (${event.reason})`,
          );
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
    controller.signal.removeEventListener("abort", cancelPrompts);
    store.cancelOverlays();
    streamBuffer.stop();
    store.setSpinner("idle");
    store.setSpinnerTokens(0);
    store.stopTurnClock();
    store.setBusy(false);
    store.setTodos([]);
    store.setActivityLabel(null);
    store.clearActiveTools();
    store.clearRetry();
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
  for (const k of [
    "command",
    "filePath",
    "pattern",
    "url",
    "query",
    "description",
    "subagent_type",
    "subagent_name",
  ]) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

/** How many checkpoint first-writes landed on exactly `turn` (menu badge). */
function countIf(firstWrites: Map<string, number>, turn: number): number {
  let n = 0;
  for (const t of firstWrites.values()) if (t === turn) n++;
  return n;
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
  // D1: the resumed conversation is a different session — restart the tip
  // rotation so its tips can all play again.
  store.resetTipPool();
}

/**
 * Drive the interactive /provider flow: list saved API endpoint profiles from
 * .claude/providers.json, let the user pick one from the overlay, then swap the
 * live ModelConfig in place. No LLM call — the next turn uses the new endpoint.
 */
async function runProviderPicker(store: TuiStore, deps: TuiDeps): Promise<void> {
  const profiles = loadProviderProfiles(deps.getWorkspaceRoot?.() ?? deps.workspaceRoot);
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
 * M36 follow-up drain, shared by the normal submit path and bash mode. The
 * agent loop already drains the queue at ITS turn boundaries; this catches
 * messages queued after the loop's final drain but before busy flipped off,
 * running each batch as a follow-up turn. Defensive bound: every queued line
 * costs a full LLM turn, so an unbounded drain lets type-ahead stack
 * unlimited back-to-back turns — 10 is already pathological; beyond that,
 * drop with a notice rather than spin.
 */
const MAX_FOLLOWUP_TURNS = 10;

async function drainFollowUpTurns(
  store: TuiStore,
  deps: TuiDeps,
  sessionId: () => string,
  controller: AbortController,
  askUser: AskUserFn,
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>,
  queue: InputQueue,
  buildUserContent: (text: string) => ContentBlock[],
): Promise<void> {
  const prepare = queuedLinePreparer(store, deps, sessionId, buildUserContent);
  let followUps = 0;
  while (queue.hasPending && followUps < MAX_FOLLOWUP_TURNS) {
    followUps++;
    for (const text of queue.drain()) {
      // Echo + prefix dispatch happen at INJECTION time (dispatchQueuedLine);
      // `#note` lines return null (handled locally, no model turn).
      const blocks = await prepare(text);
      if (blocks === null) continue;
      // P0-3: queued turns are rewindable too (tagged boundary).
      const followUpMsg: Message = { role: "user", content: blocks };
      beginUserTurn(sessionId(), followUpMsg);
      deps.messages.push(followUpMsg);
    }
    store.setQueuedInputs(queue.size);
    store.setQueuedMessages(queue.snapshot());
    await runTurn(store, deps, controller, askUser, askUserQuestion, queue, prepare);
  }
  if (queue.hasPending) {
    const dropped = queue.drain();
    store.setQueuedInputs(0);
    store.setQueuedMessages([]);
    store.addNotice(
      `  ${t("ui.queue.limitDropped", { max: MAX_FOLLOWUP_TURNS, n: dropped.length })}`,
    );
  }
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
 * Execute a user-invoked shell command for `!` bash mode (ungated — the USER
 * typed it), echo the output as dim lines (official UserBashOutputMessage
 * block), and return the captured output for context injection. Shared by the
 * idle path (runBashMode) and queued-line dispatch (dispatchQueuedLine).
 */
async function runShellForBashMode(
  store: TuiStore,
  deps: TuiDeps,
  sessionId: () => string,
  command: string,
): Promise<string> {
  const shellName = process.platform === "win32" ? "powershell" : "bash";
  const shell =
    deps.tools.find((x) => x.name === shellName) ?? deps.tools.find((x) => x.name === "bash");
  if (!shell) {
    store.addNotice("  ⎿ no shell tool available");
    return "(no shell tool available)";
  }
  store.addNotice(`  ${t("ui.bash.running")}`);
  // Minimal tool context: bash mode is user-invoked, so no permission hook
  // is threaded — checkPermission stays absent and the tool runs ungated.
  const r = await shell.call(
    { command, description: "bash mode" } as never,
    {
      workspaceRoot: deps.getWorkspaceRoot?.() ?? deps.workspaceRoot,
      sessionId: sessionId(),
      permissionMode: store.getPermissionMode(),
    } as never,
  );
  const output = r.error ? `error: ${r.error}` : (r.content ?? "").trim() || "(no output)";
  for (const line of output.split("\n").slice(0, 20)) store.addNotice(`  ${line}`);
  return output;
}

/**
 * B1: `!command` bash mode. Runs the shell DIRECTLY (the user invoked it, so
 * no permission gate), echoes input + output into the transcript, injects the
 * output into context, and runs a normal agent turn so Claude responds to it
 * (official respondToBashCommands behavior). Busy turns queue instead — the
 * onSubmit dispatcher only routes here while idle.
 *
 * The response turn is wired EXACTLY like a normal turn: the controller lives
 * in turnControllerRef (so Ctrl+C/Esc interrupt it instead of falling through
 * to the idle exit path), SIGINT aborts it, the MAIN input queue is drained
 * at turn boundaries and via follow-ups (messages typed during a bash turn
 * used to vanish into a throwaway queue), and permission prompts go through
 * the real askUser — only the shell call itself is ungated.
 */
async function runBashMode(
  store: TuiStore,
  deps: TuiDeps,
  sessionId: () => string,
  command: string,
  turnControllerRef: RefObject<AbortController | null>,
  queue: InputQueue,
  askUser: AskUserFn,
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>,
  buildUserContent: (text: string) => ContentBlock[],
): Promise<void> {
  store.addUserMessage(command, { bash: true });
  store.setBusy(true);
  store.setSpinner("tool");
  store.startTurnClock();
  try {
    const output = await runShellForBashMode(store, deps, sessionId, command);
    // Context injection + Claude auto-response: a normal user turn whose text
    // wraps the shell exchange in the official bash-stdout tags.
    const userMsg: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `<bash-input>${command}</bash-input>\n<bash-stdout>\n${output.slice(0, 4000)}\n</bash-stdout>`,
        },
      ],
    };
    beginUserTurn(sessionId(), userMsg);
    deps.messages.push(userMsg);
    const controller = new AbortController();
    turnControllerRef.current = controller;
    const onSigint = () => controller.abort(t("ui.abort.user"));
    process.on("SIGINT", onSigint);
    const prepare = queuedLinePreparer(store, deps, sessionId, buildUserContent);
    try {
      await runTurn(store, deps, controller, askUser, askUserQuestion, queue, prepare);
      await drainFollowUpTurns(
        store,
        deps,
        sessionId,
        controller,
        askUser,
        askUserQuestion,
        queue,
        buildUserContent,
      );
    } finally {
      turnControllerRef.current = null;
      process.removeListener("SIGINT", onSigint);
    }
  } catch (err) {
    store.addNotice(`⎿ ${formatCliError(err)}`);
    store.setBusy(false);
  }
}

/**
 * B2: `#note` memory mode. Appends to CLAUDE.md with the same formatting as
 * /memory add, echoes the line with the blue "#" marker, and confirms. No
 * model turn — the memory enters context through CLAUDE.md on later builds.
 */
function runMemoryMode(store: TuiStore, deps: TuiDeps, note: string): void {
  store.addUserMessage(note, { memory: true });
  try {
    const claudeMd = nodePath.join(deps.getWorkspaceRoot?.() ?? deps.workspaceRoot, "CLAUDE.md");
    const exists = fs.existsSync(claudeMd);
    const prefix = exists && !fs.readFileSync(claudeMd, "utf-8").endsWith("\n") ? "\n" : "";
    fs.appendFileSync(claudeMd, `${prefix}- ${note}\n`, "utf-8");
    store.addNotice(`  ${t("ui.memory.added")}`);
  } catch (err) {
    store.addNotice(`  ⎿ ${formatCliError(err)}`);
  }
}

/**
 * Dispatch ONE queued line at injection time (review 2026-09-07). Two
 * invariants live here:
 *
 * 1. ECHO AT INJECTION, not at queue time. A queued line recalled (↑) or
 *    dropped (follow-up cap) must leave no ghost user message the model never
 *    saw — and the transcript stays in lockstep with `messages` (rewind's
 *    data source). Until injection the line exists only in the dim
 *    QueuedMessages area above the input box (official behavior).
 * 2. PREFIXES SURVIVE QUEUEING. A queued `!cmd` executes the shell at the
 *    drain point and injects the official <bash-input>/<bash-stdout> wrap; a
 *    queued `#note` appends to CLAUDE.md and never reaches the model.
 *    (Previously every queued line went to the model as literal text —
 *    "!ls" was never executed.)
 *
 * Returns the text to inject into `messages`, or null when the line was
 * handled locally with no model turn (`#note`).
 *
 * Exported for tests (queued-dispatch.test.ts).
 */
export async function dispatchQueuedLine(
  store: TuiStore,
  deps: TuiDeps,
  sessionId: () => string,
  text: string,
): Promise<string | null> {
  if (text.startsWith("!") && text.length > 1) {
    const command = text.slice(1).trim();
    store.addUserMessage(command, { bash: true });
    const output = await runShellForBashMode(store, deps, sessionId, command);
    return `<bash-input>${command}</bash-input>\n<bash-stdout>\n${output.slice(0, 4000)}\n</bash-stdout>`;
  }
  if (text.startsWith("#") && text.trim().length > 1) {
    runMemoryMode(store, deps, text.slice(1).trim()); // echoes with the # marker itself
    return null;
  }
  store.addUserMessage(text);
  return text;
}

/** Compose dispatchQueuedLine + chip expansion into runTurn's queue preparer. */
function queuedLinePreparer(
  store: TuiStore,
  deps: TuiDeps,
  sessionId: () => string,
  buildUserContent: (text: string) => ContentBlock[],
): (text: string) => Promise<ContentBlock[] | null> {
  return async (text) => {
    const injected = await dispatchQueuedLine(store, deps, sessionId, text);
    return injected === null ? null : buildUserContent(injected);
  };
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
  const idleFeedbackRef = useRef<string[]>([]);
  const askingState = useStoreSelector(store, (state) => ({
    busy: state.busy,
    overlay: state.overlay !== null,
  }));
  // The AbortController of the in-flight turn, so the Ctrl+C hotkey can
  // interrupt it. Ink keeps stdin in raw mode, so Ctrl+C never raises SIGINT —
  // the process-level handler below only covers non-TUI fallbacks.
  const turnControllerRef = useRef<AbortController | null>(null);
  // P0-5: pasted-image registry. "[Image #N]" chips in a submitted prompt
  // resolve against this map into image content blocks; the blocks then live
  // in `messages` history (model-visible on every later turn, official style).
  const imagesRef = useRef(new Map<number, string>());
  const imageCounterRef = useRef(0);
  // D5: large-paste store. Unlike images, pastes are NOT single-use: the chip
  // keeps resolving for the whole session (a chip recalled from history or
  // moved between drafts still expands — the content is text, cheap to keep).
  const pastesRef = useRef(new Map<number, string>());
  const pasteCounterRef = useRef(0);
  // Live session id (P0-3 fix): /resume rewrites session.id in place, so the
  // startup-captured deps.sessionId goes stale — checkpoints and /rewind would
  // then query different buckets. Same getter pattern as getWorkspaceRoot.
  const sessionId = useCallback(() => deps.getSessionId?.() ?? deps.sessionId, [deps]);

  // Chips are SINGLE-USE: an attached image is consumed on submit, so a chip
  // recalled from history (or typed literally) can't silently re-attach a
  // stale image to a later message. Paste chips (D5) are the exception — see
  // pastesRef: they expand every time, straight into the text.
  const buildUserContent = useCallback((text: string): ContentBlock[] => {
    const resolved = expandPastedChips(text, pastesRef.current);
    const blocks: ContentBlock[] = [{ type: "text", text: resolved }];
    for (const m of resolved.matchAll(/\[Image #(\d+)\]/g)) {
      const n = Number(m[1]);
      const data = imagesRef.current.get(n);
      if (data) {
        blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
        imagesRef.current.delete(n);
      }
    }
    return blocks;
  }, []);

  // D5: the InputBox hands over pastes above the fold threshold and gets the
  // chip back — same shape as onImagePaste, but synchronous (the content is
  // already in hand; no clipboard read to await).
  const onLargePaste = useCallback((content: string): string => {
    pasteCounterRef.current += 1;
    pastesRef.current.set(pasteCounterRef.current, content);
    const lines = content.split("\n").length;
    return makePasteChip(pasteCounterRef.current, lines);
  }, []);

  // P0-5: InputBox Ctrl/Alt+V → read the system clipboard. Registers the
  // image and returns the chip text to insert at the cursor.
  const onImagePaste = useCallback(async (): Promise<string | null> => {
    const data = await readClipboardImageBase64();
    if (!data) return null;
    imageCounterRef.current += 1;
    imagesRef.current.set(imageCounterRef.current, data);
    return `[Image #${imageCounterRef.current}]`;
  }, []);

  // B6: Up from an empty buffer recalls the newest queued message for
  // editing (official PromptInput behavior). Mirrors shrink alongside.
  const onQueuePop = useCallback((): string | null => {
    const recalled = queueRef.current.popLast();
    store.setQueuedInputs(queueRef.current.size);
    store.setQueuedMessages(queueRef.current.snapshot());
    return recalled;
  }, [store]);

  // B8 (alt+p): model picker built from the saved provider profiles + the
  // current model. Switching mutates the live ModelConfig (no LLM call) and
  // resizes the context gauge to the new model's window.
  const onModelPicker = useCallback(() => {
    if (store.getSnapshot().overlay) return;
    void runModelPicker(store, deps.modelConfig, deps.getWorkspaceRoot?.() ?? deps.workspaceRoot);
  }, [store, deps]);

  // B8 (alt+t): flip extended thinking on/off by toggling the adapter's
  // thinking option (options.thinking = {type:"disabled"} suppresses it;
  // removing the key restores the default adaptive behavior).
  const onThinkingToggle = useCallback(() => {
    const cfg = deps.modelConfig;
    cfg.options = cfg.options ?? {};
    const disabled =
      typeof cfg.options.thinking === "object" &&
      (cfg.options.thinking as { type?: string }).type === "disabled";
    if (disabled) {
      delete cfg.options.thinking;
      store.addNotice(`  ${t("ui.thinking.on")}`);
    } else {
      cfg.options.thinking = { type: "disabled" };
      store.addNotice(`  ${t("ui.thinking.off")}`);
    }
  }, [store, deps]);

  // P0-3: Esc+Esc rewind menu. Truncates `messages` to BEFORE the chosen user
  // turn and restores on-disk files from the checkpoint snapshots. Each entry
  // maps to its checkpoint turn via the message tag (turnOfMessage) — no
  // ordinal arithmetic that synthetic injections or /resume could skew.
  const openRewindMenu = useCallback(async () => {
    const sid = sessionId();
    const userTurns: Array<{ index: number; text: string; cpTurn: number | null }> = [];
    deps.messages.forEach((m, i) => {
      if (m.role !== "user") return;
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
              .map((b) => b.text)
              .join(" ");
      userTurns.push({ index: i, text, cpTurn: turnOfMessage(m, sid) });
    });
    if (userTurns.length === 0) {
      store.addNotice("  Nothing to rewind — no user turns yet.");
      return;
    }
    // filesChanged per turn: paths whose first write was that turn.
    const firstWrites = changedFiles(sid);
    const entries: RewindEntry[] = [];
    for (let turn = userTurns.length; turn >= 1; turn--) {
      const t = userTurns[turn - 1]!;
      const filesChanged = t.cpTurn === null ? 0 : countIf(firstWrites, t.cpTurn);
      const meta = t.cpTurn === null ? null : listTurns(sid).find((x) => x.turn === t.cpTurn);
      entries.push({
        turnIndex: turn,
        label: t.text.replace(/\s+/g, " ").slice(0, 80) || "(empty)",
        timestamp: meta ? new Date(meta.timestamp).toLocaleTimeString() : "",
        filesChanged,
      });
    }
    // Batch C3: the picker resolves with the second-stage action — WHAT to
    // restore (official MessageSelector semantics).
    const chosen = await store.askRewind(entries);
    if (chosen === null) return;
    const { turnIndex, action } = chosen;
    const target = userTurns[turnIndex - 1]!;
    const cutAt = target.index;
    const before = deps.messages.length;

    // Files: restore the tagged boundary when present; turns loaded by
    // /resume have none — the conversation still rewinds, honestly reported.
    // "conversation" skips this entirely; "code" does ONLY this.
    const restoreFiles = action !== "conversation";
    const restoration =
      restoreFiles && target.cpTurn !== null
        ? restoreToTurn(sid, target.cpTurn)
        : { restored: [], deleted: [] };
    if (restoration.failures?.length) {
      store.addNotice(
        `Rewind incomplete: ${restoration.failures.map((f) => `${f.path}: ${f.error}`).join("; ")}. Conversation and checkpoints retained for retry.`,
      );
      return;
    }
    const { restored, deleted } = restoration;

    if (action !== "code") {
      deps.messages.length = cutAt;
      // Reset the on-screen transcript to the SURVIVING history (same replay
      // semantics as /resume). resetTranscript bumps an epoch that remounts
      // the <Static> region — without it Ink's write-once Static would
      // swallow all future items (its internal index only grows, so a
      // shrunk array leaves slice(index) empty forever).
      store.resetTranscript();
      store.addNotice(
        `  ⏪ Rewound to before message #${turnIndex} (${before} → ${deps.messages.length} messages)`,
      );
    } else {
      store.addNotice(`  ⏪ Code restored to before message #${turnIndex} (conversation kept)`);
    }
    if (restoreFiles && target.cpTurn === null) {
      store.addNotice("  ⎿ no file checkpoint for this turn — files not restored");
    } else if (restored.length > 0 || deleted.length > 0) {
      store.addNotice(
        `  ⎿ files restored: ${restored.length} rewritten · ${deleted.length} deleted (Bash-side edits are not checkpointed)`,
      );
    }
    if (action !== "code") {
      store.loadTranscript(messagesToTranscript(deps.messages));
      store.setTodos([]);
    }
    try {
      deps.onSave();
    } catch {
      /* best-effort persistence */
    }
  }, [store, deps, sessionId]);

  const askUser: AskUserFn = useCallback(
    async (tool, input, riskHint) => {
      const key = deps.permissionKey(tool.name, input);
      if (deps.alwaysAllow.has(key)) return true;
      // Official tool-aware "always" wording: bash offers "…for commands in
      // <cwd>", the edit family offers "…allow all edits this session",
      // everything else falls back to the session-generic label.
      const cwd = deps.getWorkspaceRoot?.() ?? deps.workspaceRoot;
      const name = tool.name.toLowerCase();
      const alwaysLabel =
        name === "bash" || name === "shell"
          ? t("ui.permission.alwaysBash", { dir: cwd })
          : name === "write" || name === "edit" || name === "multiedit" || name === "notebookedit"
            ? t("ui.permission.alwaysEdits")
            : undefined;
      const detail = toolDetail(input);
      const presentation = permissionPresentation(tool, input);
      const choice = await store.askPermission(
        presentation.header,
        detail && detail !== presentation.description ? detail : undefined,
        riskHint,
        alwaysLabel,
        buildPermissionDiff(tool.name, input),
        {
          ...presentation,
          onAmend: (feedback) => {
            const message = t("ui.prompt.feedbackMessage", { tool: tool.name, feedback });
            if (store.getSnapshot().busy) {
              queueRef.current.push(message);
              store.setQueuedInputs(queueRef.current.size);
              store.setQueuedMessages(queueRef.current.snapshot());
            } else {
              idleFeedbackRef.current.push(message);
            }
          },
        },
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
      // Batch C5: persist every submitted line (consecutive dups collapse).
      appendHistory(deps.getWorkspaceRoot?.() ?? deps.workspaceRoot, value);
      if (value.toLowerCase() === "exit" || value.toLowerCase() === "/exit") {
        // Tear down resources before exiting. Previously this was a bare
        // process.exit(0) that skipped onSave (session lost), MCP disconnect,
        // and LSP dispose. onSave() flushes the session. NOTE: process.exit
        // does NOT unmount Ink — the runTui-level "exit" hook restores raw
        // mode / bracketed paste / cursor so the shell isn't left broken.
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
      // next turn boundary and continues with it (kernel §9). NO transcript
      // echo here — the line shows only in the dim QueuedMessages area until
      // the drain injects it (dispatchQueuedLine echoes at THAT moment), so a
      // recalled (↑) or capped/dropped line leaves no ghost message the model
      // never saw, and the transcript never diverges from `messages` (rewind's
      // data source). Slash commands typed while busy are queued as plain
      // follow-up text (run them when idle for local handling).
      if (store.getSnapshot().busy) {
        store.addNotice(`  ${t("ui.queue.queued")}`);
        queueRef.current.push(value);
        store.setQueuedInputs(queueRef.current.size);
        store.setQueuedMessages(queueRef.current.snapshot());
        return;
      }

      // B1: `!command` — bash mode. Runs the shell directly (no permission
      // gate: the USER invoked it), echoes the input/output into the
      // transcript, injects the output into context, and lets Claude respond
      // to it in a normal turn (official `respondToBashCommands` behavior).
      if (value.startsWith("!") && value.length > 1) {
        void runBashMode(
          store,
          deps,
          sessionId,
          value.slice(1).trim(),
          turnControllerRef,
          queueRef.current,
          askUser,
          askUserQuestion,
          buildUserContent,
        );
        return;
      }

      // B2: `#note` — memory mode. Appends to CLAUDE.md (same format as
      // /memory add) and echoes the line; no model turn (the memory rides
      // into context via CLAUDE.md on the next session/prompt build).
      if (value.startsWith("#") && value.trim().length > 1) {
        runMemoryMode(store, deps, value.slice(1).trim());
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
            // D1: a replaced conversation (/clear, /resume <id>) restarts the
            // spinner-tip rotation — the pool is per-session, not per-process.
            if (/^\/(clear|resume)\b/i.test(value)) store.resetTipPool();
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
        // M41: completions that arrived while idle ride along with the next
        // user prompt. They are drained exactly once and become model-visible
        // without starting a turn by itself.
        const pendingNotes = drainNotifications(sessionId());
        const contentText = [pendingNotes.join("\n\n"), inputText, ...attachments]
          .filter(Boolean)
          .join("\n\n");
        // P0-3: checkpoint turn boundary BEFORE the message lands, so rewind
        // restores "the world as it was when this prompt was sent". The
        // message itself is tagged with its turn (turnOfMessage).
        const userMsg: Message = {
          role: "user",
          content: buildUserContent(contentText),
        };
        beginUserTurn(sessionId(), userMsg);
        deps.messages.push(userMsg);

        const controller = new AbortController();
        turnControllerRef.current = controller;
        const onSigint = () => controller.abort(t("ui.abort.user"));
        process.on("SIGINT", onSigint);
        try {
          const prepare = queuedLinePreparer(store, deps, sessionId, buildUserContent);
          await runTurn(
            store,
            deps,
            controller,
            askUser,
            askUserQuestion,
            queueRef.current,
            prepare,
          );
          // M36 race window: a message queued AFTER the loop's final drain (but
          // before busy flipped off) is still pending here. The loop already
          // ended, so drain it ourselves and run it as a follow-up turn.
          await drainFollowUpTurns(
            store,
            deps,
            sessionId,
            controller,
            askUser,
            askUserQuestion,
            queueRef.current,
            buildUserContent,
          );
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
    [store, deps, askUser, askUserQuestion, buildUserContent, sessionId],
  );

  // Feedback on a background request starts only after all overlays close.
  useEffect(() => {
    if (askingState.busy || askingState.overlay) return;
    for (const feedback of idleFeedbackRef.current.splice(0)) onSubmit(feedback);
  }, [askingState.busy, askingState.overlay, onSubmit]);

  // M41: keep the scheduler alive for the whole TUI session. A due prompt is
  // submitted through the same path as user input, while background
  // completions are displayed as notices and remain queued for the next model
  // boundary. The scheduler owns its interval and returns a cleanup function.
  useEffect(() => {
    return startScheduler({
      sessionId,
      workspaceRoot: () => deps.getWorkspaceRoot?.() ?? deps.workspaceRoot,
      // An open overlay (permission/question prompt from a BACKGROUND agent
      // surfacing while the main turn is idle) counts as busy: injecting a
      // scheduled prompt now would start a competing turn under the prompt.
      isBusy: () => store.getSnapshot().busy || store.getSnapshot().overlay !== null,
      deliver: (prompt) => onSubmit(prompt),
      displayNotifications: (items) => {
        for (const item of items) store.addNotice(`⎿ ${formatNotificationLine(item)}`);
      },
      displayParked: (p) => store.addNotice(t("ui.schedule.parked", { label: p.label })),
    });
  }, [deps, onSubmit, store, sessionId]);

  return (
    <>
      <InterruptHotkey
        store={store}
        controllerRef={turnControllerRef}
        editorMode={deps.makeCommandContext().editorMode}
      />
      <App
        store={store}
        commands={deps.commands}
        onSubmit={onSubmit}
        editorMode={deps.makeCommandContext().editorMode}
        completeFiles={completeFiles}
        fullscreen={deps.fullscreen}
        onRewind={openRewindMenu}
        onImagePaste={onImagePaste}
        onQueuePop={onQueuePop}
        onModelPicker={onModelPicker}
        onThinkingToggle={onThinkingToggle}
        onLargePaste={onLargePaste}
      />
    </>
  );
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
  // B5: the official double-press window for the idle Ctrl+C / Ctrl+D exit —
  // the first press clears the draft and arms "Press ctrl+c again to exit"
  // (the footer shows it via store.showExitHint); a second press within
  // EXIT_DOUBLE_PRESS_MS exits, a later one re-arms. Note this is NOT
  // EXIT_HINT_MS: the hint stays readable for longer than the press window on
  // purpose (see the constant). Reading the draft from the snapshot at event
  // time matches the "?" hotkey's guard pattern.
  const exitPressRef = useRef(0);
  useInput((input, key) => {
    const isCtrlC = key.ctrl && input === "c";
    const isCtrlD = key.ctrl && input === "d";
    const isEsc = key.escape === true;
    if (!isCtrlC && !isCtrlD && !isEsc) return;
    if (store.getSnapshot().overlay || store.getSnapshot().reviewing) return;
    if (isEsc && editorMode?.value === "vim") return;
    const controller = controllerRef.current;
    if (controller && store.getSnapshot().busy) {
      // Busy: both Ctrl+C and Esc interrupt the turn (Ctrl+D does not — its
      // official busy behavior is char-delete, which the InputBox owns).
      if (!isCtrlD) controller.abort(t("ui.abort.user"));
      return;
    }
    if (isEsc) return; // idle Esc belongs to the InputBox chain
    // Idle Ctrl+C: first press clears a non-empty draft (input editing
    // continues), then arms the exit hint; second press within the window
    // exits. Ctrl+D: straight double-press exit, no draft clearing.
    const now = Date.now();
    if (isCtrlC && store.getSnapshot().draft.text.length > 0) {
      store.dispatchInputAction("clear");
      store.armExitHint();
      exitPressRef.current = now;
      return;
    }
    if (now - exitPressRef.current <= EXIT_DOUBLE_PRESS_MS && store.getSnapshot().showExitHint) {
      exit();
      return;
    }
    store.armExitHint();
    exitPressRef.current = now;
  });
  return null;
}

/** Launch the Ink TUI. Resolves when the user exits. */
export function runTui(deps: TuiDeps): Promise<void> {
  // /theme persists via modelConfig.options (config file) — apply the saved
  // choice before the first frame so the palette is right from the start.
  const savedTheme = deps.modelConfig.options?.theme;
  if (typeof savedTheme === "string") applyTheme(savedTheme);
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
    // left on the alternate screen. SIGTERM needs the default termination
    // RE-INSTATED after restoring — with a listener attached Node cancels the
    // default, so a bare restore would make `kill <pid>` a no-op.
    process.once("exit", restoreScreen);
    process.once("SIGTERM", () => {
      restoreScreen();
      process.exit(143); // 128 + SIGTERM
    });
  }

  // process.exit() — the `exit` command, SIGTERM, a fatal error — skips Ink's
  // beforeExit teardown, so raw mode, bracketed paste and the hidden cursor
  // would leak into the user's shell (no echo, `200~` markers on paste,
  // invisible cursor until a manual `reset`). The "exit" event is the last
  // synchronous hook that runs on EVERY termination path, so restore there.
  // After a clean Ink unmount every step is an idempotent no-op.
  let terminalRestored = false;
  const restoreTerminalState = () => {
    if (terminalRestored) return;
    terminalRestored = true;
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdout.write("\x1b[?2004l\x1b[?25h");
    } catch {
      /* terminal already gone */
    }
  };
  process.once("exit", restoreTerminalState);

  // In full-screen mode the layout is the whole viewport (the banner becomes the
  // first scroll line); in the default mode we print the banner into scrollback
  // above Ink's live region as before.
  if (deps.fullscreen) {
    const store = new TuiStore(`${deps.modelConfig.provider}/${deps.modelConfig.model}`, {
      batching: true,
      permissionMode: deps.permissionMode,
      modelId: deps.modelConfig.model,
    });
    deps.setupElicitation?.(store);
    store.setContextLimit(lookupContextWindow(deps.modelConfig.model) ?? 0);
    // Batch C5: seed ↑-history from this project's persisted log.
    store.setInputHistory(loadHistory(deps.workspaceRoot));
    store.loadTranscript(
      renderBannerLines({
        version: APP_VERSION,
        model: deps.modelConfig.model,
        provider: deps.modelConfig.provider,
        workspaceRoot: deps.workspaceRoot,
      }).map((line) => ({ kind: "log", lines: [line] })),
    );
    const { waitUntilExit } = render(<Root store={store} deps={deps} />, {
      // Ctrl+C is handled by Root's InterruptHotkey (interrupt turn / exit when
      // idle) — Ink's default would hard-exit the process mid-turn.
      exitOnCtrlC: false,
      // Explicit stdio (Ink's defaults — stated for clarity; no mouse
      // protocol is enabled: scrolling is the terminal's / PgUp pager's job).
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    return (waitUntilExit() as Promise<void>).finally(restoreScreen);
  }

  // Print the startup banner once into scrollback (above Ink's live region).
  printBanner({
    version: APP_VERSION,
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
  deps.setupElicitation?.(store);
  // Context gauge: unknown models get 0 → gauge hidden rather than mis-sized.
  store.setContextLimit(lookupContextWindow(deps.modelConfig.model) ?? 0);
  // Batch C5: seed ↑-history from this project's persisted log.
  store.setInputHistory(loadHistory(deps.workspaceRoot));
  const { waitUntilExit } = render(<Root store={store} deps={deps} />, {
    // See the fullscreen render above: Ctrl+C belongs to InterruptHotkey.
    exitOnCtrlC: false,
    // Explicit stdio (Ink's defaults — stated for clarity; no mouse protocol
    // is enabled: scrolling is the terminal's / PgUp pager's job).
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  return waitUntilExit() as Promise<void>;
}
