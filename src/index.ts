// ============================================================
// Claude Code Replica — Main Exports
// ============================================================

// Types
export type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  SystemMessage,
  ContentBlock,
  TextContent,
  ImageContent,
  ToolCall,
  ToolInput,
  ToolResult,
  ToolResultMetadata,
  ToolContext,
  PermissionMode,
  PermissionResult,
  Tool,
  ModelConfig,
  StreamEvent,
  LoopEvent,
  ToolExecutionResult,
  LoopOptions,
  ModelCaller,
} from "./types.js";

// Agent Loop
export { agentLoop, autoCompact } from "./agent-loop.js";

// Slash Commands & File References
export { handleSlashCommand, COMMANDS } from "./commands.js";
export type { CommandContext, CommandResult, SlashCommand } from "./commands.js";
export { expandFileRefs } from "./file-refs.js";
export type { FileRefResult } from "./file-refs.js";

// System Prompt
export {
  buildSystemPrompt,
  rebuildDynamicSections,
} from "./system-prompt.js";
export type { SystemPromptOptions } from "./system-prompt.js";

// Tools
export {
  ReadTool,
  WriteTool,
  EditTool,
  MultiEditTool,
  BashTool,
  GlobTool,
  GrepTool,
  CORE_TOOLS,
} from "./tools.js";
export { TodoTool } from "./todo-tool.js";
export { WebFetchTool } from "./web-fetch.js";
export { WebSearchTool, parseSearchResults } from "./web-search.js";
export { TaskTool } from "./task-tool.js";

// Sub-agent Registry
export {
  registerSubagentType,
  getSubagentType,
  listSubagentNames,
  resolveSubagentTools,
} from "./subagents.js";
export type { SubagentType } from "./subagents.js";

// Hooks
export { HookRegistry } from "./hooks.js";
export type {
  Hook,
  PreToolUsePayload,
  PreToolUseOutcome,
  PostToolUsePayload,
  PostToolUseOutcome,
} from "./hooks.js";

// Read Tracker (read-before-edit)
export {
  markRead,
  checkReadBeforeEdit,
  refreshRead,
  resetReadTracker,
} from "./read-tracker.js";
export type { ReadCheck } from "./read-tracker.js";

// Tool Registry
export { ToolRegistry, createTool } from "./tool-registry.js";
export type { BaseToolConfig } from "./tool-registry.js";

// Anthropic Adapter
export {
  anthropicCaller,
  convertMessagesToAnthropic,
  formatSystemForAnthropic,
  formatToolsForAnthropic,
} from "./anthropic-adapter.js";

// LLM Adapter
export {
  createModelCaller,
  resolveProviderConfig,
  isRateLimitError,
  isContextLengthError,
  isAuthError,
  isProviderError,
  PROVIDER_CONFIGS,
} from "./llm-adapter.js";

// Permissions
export {
  checkPermission,
  checkDangerousPattern,
  isBlockedPath,
} from "./permissions.js";
export type { PermissionCheckOptions } from "./permissions.js";

// MCP
export {
  MCPManager,
  discoverMCPConfigs,
} from "./mcp.js";
export type { MCPServerConfig, MCPConfig } from "./mcp.js";

// Persistence
export { PersistenceManager } from "./persistence.js";
export type { SessionData, SessionMeta } from "./persistence.js";
