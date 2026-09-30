// ============================================================
// Slash Commands — types & registry (M18 directory split)
// ============================================================
// Each command lives in src/commands/<name>.ts and default-exports a
// SlashCommand. This file owns the shared types and the registry that
// index.ts assembles. Behavior is unchanged from the pre-split commands.ts.
// ============================================================

import type { PersistenceManager } from "../persistence.js";
import type { SessionStats } from "../tui/session-stats.js";
import type { Message, ModelCaller, ModelConfig, Tool } from "../types.js";

/** Source label for a tool listed by /tools. */
export type ToolSource = "core" | "mcp";

/** Mutable session state a command may read or change. */
export interface CommandContext {
  messages: Message[];
  modelConfig: ModelConfig;
  callModel: ModelCaller;
  /**
   * M5 fast-model side channel (CCR_FAST_MODEL), resolved lazily per call so
   * mid-session /provider and /model switches are picked up. Null when unset —
   * callers then use the main callModel/modelConfig pair.
   */
  fastModelFactory?: () => { callModel: ModelCaller; modelConfig: ModelConfig } | null;
  workspaceRoot: string;
  sessionId: string;
  persistence?: PersistenceManager;
  ui?: {
    showTokens: boolean;
    verbose: boolean;
  };
  permissions?: {
    listAlwaysAllow(): string[];
    clearAlwaysAllow(): void;
  };
  resumeSession?: (sessionId: string) => Promise<boolean>;
  /** Cumulative token/cost/tool stats for this session. */
  stats?: SessionStats;
  /** Tools loaded this session, with their source for /tools. */
  tools?: Array<{ tool: Tool; source: ToolSource }>;
  /** The active permission mode (for /status, /config). */
  permissionMode?: string;
  getPermissionMode?: () => string;
  /** Set the permission mode (for /mode). */
  setPermissionMode?: (mode: string) => void;
  /** The assembled system prompt (for /context token breakdown). */
  systemPrompt?: string;
  contextWindow?: number;
  contextMemoryFiles?: Array<{ path: string; content: string }>;
  /** Number of connected MCP servers (for /status). */
  mcpServerCount?: number;
  /** MCP manager for /mcp (server/tool/auth status). */
  mcpManager?: import("../mcp/index.js").MCPManager;
  /** Hook registry for /hooks (list registered PreToolUse/PostToolUse). */
  hooks?: import("../hooks.js").HookRegistry;
  /**
   * Interactive input reader for commands that need user confirmation.
   * If not provided, destructive operations should require --force flag.
   */
  input?: {
    askConfirmation(question: string): Promise<boolean>;
  };
  /**
   * Mutable session goal (for /goal). When set, the CLI injects it into the
   * turn's system prompt so the model keeps the objective in view. Stored as a
   * holder so a command can read and write the same reference the REPL reads.
   */
  goal?: { value: string };
  /** Change the workspace root mid-session (for /cd). Returns false if the path
   *  is not a directory. */
  setWorkspaceRoot?: (path: string) => boolean;
  /** Editor input mode (for /vim). Toggled between "default" and "vim". */
  editorMode?: { value: "default" | "vim" };
  /**
   * Active output style holder (for /output-style). The CLI reads this when it
   * rebuilds the turn's system prompt; writing it switches the style for
   * subsequent turns. Same `{ value }` holder pattern as `goal` / `editorMode`.
   */
  outputStyle?: { value: string };
  /** Parsed durable permission policy for /permissions inspection. */
  permissionPolicy?: import("../permission-policy.js").PermissionPolicy;
}

export interface CommandResult {
  /** True if the input was a recognized slash command (don't send to LLM). */
  handled: boolean;
  /** True if the REPL should exit. */
  exit?: boolean;
  /**
   * M18: a prompt the caller should inject as a user message and run through
   * the agent loop (instead of treating the command as fully handled). Used by
   * /review, /recap, /onboarding, … Mirrors B's `type: 'prompt'` commands.
   * When set, `handled` is still true (the slash line itself is consumed),
   * and the caller is responsible for pushing + running the prompt.
   */
  prompt?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  /**
   * Run the command. May return a partial CommandResult (e.g. `{ prompt }`)
   * to ask the caller to inject a prompt into the agent loop; otherwise the
   * command is treated as fully handled. Mirrors B's `type: 'prompt'` commands.
   */
  run: (
    args: string,
    ctx: CommandContext,
  ) => Promise<Partial<CommandResult> | undefined> | Partial<CommandResult> | undefined;
}
