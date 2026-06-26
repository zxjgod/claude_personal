// ============================================================
// Core Types for Claude Code Replica
// ============================================================

// --- Messages (Internal Format) ---

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemMessage;

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

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// --- Tool System ---

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
}

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  permissionMode: PermissionMode;
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
  | "plan";

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

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
  /** Whether this tool only reads (auto-approved) */
  isReadOnly(): boolean;
  /** Whether this tool requires an interactive approval prompt in default mode. */
  requiresApproval?(): boolean;
  /** Whether this tool can run concurrently */
  isConcurrencySafe(): boolean;
  /** Main execution */
  call(input: T, context: ToolContext): Promise<ToolResult>;
  /** Permission check */
  checkPermissions(
    input: T,
    context: ToolContext,
  ): Promise<PermissionResult>;
  /** Format result for LLM */
  formatResult(result: ToolResult): string;
}

// --- Model Config ---

export interface ModelConfig {
  provider: "anthropic" | "openai" | "deepseek" | "qwen" | "moonshot" | "zhipu" | "custom";
  model: string;
  apiKey: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
  options?: Record<string, unknown>;
}

// --- Stream Events ---

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

export interface ToolExecutionResult {
  toolName: string;
  result?: ToolResult;
  error?: string;
  formatted: string;
  durationMs?: number;
}

export interface LoopOptions {
  maxTurns?: number;
  autoCompactThreshold?: number;
  systemPrompt: string;
  abortSignal?: AbortSignal;
  /** Partial context to thread into each tool call (sessionId, workspaceRoot, permissionMode). */
  toolContext?: Partial<ToolContext>;
  /** Callback to prompt the user when a tool requires confirmation. */
  askUser?: AskUserFn;
  /** Optional hook registry to intercept tool calls (PreToolUse/PostToolUse). */
  hooks?: HookRunner;
  /**
   * Enable speculative tool prefetch (12.2). On by default (M15.2); callers
   * disable it via --no-speculation / CCR_SPECULATION=0. Only read-only +
   * concurrency-safe tools are ever speculated, so it is safe to leave on.
   */
  speculation?: boolean;
}

/** Structural type for the hook registry — see src/hooks.ts. */
export interface HookRunner {
  runPre(payload: {
    toolName: string;
    input: Record<string, unknown>;
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
}

/** Prompts the user to approve a destructive/dangerous tool call. */
export type AskUserFn = (
  tool: Tool,
  input: Record<string, unknown>,
  riskHint?: string,
) => Promise<boolean>;

// --- Model Caller ---

export type ModelCaller = (
  messages: Message[],
  tools: Tool[],
  systemPrompt: string,
  config: ModelConfig,
  abortSignal?: AbortSignal,
) => AsyncGenerator<StreamEvent>;
