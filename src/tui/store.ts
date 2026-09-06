// ============================================================
// TUI Store — observable state bridging the agent loop to React
// ============================================================
// The agent loop is imperative (an async generator of LoopEvents); Ink/React
// is declarative. This store is the seam: the REPL orchestration pushes
// events in via mutator methods, and the Ink <App> subscribes to re-render.
//
// No React imports here — it's a plain pub/sub container so it stays unit
// testable. Components read snapshots via useSyncExternalStore.
// ============================================================

import type { PermissionMode, TodoDisplayItem, ToolExecutionResult } from "./../types.js";
import type { EffortLevel } from "./effort.js";
import { t } from "./i18n.js";

export type TranscriptItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  /**
   * Committed extended-thinking content. Renders COLLAPSED (one
   * "Thought for Ns" line); the full text is visible in the transcript
   * viewer (Ctrl+O) — P0-2.
   */
  | { kind: "thinking_text"; id: number; text: string; seconds?: number }
  | {
      kind: "tool";
      id: number;
      name: string;
      detail: string;
      result?: ToolExecutionResult;
      /** True on an appended full-output copy (ctrl+r handler) — renders expanded. */
      expanded?: boolean;
      /** On an expanded copy: the source item's id (dedupe for re-expansion). */
      expandedOf?: number;
    }
  | { kind: "thought"; id: number; seconds: number }
  | { kind: "notice"; id: number; text: string }
  | { kind: "log"; id: number; lines: string[] };

export type SpinnerMode = "idle" | "thinking" | "tool" | "responding";

/** A tool currently executing, shown live with a spinner. */
export interface ActiveTool {
  /** Originating tool-call id (stable key matching its tool_result). */
  id: string;
  name: string;
  detail: string;
  /** Epoch ms when the tool started (drives the live elapsed clock). */
  startedAt: number;
}

/**
 * One row in the /resume session picker. Pre-formatted display data so the
 * component stays dumb (no fs / Message conversion in React).
 */
export interface SessionPickerItem {
  /** Full session id (returned by the picker on selection). */
  sessionId: string;
  /** One-line summary: short id · N msgs · timestamp · open/done. */
  label: string;
  /** Optional preview of the first user message. */
  preview?: string;
  /** True when this is the session currently loaded in the REPL. */
  current?: boolean;
}

export interface ProviderPickerItem {
  /** Profile name (returned by the picker on selection). */
  name: string;
  /** One-line summary: "provider/model". */
  label: string;
  /** Optional detail (e.g. base URL). */
  detail?: string;
  /** True when this profile matches the active provider/model. */
  current?: boolean;
}

/** One row in the /help command palette. */
export interface CommandPickerItem {
  /** Command name without the leading slash (returned on selection). */
  name: string;
  /** One-line description shown beside the name. */
  description: string;
}

/**
 * One entry in the Esc+Esc rewind menu (P0-3). Pre-formatted display data;
 * `turnIndex` (1-based user-turn number) is returned on selection.
 */
export interface RewindEntry {
  turnIndex: number;
  /** Preview of that turn's user message. */
  label: string;
  /** When the turn was sent (pre-formatted, local time). */
  timestamp: string;
  /** Files first modified in this turn (checkpoint data). */
  filesChanged: number;
}

/** Live model-error retry countdown (P0-4): "⚠ … — retrying in Ns · a/m". */
export interface RetryStatus {
  /** Short reason, e.g. "429 rate limit" or "connection timeout". */
  reason: string;
  attempt: number;
  max: number;
  secondsLeft: number;
}

/** A pending interactive prompt the App should overlay. */
export type Overlay =
  | {
      kind: "permission";
      header: string;
      detail?: string;
      riskHint?: string;
      /** Official-style "always" option label, e.g. "Yes, and don't ask
       *  again for commands in <dir>" — built by the caller (run.tsx) from
       *  the tool + cwd. Falls back to the generic session label. */
      alwaysLabel?: string;
      resolve: (choice: "yes" | "always" | "no") => void;
    }
  | {
      kind: "question";
      header: string;
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
      resolve: (labels: string[] | null) => void;
    }
  | {
      kind: "effort";
      current: EffortLevel;
      resolve: (level: EffortLevel | null) => void;
    }
  | {
      kind: "sessionPicker";
      sessions: SessionPickerItem[];
      resolve: (sessionId: string | null) => void;
    }
  | {
      kind: "providerPicker";
      profiles: ProviderPickerItem[];
      resolve: (name: string | null) => void;
    }
  | {
      kind: "commandPicker";
      commands: CommandPickerItem[];
      resolve: (name: string | null) => void;
    }
  | {
      kind: "rewind";
      entries: RewindEntry[];
      resolve: (turnIndex: number | null) => void;
    }
  | {
      kind: "confirm";
      header: string;
      resolve: (confirmed: boolean) => void;
    };

export interface StoreState {
  /** Completed transcript items (rendered in <Static>, never repainted). */
  transcript: TranscriptItem[];
  /** Live assistant text currently streaming (not yet committed). */
  streamingText: string;
  /** Live reasoning content (extended thinking) currently streaming. */
  streamingThinking: string;
  /**
   * Current todo list — a live projection of the Todo tool's session state,
   * updated from the tool's result metadata on every todo call. Pinned under
   * the spinner as a persistent live region (empty = hidden).
   */
  todos: TodoDisplayItem[];
  /**
   * Live tool cards currently executing (not yet committed). Multiple tools
   * run concurrently (parallel-safe reads/greps), so this is a list keyed by
   * the originating tool-call id.
   */
  activeTools: ActiveTool[];
  spinner: SpinnerMode;
  /** Rough output-token counter shown next to the spinner. */
  spinnerTokens: number;
  /** Epoch ms of the last spinner-relevant activity (token delta, phase
   *  change, tool activity). Drives the official stall warning: 3s of silence
   *  blends the spinner glyph toward error red (spinner-core.stalledGlyphColor). */
  spinnerActivityAt: number;
  /** Epoch ms when the current turn began (0 = no turn running). Drives the
   *  status-line elapsed clock so it survives the thinking→tool→responding
   *  phase changes within one turn. */
  turnStartedAt: number;
  /** Session-wide token totals for the status bar. */
  tokensIn: number;
  tokensOut: number;
  /** Session-cumulative prompt-cache read tokens (cache-hit visibility). */
  cacheReadTokens: number;
  /**
   * Estimated tokens occupying the context window after the LAST model call
   * (input + cache + output of that call, provider semantics reconciled by
   * the caller — see run.tsx estimateContextUsed). Not cumulative across
   * calls: it answers "how full is the window right now". 0 = no usage yet.
   */
  contextUsed: number;
  /** Context-window size of the active model (0 = unknown → gauge hidden). */
  contextLimit: number;
  /** Current pending overlay, if any. */
  overlay: Overlay | null;
  /** True while the agent loop is running (input disabled). */
  busy: boolean;
  /**
   * Messages typed while busy, waiting in the type-ahead queue (mirrored from
   * the InputQueue so the status bar can show "queued N"). The queue itself
   * lives in the runner; this is a display projection.
   */
  queuedInputs: number;
  /** Current permission mode, shared by Shift+Tab, status bar, and tool checks. */
  permissionMode: PermissionMode;
  /** Model label for the status bar. */
  modelLabel: string;
  /** Raw model id (pricing / context-window lookups); the label is for display. */
  modelId: string;
  /** Transient toast message shown briefly after mode changes etc. */
  toast: string | null;
  /** Help panel visibility (triggered by "?" key). */
  showHelp: boolean;
  /**
   * The InputBox's live draft (text + cursor), mirrored synchronously on
   * every edit. Two consumers:
   *  1. the "?" help hotkey's empty-draft guard — read AT EVENT TIME from
   *     getSnapshot() (a render-derived flag would be stale within the same
   *     stdin dispatch);
   *  2. draft preservation across unmounts — overlays and the review pager
   *     REPLACE the InputBox (component state would die with it); the next
   *     mount seeds itself from this mirror.
   * Nothing subscribes to this field, so the mirror costs no re-renders.
   */
  draft: { text: string; cursor: number };
  /** M41: input command history for ↑/↓ navigation. */
  inputHistory: string[];
  /**
   * Transcript review mode (PgUp/Ctrl+O opens, Esc closes). When true the App
   * swaps the transcript/live/input regions for the in-app scrollable pager — the
   * default <Static> path has no scrollback of its own (the terminal owns it),
   * and on consoles with scroll-on-output snap the terminal fights the user
   * while content streams. The pager makes scrolling app-controlled.
   */
  reviewing: boolean;
  /**
   * Live retry countdown (P0-4), null when not retrying. Set by the runner from
   * the loop's onModelRetry callback; cleared by the first event of the retried
   * call. Owns a 1s tick that decrements secondsLeft down to 0.
   */
  retryStatus: RetryStatus | null;
  /**
   * Increments whenever the transcript is bulk-replaced (rewind / session
   * reload). The transcript region keys its <Static> on this epoch: Ink's
   * Static tracks a monotonically growing internal index, so a SHRUNK items
   * array would leave slice(index) empty forever — remounting restarts the
   * index and reprints the surviving history.
   */
  transcriptEpoch: number;
}

type Listener = () => void;

// Coalescing window for batched notifications. A burst of mutations within one
// frame (~60fps) collapses to a single `emit()`, so a fast stream doesn't fire
// one React re-render per store write. State itself is always written
// synchronously (see `set`), so `getSnapshot` stays current regardless.
const FRAME_MS = 16;

// Context-gauge thresholds, as a fraction of contextLimit. The warn level
// mirrors agent-loop's defaults (auto-compact fires at 150k on a 200k window
// = 75%): by the time the percent turns amber, compaction is imminent. Shared
// by the PromptFooter colors and the crossing toasts below.
export const CTX_WARN_PCT = 0.75;
export const CTX_CRITICAL_PCT = 0.9;

export const PERMISSION_MODE_CYCLE: PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODE_CYCLE.indexOf(current);
  return PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length] ?? "default";
}

export class TuiStore {
  private state: StoreState;
  private listeners = new Set<Listener>();
  private nextId = 1;
  // When true, `emit()` is deferred and coalesced to the next frame. Defaults
  // OFF so unit tests see synchronous notifications (zero churn on existing
  // sync assertions); the TUI runner opts in via the constructor for the
  // production render path.
  private batching: boolean;
  private emitScheduled = false;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    modelLabel: string,
    opts?: { batching?: boolean; permissionMode?: PermissionMode; modelId?: string },
  ) {
    this.batching = opts?.batching ?? false;
    this.state = {
      transcript: [],
      streamingText: "",
      streamingThinking: "",
      todos: [],
      activeTools: [],
      spinner: "idle",
      spinnerTokens: 0,
      spinnerActivityAt: 0,
      turnStartedAt: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      contextUsed: 0,
      contextLimit: 0,
      overlay: null,
      busy: false,
      queuedInputs: 0,
      permissionMode: opts?.permissionMode ?? "default",
      modelLabel,
      modelId: opts?.modelId ?? "",
      toast: null,
      showHelp: false,
      draft: { text: "", cursor: 0 },
      inputHistory: [],
      reviewing: false,
      retryStatus: null,
      transcriptEpoch: 0,
    };
  }

  // --- pub/sub (useSyncExternalStore contract) ---

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreState => this.state;

  private emitNow(): void {
    for (const l of this.listeners) l();
  }

  /** Coalesce multiple mutations in one frame into a single notify. */
  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      if (this.emitScheduled) {
        this.emitScheduled = false;
        this.emitNow();
      }
    }, FRAME_MS);
  }

  /**
   * Synchronously drain any pending batched notification. The TUI runner calls
   * this from `runTurn`'s `finally` so the terminal idle state paints at once
   * rather than waiting on a trailing frame; tests can call it to assert
   * post-mutation state deterministically.
   */
  flush = (): void => {
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.emitScheduled) {
      this.emitScheduled = false;
      this.emitNow();
    }
  };

  /** Toggle frame-coalescing. Turning it off flushes any pending notify. */
  setBatching(on: boolean): void {
    this.batching = on;
    if (!on) this.flush();
  }

  private emit(): void {
    if (this.batching) this.scheduleEmit();
    else this.emitNow();
  }

  /** Replace state with a shallow-merged patch and notify. */
  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private push(item: Omit<TranscriptItem, "id"> & { id?: number }): void {
    const withId = { ...item, id: this.nextId++ } as TranscriptItem;
    this.set({ transcript: [...this.state.transcript, withId] });
  }

  /**
   * Append a batch of pre-built transcript items (no `id` yet) in one update.
   * Used by /resume to replay a saved conversation into the live transcript:
   * each item is stamped with a fresh id and the whole batch lands as a single
   * re-render, so Ink's <Static> prints them once into scrollback (the user can
   * then scroll up through the restored history). This touches no LLM and costs
   * no tokens — it only re-renders already-known messages.
   */
  loadTranscript(items: Array<Omit<TranscriptItem, "id">>): void {
    if (items.length === 0) return;
    const withIds = items.map((it) => ({ ...it, id: this.nextId++ }) as TranscriptItem);
    this.set({ transcript: [...this.state.transcript, ...withIds] });
  }

  // --- mutators used by the REPL orchestration ---

  addUserMessage(text: string): void {
    this.push({ kind: "user", text } as TranscriptItem);
  }

  addNotice(text: string): void {
    this.push({ kind: "notice", text } as TranscriptItem);
  }

  addLog(lines: string[]): void {
    this.push({ kind: "log", lines } as TranscriptItem);
  }

  /**
   * Live sub-agent activity line (e.g. a Task's nested Read). Pushed as a
   * dim notice so the user sees files being read *as it happens*, instead of
   * the whole batch landing at once when the Task finishes.
   */
  addSubAgentActivity(text: string): void {
    this.push({ kind: "notice", text } as TranscriptItem);
  }

  setBusy(busy: boolean): void {
    this.set({ busy });
  }

  /** Mirror the type-ahead queue's length (status-bar "queued N" badge). */
  setQueuedInputs(n: number): void {
    this.set({ queuedInputs: Math.max(0, n) });
  }

  setSpinner(mode: SpinnerMode): void {
    this.set({ spinner: mode, spinnerActivityAt: Date.now() });
  }

  setSpinnerTokens(n: number): void {
    this.set({ spinnerTokens: n, spinnerActivityAt: Date.now() });
  }

  /** Mark the start of a turn (resets the elapsed clock + stall baseline). */
  startTurnClock(): void {
    this.set({ turnStartedAt: Date.now(), spinnerActivityAt: Date.now() });
  }

  /** Stop the elapsed clock (turn finished/aborted). */
  stopTurnClock(): void {
    this.set({ turnStartedAt: 0 });
  }

  /** Append streamed assistant text to the live region. */
  appendStreaming(delta: string): void {
    this.set({ streamingText: this.state.streamingText + delta });
  }

  /**
   * Append streamed text AND update the live token counter in a single emit.
   * The coalescing producer (run.tsx) calls this once per flush frame (~30fps)
   * instead of once per delta, so a fast stream re-renders at a steady cadence.
   */
  appendStreamingWithTokens(delta: string, tokens: number): void {
    this.set({
      streamingText: this.state.streamingText + delta,
      spinnerTokens: Math.max(this.state.spinnerTokens, tokens),
      spinnerActivityAt: Date.now(),
    });
  }

  /** Commit the streamed text as a finished assistant transcript item. */
  commitStreaming(): void {
    const text = this.state.streamingText.trim();
    if (text) this.push({ kind: "assistant", text } as TranscriptItem);
    this.set({ streamingText: "" });
  }

  /** Append streamed thinking content to the live region. */
  appendThinking(delta: string): void {
    this.set({ streamingThinking: this.state.streamingThinking + delta });
  }

  /**
   * Commit streamed thinking as a finished transcript item. P0-2: renders
   * COLLAPSED (one dim line — "✻ Thought for Ns · M lines"); the full text
   * stays on the item for the transcript viewer (Ctrl+O). `seconds` is the
   * reasoning duration when known; omit it to hide the duration.
   */
  commitThinking(seconds?: number): void {
    const text = this.state.streamingThinking.trim();
    if (text) this.push({ kind: "thinking_text", text, seconds } as TranscriptItem);
    this.set({ streamingThinking: "" });
  }

  /** Replace the live todo list (called on every Todo tool result). */
  setTodos(todos: TodoDisplayItem[]): void {
    this.set({ todos });
  }

  addThought(seconds: number): void {
    this.push({ kind: "thought", seconds } as TranscriptItem);
  }

  /** Mark a tool as started (shown live in the active region with its clock). */
  startTool(name: string, detail: string, id?: string): void {
    const tool: ActiveTool = {
      id: id ?? `${name}:${this.nextId++}`,
      name,
      detail,
      startedAt: Date.now(),
    };
    this.set({ activeTools: [...this.state.activeTools, tool] });
  }

  /**
   * Commit a finished tool result to the transcript and clear it from the
   * active list. Matches by `id` when given; otherwise removes the first
   * active tool with the same name (back-compat for callers without ids).
   */
  finishTool(result: ToolExecutionResult, detail: string, id?: string): void {
    this.push({
      kind: "tool",
      name: result.toolName,
      detail,
      result,
    } as TranscriptItem);

    let removed = false;
    const remaining = this.state.activeTools.filter((t) => {
      if (removed) return true;
      const match = id !== undefined ? t.id === id : t.name === result.toolName;
      if (match) {
        removed = true;
        return false;
      }
      return true;
    });
    this.set({ activeTools: remaining });
  }

  /**
   * Record one API call's usage. `tokensIn/Out` accumulate session-wide;
   * `contextUsed` is the caller's reconciled "how full is the window after
   * this call" estimate (Anthropic input excludes cache tokens, OpenAI's
   * prompt_tokens already includes them — run.tsx reconciles). The fallback
   * sum assumes split cache reporting, so prefer passing the explicit value.
   * Crossing a gauge threshold fires a one-shot toast so compaction being
   * imminent is announced, not just recolored.
   */
  addUsage(
    inTok: number,
    outTok: number,
    cache?: { read?: number; creation?: number },
    contextUsed?: number,
  ): void {
    const read = cache?.read ?? 0;
    const used = contextUsed ?? inTok + outTok + read + (cache?.creation ?? 0);
    const prevPct =
      this.state.contextLimit > 0 ? this.state.contextUsed / this.state.contextLimit : 0;
    const nextPct = this.state.contextLimit > 0 ? used / this.state.contextLimit : 0;
    this.set({
      tokensIn: this.state.tokensIn + inTok,
      tokensOut: this.state.tokensOut + outTok,
      cacheReadTokens: this.state.cacheReadTokens + read,
      contextUsed: used,
    });
    if (this.state.contextLimit <= 0) return;
    if (nextPct >= CTX_CRITICAL_PCT && prevPct < CTX_CRITICAL_PCT) {
      this.showToast(t("ui.ctx.critical", { pct: Math.floor(nextPct * 100) }), 3000);
    } else if (nextPct >= CTX_WARN_PCT && prevPct < CTX_WARN_PCT) {
      this.showToast(t("ui.ctx.warn", { pct: Math.floor(nextPct * 100) }), 3000);
    }
  }

  /** Set the context-window size for the gauge (0 = unknown → gauge hidden). */
  setContextLimit(limit: number): void {
    this.set({ contextLimit: Math.max(0, limit) });
  }

  /**
   * Append a full-output copy of a completed tool card (ctrl+r handler). Ink's
   * <Static> is write-once: an already-printed collapsed card can't be
   * re-rendered in place, so "expanding" appends a sibling card with the same
   * result rendered expanded. Idempotent — if this source item already has a
   * copy, or the item itself is a copy, nothing is appended.
   * Returns true when a copy landed.
   */
  expandTool(id: number): boolean {
    const src = this.state.transcript.find((t) => t.id === id);
    if (src?.kind !== "tool" || !src.result || src.expanded) return false;
    const alreadyExpanded = this.state.transcript.some(
      (t) => t.kind === "tool" && t.expandedOf === id,
    );
    if (alreadyExpanded) return false;
    this.push({
      kind: "tool",
      name: src.name,
      detail: src.detail,
      result: src.result,
      expanded: true,
      expandedOf: id,
    } as TranscriptItem);
    return true;
  }

  // --- overlays (return promises the orchestration awaits) ---

  askPermission(
    header: string,
    detail?: string,
    riskHint?: string,
    alwaysLabel?: string,
  ): Promise<"yes" | "always" | "no"> {
    return new Promise((resolve) => {
      this.openOverlay({
        kind: "permission",
        header,
        detail,
        riskHint,
        alwaysLabel,
        resolve: (choice) => {
          this.set({ overlay: null });
          resolve(choice);
        },
      });
    });
  }

  askQuestion(
    header: string,
    question: string,
    options: Array<{ label: string; description?: string }>,
    multiSelect: boolean,
  ): Promise<string[] | null> {
    return new Promise((resolve) => {
      this.openOverlay({
        kind: "question",
        header,
        question,
        options,
        multiSelect,
        resolve: (labels) => {
          this.set({ overlay: null });
          resolve(labels);
        },
      });
    });
  }

  /** Open the interactive /effort slider; resolves with the chosen tier or null. */
  askEffort(current: EffortLevel): Promise<EffortLevel | null> {
    return new Promise((resolve) => {
      this.openOverlay({
        kind: "effort",
        current,
        resolve: (level) => {
          this.set({ overlay: null });
          resolve(level);
        },
      });
    });
  }

  /**
   * Open the /resume session picker; resolves with the chosen session id, or
   * null if the user cancelled (Esc). The overlay takes over input until the
   * user selects or cancels — like the permission/question/effort overlays.
   */
  pickSession(sessions: SessionPickerItem[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.openOverlay({
        kind: "sessionPicker",
        sessions,
        resolve: (sessionId) => {
          this.set({ overlay: null });
          resolve(sessionId);
        },
      });
    });
  }

  /**
   * Open the /provider profile picker; resolves with the chosen profile name,
   * or null if the user cancelled (Esc). Switching mutates the live ModelConfig
   * in place — no LLM call, applies to the next turn.
   */
  pickProvider(profiles: ProviderPickerItem[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.openOverlay({
        kind: "providerPicker",
        profiles,
        resolve: (name) => {
          this.set({ overlay: null });
          resolve(name);
        },
      });
    });
  }

  getPermissionMode(): PermissionMode {
    return this.state.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.set({ permissionMode: mode });
  }

  /**
   * Show a transient toast message. It auto-clears after `durationMs` (default
   * 2000 ms). Subsequent calls replace any pending toast.
   */
  showToast(message: string, durationMs = 2000): void {
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this.set({ toast: message });
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null;
      if (this.state.toast === message) this.set({ toast: null });
    }, durationMs);
  }

  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  cyclePermissionMode(): PermissionMode {
    const mode = nextPermissionMode(this.state.permissionMode);
    this.set({ permissionMode: mode });
    // Toast removed - mode is visible in the status bar
    return mode;
  }

  setShowHelp(show: boolean): void {
    this.set({ showHelp: show });
  }

  /** Mirror the InputBox's draft (see StoreState.draft). */
  setDraft(draft: { text: string; cursor: number }): void {
    const cur = this.state.draft;
    if (cur.text === draft.text && cur.cursor === draft.cursor) return;
    this.set({ draft });
  }

  /**
   * Open an overlay. Overlays own the whole screen and keyboard: the review
   * pager (PgUp) does NOT render the interaction region, so an overlay
   * arriving while reviewing would never mount and its resolve() promise
   * would hang — the agent loop stalls until the user happens to leave the
   * viewer. Any overlay therefore exits review mode first.
   */
  private openOverlay(overlay: Overlay): void {
    this.set({ overlay, reviewing: false });
  }

  /** Set the input history (e.g. after loading from a session). */
  setInputHistory(history: string[]): void {
    this.set({ inputHistory: history.slice(-100) }); // Keep max 100 items
  }

  /** Enter/leave transcript review mode (PgUp / Esc). */
  setReviewing(on: boolean): void {
    this.set({ reviewing: on });
  }

  /**
   * P0-3: bulk-replace the transcript (rewind) — clears all items and bumps
   * the epoch so the <Static> region remounts (see transcriptEpoch). Callers
   * follow up with loadTranscript() to replay the surviving history.
   */
  resetTranscript(): void {
    this.set({ transcript: [], transcriptEpoch: this.state.transcriptEpoch + 1 });
  }

  /**
   * P0-4: show a live retry countdown ("retrying in Ns · attempt a/m"). Owns
   * a 1s tick that decrements `secondsLeft`; auto-clears at 0. Replaced by a
   * subsequent call (the newest backoff wins).
   */
  showRetry(reason: string, attempt: number, max: number, delayMs: number): void {
    if (this._retryTimer !== null) clearInterval(this._retryTimer);
    this.set({
      retryStatus: {
        reason,
        attempt,
        max,
        secondsLeft: Math.max(1, Math.ceil(delayMs / 1000)),
      },
    });
    this._retryTimer = setInterval(() => {
      const s = this.state.retryStatus;
      if (!s) {
        if (this._retryTimer !== null) clearInterval(this._retryTimer);
        this._retryTimer = null;
        return;
      }
      // Hold at 0 rather than auto-clearing: the countdown ends when the
      // backoff SLEEP ends, but the retry request is still in flight — the
      // line should say "retrying now" until the retried call's first event
      // (or the turn's end) clears it, both in run.tsx.
      if (s.secondsLeft > 0) {
        this.set({ retryStatus: { ...s, secondsLeft: s.secondsLeft - 1 } });
      }
    }, 1000);
  }

  /** P0-4: clear the retry countdown (first event of the retried call). */
  clearRetry(): void {
    if (this._retryTimer !== null) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.state.retryStatus !== null) this.set({ retryStatus: null });
  }

  private _retryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * P0-3: open the Esc+Esc rewind menu; resolves with the chosen 1-based user
   * turn index, or null if cancelled (Esc). The caller performs the actual
   * message truncation + checkpoint file restore. Never displaces a live
   * overlay — replacing one would hang its resolve() promise; today the
   * InputBox (the only rewind trigger) unmounts under overlays, this guard
   * keeps that invariant from being load-bearing.
   */
  askRewind(entries: RewindEntry[]): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.state.overlay !== null) {
        resolve(null);
        return;
      }
      this.openOverlay({
        kind: "rewind",
        entries,
        resolve: (turnIndex) => {
          this.set({ overlay: null });
          resolve(turnIndex);
        },
      });
    });
  }

  /** Update the status-bar model label (e.g. after a /provider switch). */
  setModelLabel(label: string): void {
    this.set({ modelLabel: label });
  }

  /**
   * Update model id + display label together (e.g. after a /provider switch).
   * The id drives pricing / context-window lookups, so it must travel with
   * the label or the status bar keeps costing/sizing the previous model.
   */
  setModel(modelId: string, label: string): void {
    this.set({ modelId, modelLabel: label });
  }

  /**
   * Open the /help command palette; resolves with the chosen command name
   * (without the leading slash), or null if cancelled (Esc). Selecting a command
   * runs it through the normal dispatch path — the overlay is purely a picker.
   */
  pickCommand(commands: CommandPickerItem[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.openOverlay({
        kind: "commandPicker",
        commands,
        resolve: (name) => {
          this.set({ overlay: null });
          resolve(name);
        },
      });
    });
  }

  /**
   * Show a yes/no confirmation overlay; resolves with true for "yes", false
   * for "no" or cancel (Esc).
   */
  askConfirmation(header: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.openOverlay({
        kind: "confirm",
        header,
        resolve: (confirmed) => {
          this.set({ overlay: null });
          resolve(confirmed);
        },
      });
    });
  }
}
