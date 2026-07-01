// ============================================================
// Claude Code Replica — Main Exports
// ============================================================

// Agent Loop
export { agentLoop, autoCompact } from "./agent-loop.js";
// Agent Memory (M35)
export type { MemoryScope } from "./agent-memory.js";
export {
  agentMemoryDir,
  agentMemoryFile,
  assertSafeAgentType,
  loadAgentMemoryPrompt,
  saveAgentMemory,
} from "./agent-memory.js";
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
export type {
  MicrocompactOptions,
  PrepareCheapLayersOptions,
  PreparedContext,
  ToolResultBudgetOptions,
} from "./context-pipeline.js";
// Context Pipeline (M31)
export {
  applyToolResultBudget,
  COMPACT_BOUNDARY_MARKER,
  CollapseStore,
  getMessagesAfterCompactBoundary,
  microcompact,
  prepareCheapLayers,
} from "./context-pipeline.js";
export type { FileRefResult } from "./file-refs.js";
export { expandFileRefs } from "./file-refs.js";
export type {
  Hook,
  PostToolUseOutcome,
  PostToolUsePayload,
  PreToolUseOutcome,
  PreToolUsePayload,
  StopOutcome,
  StopPayload,
} from "./hooks.js";
// Hooks
export { HookRegistry } from "./hooks.js";
// Input Queue (M36)
export { InputQueue } from "./input-queue.js";
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
// Background prefetch (M36)
export type {
  PrefetchResult,
  PrefetchSources,
  RankedMemory,
  RankedSkill,
} from "./prefetch.js";
export {
  keywords,
  rankMemories,
  rankSkills,
  renderPrefetchAttachment,
  startPrefetch,
} from "./prefetch.js";
// Turn output budget (M32)
export type { BudgetDecision, TokenBudgetConfig, TokenBudgetState } from "./query/token-budget.js";
export {
  buildContinuationNudge,
  checkTokenBudget,
  createTokenBudgetState,
  DEFAULT_TOKEN_BUDGET,
  recordOutput,
} from "./query/token-budget.js";
export type { ReadCheck } from "./read-tracker.js";
// Read Tracker (read-before-edit)
export {
  checkReadBeforeEdit,
  markRead,
  refreshRead,
  resetReadTracker,
} from "./read-tracker.js";
export { runForkSkill } from "./skills/forkSkill.js";
export {
  expandSkillBody,
  loadSkillsDir,
  parseFrontmatter,
  skillDirRoots,
} from "./skills/loadSkillsDir.js";
// Skill system (pillar 7, M37)
export type {
  Skill,
  SkillContext,
  SkillDefinition,
  SkillInfo,
  SkillPromptContext,
  SkillSource,
} from "./skills.js";
export {
  DEFAULT_SKILL_DISCOVERY_WINDOW,
  getSkill,
  listSkills,
  registerSkill,
  renderSkillCatalog,
  resetSkills,
  resolveSkillPrompt,
  SKILL_DISCOVERY_FRACTION,
} from "./skills.js";
// Streaming tool executor (M36)
export type { SingleToolRunner } from "./streaming-tool-executor.js";
export { StreamingToolExecutor } from "./streaming-tool-executor.js";
export type { SubagentType } from "./subagents.js";
// Sub-agent Registry
export {
  buildSubagentSystemPrompt,
  getSubagentType,
  listSubagentNames,
  registerSubagentType,
  resolveSubagentTools,
  setAgentMemoryLoader,
} from "./subagents.js";
export type { SystemPromptOptions } from "./system-prompt.js";
// System Prompt
export {
  buildSystemPrompt,
  DANGEROUS_uncachedSystemPromptSection,
  listUncachedSections,
  renderSystemPrompt,
  resetSystemPromptCache,
  systemPromptSection,
} from "./system-prompt.js";
export { TaskTool } from "./task-tool.js";
export { TodoTool } from "./todo-tool.js";
export type { BaseToolConfig, BuildToolConfig } from "./tool-registry.js";
// Tool Registry
export {
  buildTool,
  createTool,
  InputValidationError,
  TOOL_DEFAULTS,
  ToolRegistry,
  toolUseError,
} from "./tool-registry.js";
// Tool Result Spill (M30)
export { DEFAULT_MAX_RESULT_CHARS, SPILL_DIR, spillIfLarge } from "./tool-result-spill.js";
// Tool-result summary (M36, kernel §9)
export type {
  ToolBatchDigest,
  ToolBatchSummarizer,
  ToolDigestEntry,
  ToolSummarySources,
} from "./tool-summary.js";
export {
  buildSummaryPrompt,
  buildToolBatchDigest,
  DEFAULT_SUMMARY_MIN_BYTES,
  renderSummaryAttachment,
  SUMMARY_SNIPPET_CHARS,
  shouldSummarizeBatch,
  startToolSummary,
} from "./tool-summary.js";
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
// Cancellation tree (M35)
export type { CancelKind, CancelReason } from "./utils/cancellation.js";
export {
  CancellationScope,
  cancelReason,
  interpretCancelReason,
  isInterrupt,
} from "./utils/cancellation.js";
export { WebFetchTool } from "./web-fetch.js";
export { parseSearchResults, WebSearchTool } from "./web-search.js";
