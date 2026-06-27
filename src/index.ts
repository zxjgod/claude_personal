// ============================================================
// Claude Code Replica — Main Exports
// ============================================================

// Agent Loop
export { agentLoop, autoCompact } from "./agent-loop.js";
// Anthropic Adapter
export {
  anthropicCaller,
  convertMessagesToAnthropic,
  formatSystemForAnthropic,
  formatToolsForAnthropic,
} from "./anthropic-adapter.js";
export type { CommandContext, CommandResult, SlashCommand } from "./commands.js";
// Slash Commands & File References
export { COMMANDS, handleSlashCommand } from "./commands.js";
export type { FileRefResult } from "./file-refs.js";
export { expandFileRefs } from "./file-refs.js";
export type {
  Hook,
  PostToolUseOutcome,
  PostToolUsePayload,
  PreToolUseOutcome,
  PreToolUsePayload,
} from "./hooks.js";
// Hooks
export { HookRegistry } from "./hooks.js";
// LLM Adapter
export {
  createModelCaller,
  isAuthError,
  isContextLengthError,
  isProviderError,
  isRateLimitError,
  PROVIDER_CONFIGS,
  resolveProviderConfig,
} from "./llm-adapter.js";
export type { MCPConfig, MCPServerConfig } from "./mcp.js";
// MCP
export {
  discoverMCPConfigs,
  MCPManager,
} from "./mcp.js";
export type { PermissionCheckOptions } from "./permissions.js";
// Permissions
export {
  checkDangerousPattern,
  checkPermission,
  classifyPermissionRisk,
  isBlockedPath,
  parseClassifierVerdict,
} from "./permissions.js";
export type { SessionData, SessionMeta } from "./persistence.js";
// Persistence
export { PersistenceManager } from "./persistence.js";
export type { ReadCheck } from "./read-tracker.js";
// Read Tracker (read-before-edit)
export {
  checkReadBeforeEdit,
  markRead,
  refreshRead,
  resetReadTracker,
} from "./read-tracker.js";
export type { SubagentType } from "./subagents.js";
// Sub-agent Registry
export {
  getSubagentType,
  listSubagentNames,
  registerSubagentType,
  resolveSubagentTools,
} from "./subagents.js";
export type { SystemPromptOptions } from "./system-prompt.js";
// System Prompt
export {
  buildSystemPrompt,
  rebuildDynamicSections,
} from "./system-prompt.js";
export { TaskTool } from "./task-tool.js";
export { TodoTool } from "./todo-tool.js";
export type { BaseToolConfig } from "./tool-registry.js";
// Tool Registry
export { createTool, ToolRegistry } from "./tool-registry.js";
// Tools
export {
  BashTool,
  CORE_TOOLS,
  EditTool,
  GlobTool,
  GrepTool,
  MultiEditTool,
  ReadTool,
  WriteTool,
} from "./tools.js";
// Types
export type {
  AssistantMessage,
  ClassifierResult,
  ContentBlock,
  ImageContent,
  LoopEvent,
  LoopOptions,
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
  PermissionResult,
  StreamEvent,
  SystemMessage,
  TextContent,
  Tool,
  ToolCall,
  ToolContext,
  ToolExecutionResult,
  ToolInput,
  ToolResult,
  ToolResultMessage,
  ToolResultMetadata,
  UserMessage,
} from "./types.js";
export { WebFetchTool } from "./web-fetch.js";
export { parseSearchResults, WebSearchTool } from "./web-search.js";
