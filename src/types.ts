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
  /**
   * Verbatim thinking blocks produced in this turn (Anthropic only). The API
   * requires these — `signature` included — to be passed back unchanged at the
   * START of the assistant content when interleaved thinking is enabled;
   * dropping them 400s the next request after a tool-use turn. Absent on
   * OpenAI-compatible paths.
   */
  thinking?: Array<ThinkingBlock | RedactedThinkingBlock>;
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

// --- Thinking Blocks (Anthropic, verbatim passback) ---
// ============================================================================

/** A completed thinking block from the model; pass back unchanged. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

/** Redacted variant: encrypted payload, passed back verbatim as `data`. */
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
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

/**
 * One row of the live todo display. Shared by the Todo tool (producer, via
 * ToolResultMetadata.todos) and the TUI store (consumer) so the pinned list
 * under the spinner is always a projection of the tool's internal state.
 */
export interface TodoDisplayItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
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
  /** Background job id (M38) — set when a tool (Bash) returns a job handle. */
  jobId?: string;
  /**
   * One-line human summary for the terminal UI (e.g. "Read 200 lines",
   * "12 matches", "8 files"). Display-only — the model sees `content`, never
   * this field. Read/Grep/Glob set it so the terminal shows a compact result
   * instead of dumping the raw output; when absent, renderers fall back to a
   * folded content preview.
   */
  summary?: string;
  /** Bounded display-only snapshot for the Write result's syntax preview. */
  codePreview?: { filePath: string; text: string; totalLines: number; truncated?: boolean };
  /**
   * Display-only numbered companion to the Edit result's diff. The model-facing
   * `content` keeps the header-less diff; this carries the same changes with
   * absolute file line numbers so the TUI can draw a gutter, matching what the
   * Write preview already does above. Declared inline rather than imported from
   * tools/utils/diff to keep the core types module free of a dependency on the
   * tool layer.
   */
  diffLines?: Array<{ sign: "-" | "+"; text: string; line: number }>;
  /**
   * Structured todo list (Todo tool only). The TUI pins this under the spinner
   * as a live region; the committed tool row stays compact via `summary`.
   */
  todos?: TodoDisplayItem[];
  incomplete?: boolean;
  /**
   * Speculative-read promotion metadata (Top10 #6). Set by Read ONLY when the
   * call ran as a SpeculationCache prefetch (context.speculative): the resolved
   * path and the mtime of the version being returned. The prefetch skips
   * markRead; when the cached result is actually served to the model,
   * tool-executor promotes it into the read-before-edit tracker with these
   * values. Never set on ordinary (non-speculative) reads.
   */
  readPath?: string;
  readMtimeMs?: number;
}

/**
 * The INTERACTION surface a tool may use to reach the human.
 *
 * Grouped rather than inlined on ToolContext because it is the security-
 * critical part of that object and because it must be re-derived, never
 * blindly inherited, when a context crosses into a sub-agent. A sub-agent
 * gets a RESTRICTED approver (utils/subagent-security.ts) built from these
 * channels — if this group were part of a spread-copied context, a worker
 * would silently inherit the parent's full authority. `deriveSubContext`
 * (below) is the only sanctioned way to build a child's context, and it
 * deliberately does NOT carry these fields over.
 */
export interface ToolInteraction {
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
   * Batch C2 (ExitPlanMode): surface the agent's plan for user approval.
   * Resolves with the verdict and the (possibly editor-revised) plan text;
   * absent = non-interactive contexts where approval is impossible.
   *
   * NOTE: unlike askUser, this IS safe to inherit — a plan-mode overlay is
   * only mounted when the parent's toolContext provides it, and it is part of
   * `interaction` only for cohesion. deriveSubContext drops it regardless.
   */
  requestPlanApproval?: (plan: string) => Promise<{ choice: "approve" | "reject"; plan: string }>;
}

export interface ToolContext extends ToolInteraction {
  workspaceRoot: string;
  allowedDirectories?: string[];
  sessionId: string;
  permissionMode: PermissionMode;
  /** Optional live permission-mode hooks; TUI uses these for mid-turn Shift+Tab changes. */
  getPermissionMode?: () => PermissionMode;
  setPermissionMode?: (mode: PermissionMode) => void;
  /**
   * True only while executing a SPECULATIVE prefetch (SpeculationCache,
   * Top10 #6). The result may never reach the model (a miss discards it), so
   * the execution must not satisfy conversation-level gates: Read skips
   * markRead (read-before-edit) and instead reports {readPath, readMtimeMs}
   * in metadata, which the cache-hit consumer promotes into the tracker when
   * — and only when — the content actually goes to the model.
   */
  speculative?: boolean;
  /** Optional: model config for sub-agents (Task tool) */
  modelConfig?: ModelConfig;
  /** Optional sink for nested sub-agent activity (Task tool). */
  onSubAgentProgress?: (event: SubAgentProgress) => void;
  // askUser / askUserQuestion / requestPlanApproval are inherited from
  // ToolInteraction above — see that interface for why the human-facing
  // surface is grouped and why a sub-agent must re-derive it.
  /**
   * Optional LLM-assisted permission risk classifier (M15.3). Threaded from
   * the CLI into every tool call's permission check. When present, the
   * classifier runs ONLY for tool calls the regex dangerous-pattern detector
   * already flagged — it can block outright or enrich the approval prompt
   * with a model-assessed reason. Absent in tests and when the feature is
   * disabled (--llm-perm-classifier off). See src/permissions.ts.
   */
  permissionClassifier?: PermissionClassifier;
  hooks?: HookRunner;
  /** Rules loaded from settings.json and CLI permission flags. */
  permissionPolicy?: import("./permission-policy.js").PermissionPolicy;
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
  /**
   * The loop's recoverable stash of tool-result content the context pipeline
   * trimmed or evicted (F2). The RestoreContext tool reads it to hand an
   * evicted original back to the model on demand, instead of the model having
   * to re-run the tool. Each agent loop owns its own store; absent in tests.
   */
  collapseStore?: import("./context-pipeline.js").CollapseStore;
}

/**
 * Build a SUB-AGENT's ToolContext from its parent's — an explicit allow-list,
 * not a spread.
 *
 * The spread (`{ ...context, abortSignal }`) that this replaces looked
 * equivalent but was not: it silently handed every worker the parent's
 * `getParentMessages` / `parentSystemPrompt` (making a TYPED sub-agent able to
 * fork, since Task's `canFork` is just a presence check on those two fields)
 * and the parent's `askUser` (granting full approval authority to a worker
 * that should hold a restricted approver). Both are authority leaks, and
 * neither raised an error — the worker simply had more power than intended.
 *
 * The allow-list is the contract: a worker gets the workspace, the session,
 * the permission mode, the model, and the approver its CALLER chose. Anything
 * else a future field might carry is opt-in by being named here.
 */
export function deriveSubContext(
  parent: ToolContext,
  overrides: {
    /** The restricted approver for this worker (utils/subagent-security.ts). */
    askUser?: AskUserFn;
    abortSignal?: AbortSignal;
    /** Nesting depth for fork-in-fork capping. */
    subagentDepth?: number;
    /** Session id override — a fork may run under `<parent>-agent-<ts>`. */
    sessionId?: string;
    permissionMode?: PermissionMode;
    /** Workspace override — the Agent tool isolates via a git worktree. */
    workspaceRoot?: string;
    /** Progress sink, when a worker should report into the parent's UI. */
    onSubAgentProgress?: (event: SubAgentProgress) => void;
    /** Hooks, when the worker must run under the session's hook policy. */
    hooks?: HookRunner;
  } = {},
): ToolContext {
  return {
    workspaceRoot: overrides.workspaceRoot ?? parent.workspaceRoot,
    sessionId: overrides.sessionId ?? parent.sessionId,
    permissionMode: overrides.permissionMode ?? parent.permissionMode,
    modelConfig: parent.modelConfig,
    // The caller's approver, never the parent's raw one.
    askUser: overrides.askUser,
    onSubAgentProgress: overrides.onSubAgentProgress,
    hooks: overrides.hooks,
    // The worker's own signal (a CancellationScope forked from the parent),
    // and its nesting depth. Both are per-worker facts: inheriting the
    // parent's depth would make a nested worker look shallower than it is
    // and defeat the fork-in-fork cap.
    abortSignal: overrides.abortSignal,
    subagentDepth: overrides.subagentDepth ?? 0,
    // Absent: allowedDirectories (a worker must not widen its own reach),
    // getParentMessages / parentSystemPrompt (no fork from a worker),
    // requestPlanApproval / askUserQuestion (the parent's overlays are not
    // mounted for worker turns), permissionClassifier (a rate-limited,
    // model-calling gate that does not belong on every worker call).
  };
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
  /** Terminal reason for a done event (end_turn, max_turns, model_error…). */
  reason?: string;
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
  /**
   * Session-level verdict cache. Repeated identical flagged calls (same tool +
   * same formatted action) reuse the earlier classification instead of paying
   * the model call again — the classifier sits on the tool-execution critical
   * path, so a cache hit removes a serial multi-second wait. Only definitive
   * verdicts are stored (see classifyPermissionRisk); "unavailable" results
   * stay uncached so a timeout is retried rather than remembered.
   */
  cache?: Map<string, ClassifierResult>;
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
  // #45: the dead `aliases` / `searchHint` / `interruptBehavior` metadata
  // fields were removed — nothing ever resolved aliases, no tool-search
  // consumed the hints, and no interrupt path read the behavior (Ctrl+C
  // kills in-flight calls unconditionally). Declaring unwired metadata only
  // invites false confidence (and alias collisions with real tool names).
  timeoutMs?: number;
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
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      rawArguments?: string;
    }
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
      /**
       * Final, signed thinking blocks from the completed message (Anthropic
       * only). Delivered atomically on `done` because the signature arrives
       * via `signature_delta` at the very end of the block — deltas alone
       * cannot reconstruct a passback-ready block. Absent when the model
       * produced no thinking.
       */
      thinking?: Array<ThinkingBlock | RedactedThinkingBlock>;
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
  /** Live reasoning content, dimmed display only. Distinct from the
   * `{type:"thinking"}` phase marker so consumers don't reset spinner state
   * per token. */
  | { type: "thinking_delta"; delta: string }
  /** Attempt boundary: the previous model call FAILED and is being retried
   * (rate limit / transient / context compaction / fallback model). Its
   * partial stream never entered model history, so UI consumers must DISCARD
   * buffered streaming text — appending the retry's output to it would fork
   * the transcript from the real conversation. */
  | {
      type: "model_retry" /** M1: when set, the retry CONTINUES from this many chars of committed partial text instead of regenerating. */;
      continuation?: number;
    }
  | { type: "compacting" }
  | {
      type: "compacted";
      summary: string;
      /** Batch C4: messages folded by this compaction (official "Summarized N
       *  messages" line). Absent when unknown. */
      messages?: number;
    }
  /** The fallback chain switched models mid-session (Top10 follow-up E5).
   *  A dedicated event instead of reusing `compacted` — nothing was
   *  compacted, and UI consumers render this as a model notice. */
  | { type: "model_switched"; from: string; to: string }
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
  /** Internal: forked agents inherit an already-enriched parent prompt verbatim. */
  applyEffortInstruction?: boolean;
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
   * Optional cheap "fast model" side channel (M5) for high-volume,
   * judgement-light model work on the loop's critical path — currently the
   * autoCompact summary (with mandatory degrade-to-main on failure). Built by
   * the CLI from CCR_FAST_MODEL; absent in tests/sub-agents.
   */
  fastModel?: import("./auto-compact.js").FastModelOption;
  /**
   * Queued user input provider (M36, kernel §9). Called at each turn boundary
   * (and before the loop would otherwise complete); any returned items are
   * injected as user messages and the loop continues working on them instead of
   * ending — type-ahead that's queued, not discarded. Returns [] when nothing is
   * queued. Injected by the CLI/TUI; absent in tests/sub-agents (no-op then).
   *
   * Each item is either a plain string (wrapped into a text block) or
   * pre-built ContentBlock[] (the TUI expands paste/image chips at drain time
   * so chips consumed here can't leak into later messages). May be async: the
   * TUI's drain executes queued `!cmd` shell lines at the injection point.
   */
  drainQueuedInput?: () => (string | ContentBlock[])[] | Promise<(string | ContentBlock[])[]>;
  /**
   * Background completion notification provider (M41). Drained at turn
   * boundaries: each returned <task_notification> block is injected as a user
   * message, so the model learns a background job/sub-agent/teammate message
   * settled without polling. Notification-driven turn continuations are capped
   * (see agent-loop) so a self-restarting background job cannot loop forever.
   * Returns [] when nothing is pending. Injected by the CLI/TUI.
   */
  drainNotifications?: () => string[];
  /**
   * Enable speculative tool prefetch (12.2). On by default (M15.2); callers
   * disable it via --no-speculation / CCR_SPECULATION=0. Only read-only +
   * concurrency-safe tools are ever speculated, so it is safe to leave on.
   */
  speculation?: boolean;
  /**
   * P0-4: fired just before a retryable model error (429 / transient network)
   * enters its backoff sleep, so the UI can show a live countdown
   * ("retrying in Ns · attempt N/M") instead of hanging silently. The loop
   * already handles the retry itself; this is display-only.
   */
  onModelRetry?: (info: {
    kind: "rate_limit" | "transient";
    attempt: number;
    max: number;
    delayMs: number;
  }) => void;
}

/** Structural type for the hook registry — see src/hooks.ts. */
export interface HookRunner {
  runPre(payload: {
    toolName: string;
    input: Record<string, unknown>;
    /** True for SpeculationCache background prefetches (see hooks.ts). */
    speculative?: boolean;
  }): Promise<{
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
  runEvent?(event: string, payload: Record<string, unknown>): Promise<void>;
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
