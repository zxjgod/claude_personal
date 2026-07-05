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

import type { EffortLevel } from "./../effort.js";
import type { PermissionMode, ToolExecutionResult } from "./../types.js";

export type TranscriptItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool"; id: number; name: string; detail: string; result?: ToolExecutionResult }
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

/** A pending interactive prompt the App should overlay. */
export type Overlay =
  | {
      kind: "permission";
      header: string;
      detail?: string;
      riskHint?: string;
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
    };

export interface StoreState {
  /** Completed transcript items (rendered in <Static>, never repainted). */
  transcript: TranscriptItem[];
  /** Live assistant text currently streaming (not yet committed). */
  streamingText: string;
  /**
   * Live tool cards currently executing (not yet committed). Multiple tools
   * run concurrently (parallel-safe reads/greps), so this is a list keyed by
   * the originating tool-call id.
   */
  activeTools: ActiveTool[];
  spinner: SpinnerMode;
  /** Rough output-token counter shown next to the spinner. */
  spinnerTokens: number;
  /** Epoch ms when the current turn began (0 = no turn running). Drives the
   *  status-line elapsed clock so it survives the thinking→tool→responding
   *  phase changes within one turn. */
  turnStartedAt: number;
  /** Session-wide token totals for the status bar. */
  tokensIn: number;
  tokensOut: number;
  /** Current pending overlay, if any. */
  overlay: Overlay | null;
  /** True while the agent loop is running (input disabled). */
  busy: boolean;
  /** Current permission mode, shared by Shift+Tab, status bar, and tool checks. */
  permissionMode: PermissionMode;
  /** Model label for the status bar. */
  modelLabel: string;
  /** Transient toast message shown briefly after mode changes etc. */
  toast: string | null;
  /** Help panel visibility (triggered by "?" key). */
  showHelp: boolean;
}

type Listener = () => void;

// Coalescing window for batched notifications. A burst of mutations within one
// frame (~60fps) collapses to a single `emit()`, so a fast stream doesn't fire
// one React re-render per store write. State itself is always written
// synchronously (see `set`), so `getSnapshot` stays current regardless.
const FRAME_MS = 16;

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

  constructor(modelLabel: string, opts?: { batching?: boolean; permissionMode?: PermissionMode }) {
    this.batching = opts?.batching ?? false;
    this.state = {
      transcript: [],
      streamingText: "",
      activeTools: [],
      spinner: "idle",
      spinnerTokens: 0,
      turnStartedAt: 0,
      tokensIn: 0,
      tokensOut: 0,
      overlay: null,
      busy: false,
      permissionMode: opts?.permissionMode ?? "default",
      modelLabel,
      toast: null,
      showHelp: false,
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

  setSpinner(mode: SpinnerMode): void {
    this.set({ spinner: mode });
  }

  setSpinnerTokens(n: number): void {
    this.set({ spinnerTokens: n });
  }

  /** Mark the start of a turn (resets the elapsed clock). */
  startTurnClock(): void {
    this.set({ turnStartedAt: Date.now() });
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
    });
  }

  /** Commit the streamed text as a finished assistant transcript item. */
  commitStreaming(): void {
    const text = this.state.streamingText.trim();
    if (text) this.push({ kind: "assistant", text } as TranscriptItem);
    this.set({ streamingText: "" });
  }

  addThought(seconds: number): void {
    this.push({ kind: "thought", seconds } as TranscriptItem);
  }

  /** Mark a tool as started (shown live in the active region). */
  startTool(name: string, detail: string, id?: string): void {
    const tool: ActiveTool = { id: id ?? `${name}:${this.nextId++}`, name, detail };
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

  addUsage(inTok: number, outTok: number): void {
    this.set({ tokensIn: this.state.tokensIn + inTok, tokensOut: this.state.tokensOut + outTok });
  }

  // --- overlays (return promises the orchestration awaits) ---

  askPermission(
    header: string,
    detail?: string,
    riskHint?: string,
  ): Promise<"yes" | "always" | "no"> {
    return new Promise((resolve) => {
      this.set({
        overlay: {
          kind: "permission",
          header,
          detail,
          riskHint,
          resolve: (choice) => {
            this.set({ overlay: null });
            resolve(choice);
          },
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
      this.set({
        overlay: {
          kind: "question",
          header,
          question,
          options,
          multiSelect,
          resolve: (labels) => {
            this.set({ overlay: null });
            resolve(labels);
          },
        },
      });
    });
  }

  /** Open the interactive /effort slider; resolves with the chosen tier or null. */
  askEffort(current: EffortLevel): Promise<EffortLevel | null> {
    return new Promise((resolve) => {
      this.set({
        overlay: {
          kind: "effort",
          current,
          resolve: (level) => {
            this.set({ overlay: null });
            resolve(level);
          },
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
      this.set({
        overlay: {
          kind: "sessionPicker",
          sessions,
          resolve: (sessionId) => {
            this.set({ overlay: null });
            resolve(sessionId);
          },
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
      this.set({
        overlay: {
          kind: "providerPicker",
          profiles,
          resolve: (name) => {
            this.set({ overlay: null });
            resolve(name);
          },
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
    this.showToast(`Permission mode: ${mode}`);
    return mode;
  }

  setShowHelp(show: boolean): void {
    this.set({ showHelp: show });
  }

  /** Update the status-bar model label (e.g. after a /provider switch). */
  setModelLabel(label: string): void {
    this.set({ modelLabel: label });
  }

  /**
   * Open the /help command palette; resolves with the chosen command name
   * (without the leading slash), or null if cancelled (Esc). Selecting a command
   * runs it through the normal dispatch path — the overlay is purely a picker.
   */
  pickCommand(commands: CommandPickerItem[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.set({
        overlay: {
          kind: "commandPicker",
          commands,
          resolve: (name) => {
            this.set({ overlay: null });
            resolve(name);
          },
        },
      });
    });
  }
}
