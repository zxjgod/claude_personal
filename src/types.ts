// ============================================================
// Core Types for Claude Code Replica
// ============================================================
//
// This file contains all core types for the project. When splitting:
//   - messages.ts: Message, ContentBlock, ToolCall
//   - tools.ts: Tool, ToolResult, ToolContext, ToolExecutionResult
//   - events.ts: StreamEvent, LoopEvent, Terminal
//   - permission.ts: PermissionMode, ClassifierResult, PermissionResult
//   - model.ts: ModelConfig, ModelCaller
//   - index.ts: Re-exports from all sub-modules
//
// NOTE: Cross-module dependencies create circular reference challenges.
// When splitting, use 'import type' for type-only imports and restructure
// shared base types to avoid circular dependencies.
// ============================================================

import type { ClassifierRules } from "./classifier-rules.js";

// ============================================================================
// SECTION 1: Messages (Internal Format)
// ============================================================================

export type Message = UserMessage | AssistantMessage | ToolResultMessage | SystemMessage;

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  name?: string;
  content: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

// --- Content Blocks ---
// ============================================================================

export type ContentBlock = TextContent | ImageContent;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type: string;
    data?: string;
    url?: string;
  };
}

// --- Tool Calls ---
// ============================================================================

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// --- Tool System ---
// ============================================================================

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolResult {
  content: string;
  error?: string;
  truncated?: boolean;
  metadata?: ToolResultMetadata;
  /**
   * Optional image blocks produced by the tool (e.g. Read on a PNG/PDF).
   * The agent loop injects these into the conversation as a follow-up user
   * message, since both providers accept images only in user content.
   */
  images?: ImageContent[];
}

export interface ToolResultMetadata {
  durationMs?: number;
  linesRead?: number;
  fileSize?: number;
  exitCode?: number | null;
  /** True when the tool was interrupted by an abort (Ctrl+C). */
  aborted?: boolean;
  /** True when the command exceeded its timeout and was force-killed. */
  timedOut?: boolean;
  /**
   * One-line human summary for the terminal UI (e.g. "Read 200 lines",
   * "12 matches", "8 files"). Display-only — the model sees `content`, never
   * this field. Read/Grep/Glob set it so the terminal shows a compact result
   * instead of dumping the raw output; when absent, renderers fall back to a
   * folded content preview.
   */
  summary?: string;
}

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  permissionMode: PermissionMode;
  /** Optional live permission-mode hooks; TUI uses these for mid-turn Shift+Tab changes. */
  getPermissionMode?: () => PermissionMode;
  setPermissionMode?: (mode: PermissionMode) => void;
  /** Optional: model config for sub-agents (Task tool) */
  modelConfig?: ModelConfig;
  /** Optional sink for nested sub-agent activity (Task tool). */
  onSubAgentProgress?: (event: SubAgentProgress) => void;
  /**
   * The parent loop's interactive approver, threaded into sub-agent loops so a
   * sub-agent's destructive tool calls (bash/write/edit) still surface to the
   * user for confirmation. Without this, sub-agents fall back to the loop's
   * auto-approving default and can run bash/write unattended — a real safety
   * gap. Optional: absent in tests/plan mode (sub-loops then use their own
   * default approver, but plan mode hard-blocks destructive tools anyway).
   */
  askUser?: AskUserFn;
  /**
   * Ask the user a structured single/multi-select question and block for the
   * answer. Injected by the CLI; absent for sub-agents/tests (tools should
   * degrade gracefully when it's undefined). Returns the selected option
   * label(s), or null if the user cancelled.
   */
  askUserQuestion?: (question: UserQuestion) => Promise<string[] | null>;
  /**
   * Optional LLM-assisted permission risk classifier (M15.3). Threaded from
   * the CLI into every tool call's permission check. When present, the
   * classifier runs ONLY for tool calls the regex dangerous-pattern detector
   * already flagged — it can block outright or enrich the approval prompt
   * with a model-assessed reason. Absent in tests and when the feature is
   * disabled (--llm-perm-classifier off). See src/permissions.ts.
   */
  permissionClassifier?: PermissionClassifier;
  /**
   * The current turn's AbortSignal (set when the agent loop is created). Tools
   * that spawn long-running subprocesses (Bash, Grep, ...) should observe it
   * so Ctrl+C cancels not just the LLM stream but also in-flight tool work.
   * Absent in tests and sub-agents spawned without an explicit signal.
   */
  abortSignal?: AbortSignal;
  /**
   * Fork support (M35, kernel §6 mechanism A). Returns a snapshot copy of the
   * parent loop's current message history so the Task tool can fork the current
   * agent (Agent tool with no subagent_type) — the fork inherits context. The
   * loop wires this as a closure over its (reassigned) messages local; absent in
   * tests/sub-agents, in which case fork mode is unavailable and Task falls back
   * to a typed sub-agent.
   */
  getParentMessages?: () => Message[];
  /**
   * The parent loop's system prompt (M35, kernel §6). A fork reuses this verbatim
   * — same prompt prefix + same model — so it SHARES the parent's prompt cache
   * (the kernel's reason a fork must not swap model). Absent → fork unavailable.
   */
  parentSystemPrompt?: string;
  /**
   * Nesting depth of the current agent loop (0 = the main agent). Threaded so
   * the Task tool can cap fork-in-fork recursion, which would otherwise grow
   * unbounded (each fork inherits the full tool set, including Task itself).
   */
  subagentDepth?: number;
}

/** A structured question the model can pose to the user (AskUserQuestion). */
export interface UserQuestion {
  /** The question text. */
  question: string;
  /** Short header/category label. */
  header: string;
  /** Selectable options. */
  options: Array<{ label: string; description?: string }>;
  /** Allow choosing more than one option. */
  multiSelect?: boolean;
}

export interface SubAgentProgress {
  subagentName: string;
  phase: "tool_use" | "tool_results" | "done";
  toolName?: string;
  input?: Record<string, unknown>;
  results?: ToolExecutionResult[];
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto"
  | "dontAsk";

/**
 * Why a permission decision was reached (kernel §4 decisionReason union).
 * Used for logging/UI, but `safetyCheck` has special standing: decisions tagged
 * `safetyCheck` are made by the bypass-immune safety floor (blocked paths /
 * dangerous patterns) which runs BEFORE the bypassPermissions short-circuit —
 * so even YOLO mode cannot clear them.
 */
export type PermissionDecisionReason = "rule" | "mode" | "hook" | "classifier" | "safetyCheck";

export type PermissionResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Model-assessed risk classification of a flagged tool call (M15.3,
 * yoloClassifier-style). See src/permissions.ts::classifyPermissionRisk.
 *   - block=true: refuse before prompting.
 *   - reason set: replace the terse regex hint with a clearer model reason.
 *   - unavailable=true: classifier couldn't respond — caller defers (fail-safe).
 */
export interface ClassifierResult {
  block: boolean;
  reason?: string;
  unavailable?: boolean;
  /**
   * The raw classifier verdict (BLOCK / CONFIRM / ALLOW), when it parsed. Auto
   * mode needs this to distinguish CONFIRM ("human should decide" — no human in
   * auto mode, so deny) from ALLOW ("benign over-flag" — safe to proceed).
   */
  verdict?: "BLOCK" | "CONFIRM" | "ALLOW";
}

/**
 * Context the permission classifier needs to make a call. Constructed once per
 * session (in cli.ts) and threaded through ToolContext → checkPermission.
 */
export interface PermissionClassifier {
  callModel: ModelCaller;
  modelConfig: ModelConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional rule layer (allow/soft_deny/environment) driving the classifier. */
  rules?: ClassifierRules;
}

export interface Tool<T extends ToolInput = ToolInput> {
  /** Unique tool name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Description for the LLM system prompt */
  promptDescription: string;
  /** JSON Schema for input validation */
  inputSchema: {
    type: "object";
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        enum?: string[];
        default?: unknown;
        /** For array properties: the schema of each item. */
        items?: Record<string, unknown>;
        [key: string]: unknown;
      }
    >;
    required: string[];
  };
  /** Whether this tool is currently enabled */
  isEnabled(): boolean;
  /**
   * Whether this tool only reads (auto-approved). Takes the call's input so the
   * decision can be data-driven (M29): e.g. Bash is read-only for `cat` but not
   * `rm`. Called without input in a few static contexts (UI listings) — return
   * the most conservative answer (treat as mutating) when input is absent.
   */
  isReadOnly(input?: T): boolean;
  /** Whether this tool requires an interactive approval prompt in default mode. */
  requiresApproval?(): boolean;
  /**
   * Whether this tool can run concurrently given THIS input (M29). Bash sets
   * this equal to isReadOnly, so read-only commands parallelize and mutating
   * ones serialize. Absent input → conservative (not safe).
   */
  isConcurrencySafe(input?: T): boolean;
  /**
   * Semantic input validation (M28). Runs after JSON.parse but before any
   * side effect or permission check. Should THROW (typically an
   * InputValidationError) when the input is malformed, and otherwise return
   * the sanitized input — strict Zod schemas strip unknown keys the model may
   * have injected. Optional: tools without a schema skip this layer. This is
   * distinct from checkPermissions (operation policy) and the central
   * permission system (mode/rule/safety floor).
   */
  validateInput?(input: Record<string, unknown>): T;
  /**
   * Whether this tool mutates state irreversibly given THIS input (M28). Used
   * by the permission UI / classifier to flag higher-risk calls. Fail-closed:
   * defaults to "not read-only" when unspecified.
   */
  isDestructive?(input: T): boolean;
  /** Alternate names the model may use for this tool (e.g. legacy aliases). */
  aliases?: string[];
  /** Short hint surfaced by the tool-search tool to help the model pick this. */
  searchHint?: string;
  /**
   * What should happen to an in-flight call when the user interrupts (Ctrl+C).
   * "kill" = abort immediately (default for side-effecting work like Bash),
   * "wait" = let it finish (cheap read-only work not worth tearing down).
   */
  interruptBehavior?: "kill" | "wait";
  /** Extract the primary filesystem path this call touches, if any (for UI/safety). */
  getPath?(input: T): string | undefined;
  /**
   * Soft cap on the model-facing result size in chars (M30). When the formatted
   * result exceeds this, the agent loop spills the full text to a workspace file
   * and hands the model a preview + path instead of the whole thing — bounding
   * the context window without losing data (the UI still renders the full
   * result). Defaults to DEFAULT_MAX_RESULT_CHARS; Read sets it to Infinity so a
   * Read result never spills (which would loop "Read → spill → Read").
   */
  maxResultSizeChars?: number;
  /** Main execution */
  call(input: T, context: ToolContext): Promise<ToolResult>;
  /** Permission check */
  checkPermissions(input: T, context: ToolContext): Promise<PermissionResult>;
  /** Format result for LLM */
  formatResult(result: ToolResult): string;
}

// --- Model Config ---
// ============================================================================

export interface ModelConfig {
  provider: "anthropic" | "openai" | "deepseek" | "qwen" | "moonshot" | "zhipu" | "custom";
  model: string;
  apiKey: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
  options?: Record<string, unknown>;
  /**
   * Optional fallback model chain (same provider, different model names). When
   * the primary model fails with a model-specific error (5xx / 404 / unknown),
   * the loop switches to the next entry and retries, up to the chain's length.
   * Populated from LLM_FALLBACK_MODELS (comma-separated).
   */
  fallbackModels?: string[];
}

// --- Stream Events ---
// ============================================================================

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; delta?: string }
  | {
      type: "done";
      usage: {
        input_tokens: number;
        output_tokens: number;
        /** Tokens served from the prompt cache (12.3). */
        cache_read_input_tokens?: number;
        /** Tokens written to the prompt cache this call (12.3). */
        cache_creation_input_tokens?: number;
      };
      finish_reason: string;
    }
  | { type: "error"; error: Error };

// --- Agent Loop ---
// ============================================================================

export type LoopEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; result: ToolExecutionResult }
  | { type: "tool_results"; results: ToolExecutionResult[] }
  | { type: "thinking" }
  | { type: "compacting" }
  | { type: "compacted"; summary: string }
  | {
      type: "usage";
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }
  | { type: "error"; error: unknown }
  | {
      type: "done";
      finishReason: "end_turn" | "max_turns";
      turns: number;
      message?: string;
      /**
       * Speculation cost/benefit snapshot, attached when speculation was enabled
       * for this loop run (M15.2). Absent when speculation is off, so existing
       * consumers that only read finishReason/turns are unaffected.
       */
      speculation?: {
        hits: number;
        misses: number;
        prefetched: number;
        wasted: number;
        hitRate: number;
      };
    }
  | { type: "aborted"; reason: string };

/**
 * Typed terminal reason the agent loop RETURNS (kernel §8). Distinct from the
 * yielded `done`/`aborted`/`error` events (which UI consumers read): a caller
 * that drives the loop with `const t = yield* agentLoop(...)` gets this typed
 * exit code and branches on `t.reason` without scanning the event stream.
 *
 *   completed          — model produced a final answer with no tool calls
 *   max_turns          — hit the maxTurns ceiling
 *   aborted_streaming  — abort fired before/while the model was streaming
 *   aborted_tools      — abort fired while/after tools ran this turn
 *   model_error        — unrecoverable model/transport error
 *   prompt_too_long    — context exceeded the model limit and compaction failed
 *   blocking_limit     — hard context limit hit with auto-compaction disabled
 *   stop_hook_prevented— a stop hook hard-stopped continuation
 *   hook_stopped       — a hook aborted the run
 *   image_error        — an image block could not be processed
 *   aborted_interrupt  — a SOFT interrupt (user typed mid-turn); queued input is
 *                        preserved so the caller resumes with it (M36/kernel §9)
 */
export type TerminalReason =
  | "completed"
  | "max_turns"
  | "aborted_streaming"
  | "aborted_tools"
  | "aborted_interrupt"
  | "model_error"
  | "prompt_too_long"
  | "blocking_limit"
  | "stop_hook_prevented"
  | "hook_stopped"
  | "image_error";

export interface Terminal {
  reason: TerminalReason;
  /** Turns completed when the loop exited. */
  turns: number;
  /** Underlying error for model_error / prompt_too_long / blocking_limit. */
  error?: unknown;
}

export interface ToolExecutionResult {
  toolName: string;
  result?: ToolResult;
  error?: string;
  formatted: string;
  /**
   * P0-1 Fix: modelContent has been removed. The full `formatted` result is now
   * stored in message history; truncation for the API call happens in the
   * adapters (llm-adapter / anthropic-adapter) via truncateToolResult().
   * @deprecated Use `formatted` directly.
   */
  modelContent?: string;
  durationMs?: number;
  /**
   * True when this result represents a failure (M28). The agent loop wraps the
   * model-facing tool content in <tool_use_error>…</tool_use_error> when set,
   * so the model reliably distinguishes errors from ordinary output. The UI
   * still renders `formatted` verbatim (no envelope), keeping terminal output
   * clean.
   */
  isError?: boolean;
}

export interface LoopOptions {
  maxTurns?: number;
  autoCompactThreshold?: number;
  /**
   * Hard context ceiling in tokens (M31). When autoCompact is disabled
   * (autoCompactThreshold = Infinity) and the prepared context still exceeds
   * this, the loop exits with a `blocking_limit` terminal instead of sending an
   * oversized request — leaving room for a manual /compact. Default 200_000.
   */
  contextHardLimit?: number;
  systemPrompt: string;
  abortSignal?: AbortSignal;
  /** Partial context to thread into each tool call (sessionId, workspaceRoot, permissionMode). */
  toolContext?: Partial<ToolContext>;
  /** Callback to prompt the user when a tool requires confirmation. */
  askUser?: AskUserFn;
  /** Optional hook registry to intercept tool calls (PreToolUse/PostToolUse). */
  hooks?: HookRunner;
  /**
   * Turn output budget for auto-continuation (M32, kernel §7). When > 0 and the
   * model ends a turn with no tool calls, the loop may inject a nudge and keep
   * working until cumulative output approaches this ceiling or hits diminishing
   * returns. 0 / undefined disables it — the loop ends the turn as before.
   * Distinct from `autoCompactThreshold`/`contextHardLimit` (the context-window
   * budget). See src/query/token-budget.ts.
   */
  turnOutputBudget?: number;
  /**
   * Background prefetch provider (M36, kernel §9). Fired once at loop start with
   * the latest user text, concurrently with the first model stream. Its resolved
   * string (relevant memories / skills, as a <system-reminder>) is injected once
   * as a system message before the next model call. Returns null → nothing
   * injected. Injected by the CLI; absent in tests/sub-agents (no-op then).
   */
  prefetch?: (latestUserText: string) => Promise<string | null>;
  /**
   * Fast-model tool-batch summarizer (M36, kernel §9). After a tool batch runs,
   * the loop starts this with a compact prompt digesting that batch; the call
   * runs (on a cheap/fast model) concurrently with the NEXT model stream and is
   * consumed non-blockingly at the next turn boundary, injected as a single
   * <system-reminder> digest alongside the full results. Returns null → nothing
   * injected. Injected by the CLI; absent in tests/sub-agents (no-op then).
   * Latency hiding must never add latency — the loop never awaits this inline.
   */
  summarizeToolBatch?: (prompt: string) => Promise<string | null>;
  /**
   * Queued user input provider (M36, kernel §9). Called at each turn boundary
   * (and before the loop would otherwise complete); any returned text is
   * injected as user messages and the loop continues working on it instead of
   * ending — type-ahead that's queued, not discarded. Returns [] when nothing is
   * queued. Injected by the CLI/TUI; absent in tests/sub-agents (no-op then).
   */
  drainQueuedInput?: () => string[];
  /**
   * Enable speculative tool prefetch (12.2). On by default (M15.2); callers
   * disable it via --no-speculation / CCR_SPECULATION=0. Only read-only +
   * concurrency-safe tools are ever speculated, so it is safe to leave on.
   */
  speculation?: boolean;
}

/** Structural type for the hook registry — see src/hooks.ts. */
export interface HookRunner {
  runPre(payload: { toolName: string; input: Record<string, unknown> }): Promise<{
    block?: boolean;
    reason?: string;
    input?: Record<string, unknown>;
  }>;
  runPost(payload: {
    toolName: string;
    input: Record<string, unknown>;
    result: ToolResult;
  }): Promise<{ result?: ToolResult }>;
  /**
   * Stop hook (M32). Optional — runners predating M32 omit it and the loop
   * simply skips the stop gate. Returning `blockingError` injects a meta user
   * message and continues; `preventContinuation` hard-stops the loop.
   */
  runStop?(payload: { messages: unknown[]; stopHookActive: boolean }): Promise<{
    blockingError?: string;
    preventContinuation?: boolean;
    reason?: string;
  }>;
}

/** Prompts the user to approve a destructive/dangerous tool call. */
export type AskUserFn = (
  tool: Tool,
  input: Record<string, unknown>,
  riskHint?: string,
) => Promise<boolean>;

// --- Model Caller ---
// ============================================================================

export type ModelCaller = (
  messages: Message[],
  tools: Tool[],
  systemPrompt: string,
  config: ModelConfig,
  abortSignal?: AbortSignal,
) => AsyncGenerator<StreamEvent>;
