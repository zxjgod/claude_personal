// ============================================================
// Sub-agent Registry — configurable sub-agent types
// ============================================================
// Each sub-agent type declares which core tools it may use and the
// system prompt that shapes its behavior. The Task tool resolves a
// type by name and runs it in an isolated agent loop.
// ============================================================

import type { Message, Tool } from "./types.js";

export interface SubagentType {
  name: string;
  /** One-line description shown in the Task tool's prompt. */
  description: string;
  /**
   * When the parent should pick THIS sub-agent (kernel §2/§7.4). The parent
   * selects a sub-agent by reading these strings, so phrase it as the
   * triggering situation ("when you need to … across many files"). Optional;
   * falls back to `description` in the Task tool prompt.
   */
  whenToUse?: string;
  /** Names of core tools this sub-agent may use. */
  toolNames: string[];
  /** System prompt for the sub-agent's loop. */
  systemPrompt: string;
  /** Turn budget; falls back to the Task tool default when omitted. */
  maxTurns?: number;
  /**
   * Cross-session memory scope (M35, kernel §5). When set, the sub-agent's
   * MEMORY.md for this type+scope is loaded and injected into its system prompt,
   * letting a repeatedly-used type accumulate experience. Omitted → no memory.
   */
  memory?: "user" | "project" | "local";
}

const EXPLORER_PROMPT = [
  "You are a code-exploration sub-agent with access to read-only tools.",
  "",
  "Instructions:",
  "- Use the available tools to complete your task",
  "- Be thorough but efficient",
  "- Your final response should be a clear summary of your findings",
  "- Do not ask clarifying questions — work with what you have",
  "- When you have gathered enough information, respond with your findings directly (no tool calls)",
].join("\n");

const REVIEWER_PROMPT = [
  "You are a code-review sub-agent. You read code and report issues.",
  "",
  "Instructions:",
  "- Read the relevant files and assess correctness, clarity, and risk",
  "- Report concrete findings with file references; do not rewrite code",
  "- Prioritize correctness bugs and security issues over style",
  "- Your final response is a structured review summary (no tool calls)",
].join("\n");

const GENERAL_PROMPT = [
  "You are a general-purpose sub-agent that can read and modify files.",
  "",
  "Instructions:",
  "- Use the available tools to complete your task end to end",
  "- Prefer precise edits over rewrites",
  "- Do not ask clarifying questions — work with what you have",
  "- When done, respond with a clear summary of what you changed (no tool calls)",
].join("\n");

// Registry of built-in sub-agent types. Each lists the core tools it may use.
const SUBAGENT_TYPES = new Map<string, SubagentType>([
  [
    "code-explorer",
    {
      name: "code-explorer",
      description: "Read-only exploration: search and summarize across many files",
      whenToUse:
        "When you need to explore, search, or understand code across many files and only need a summary of findings back (not the raw tool output).",
      toolNames: ["read", "glob", "grep", "bash"],
      systemPrompt: EXPLORER_PROMPT,
    },
  ],
  [
    "code-reviewer",
    {
      name: "code-reviewer",
      description: "Read-only review: assess code for bugs, risk, and clarity",
      whenToUse:
        "When you want an independent review of existing code for correctness bugs, security issues, and clarity, returned as a structured summary.",
      toolNames: ["read", "glob", "grep"],
      systemPrompt: REVIEWER_PROMPT,
    },
  ],
  [
    "general",
    {
      name: "general",
      description: "Read/write worker: complete a multi-step task end to end",
      whenToUse:
        "When you need a multi-step task carried out end to end (including file edits) and only need a summary of what changed back.",
      toolNames: ["read", "glob", "grep", "bash", "write", "edit"],
      systemPrompt: GENERAL_PROMPT,
    },
  ],
]);

/** Register or override a sub-agent type (used by tests and extensions). */
export function registerSubagentType(type: SubagentType): void {
  SUBAGENT_TYPES.set(type.name, type);
}

export function getSubagentType(name: string): SubagentType | undefined {
  return SUBAGENT_TYPES.get(name);
}

export function listSubagentNames(): string[] {
  return Array.from(SUBAGENT_TYPES.keys());
}

/**
 * Name + selection hint for each sub-agent, for the Task tool prompt. The
 * parent picks a sub-agent by reading `whenToUse` (kernel §7.4); falls back to
 * `description` when a type didn't declare one.
 */
export function listSubagentSelectionHints(): Array<{ name: string; whenToUse: string }> {
  return Array.from(SUBAGENT_TYPES.values()).map((t) => ({
    name: t.name,
    whenToUse: t.whenToUse ?? t.description,
  }));
}

/** Resolve a sub-agent's tool set from the full available tool list. */
export function resolveSubagentTools(type: SubagentType, available: Tool[]): Tool[] {
  return type.toolNames
    .map((name) => available.find((t) => t.name === name))
    .filter((t): t is Tool => t !== undefined);
}

// --- Core-tool injection (16.9) ---
//
// Sub-agent loops (Task / Team) need the core read/write/bash tools to resolve
// a sub-agent type's toolNames against. Importing tools.ts directly from
// task-tool.ts / team.ts created a cycle (tools.ts → TaskTool → tools.ts) that
// was previously papered over with lazy dynamic import(). Instead, the CLI
// injects the core tools once at startup via setCoreToolsForSubagents; the
// sub-agent modules then read them from here with no import cycle. Tests that
// build sub-agents without the CLI can call it too, or fall back to the lazy
// import below.
let _coreTools: Tool[] | null = null;

/** Provide the core tool set used to resolve sub-agent tool names. */
export function setCoreToolsForSubagents(tools: Tool[]): void {
  _coreTools = tools;
}

/**
 * The core tools available to sub-agents. Returns the injected set if the CLI
 * provided one; otherwise lazily imports tools.ts as a fallback (kept so
 * standalone tests/usage without CLI wiring still work).
 */
export async function getCoreToolsForSubagents(): Promise<Tool[]> {
  if (_coreTools) return _coreTools;
  const { ReadTool, GlobTool, GrepTool, BashTool, WriteTool, EditTool } = await import(
    "./tools/index.js"
  );
  _coreTools = [ReadTool, GlobTool, GrepTool, BashTool, WriteTool, EditTool];
  return _coreTools;
}

// --- M34 · Context protection (kernel §4) ---

/**
 * Extract ONLY the final assistant text from a finished sub-agent loop.
 *
 * This is the whole point of the sub-agent abstraction (kernel §4): the parent
 * context must receive the sub-agent's *conclusion*, never its process. The
 * previous implementation accumulated every `text_delta` across every turn and
 * joined them, so a sub-agent that "thought out loud" across 10 turns leaked
 * all of that narration into the parent — defeating context isolation and
 * blowing up long tasks.
 *
 * The agent loop pushes each assistant turn into `messages` in place (string
 * content for a final answer, or `null` content + tool_calls when it stopped to
 * call tools). We walk backwards and return the most recent assistant message
 * that actually carries text. If the loop stopped on a tool_use with no
 * trailing text answer, we fall back to the nearest earlier assistant text.
 */
export function extractLastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string") {
      const text = m.content.trim();
      if (text) return text;
    }
  }
  return "";
}

/**
 * Append environment details + a Notes footnote to a sub-agent's system prompt
 * (kernel §3). Sub-agents run their own loop, so they don't inherit the main
 * loop's env section; without this they lose track of cwd and emit relative
 * paths the parent can't act on. The footnote is engineered so the final
 * report is self-contained — it's what makes "only the last message" (§4)
 * sufficient for the parent.
 */
export function enhanceSystemPromptWithEnvDetails(
  systemPrompt: string,
  env: { workspaceRoot?: string } = {},
): string {
  const lines = [
    systemPrompt,
    "",
    "Environment:",
    `- Working directory: ${env.workspaceRoot ?? process.cwd()}`,
    `- Platform: ${process.platform}`,
    "",
    "Notes:",
    "- The cwd resets between bash calls — always use absolute paths.",
    "- Do not ask clarifying questions; work with what you have.",
    "- Your final reply is the ONLY thing returned to the caller, so make it a",
    "  self-contained report: state your conclusion and include any file paths",
    "  the caller needs (the caller does not see your intermediate tool output).",
  ];
  return lines.join("\n");
}

/**
 * Build a sub-agent's full system prompt (M35): the type's base prompt, env
 * details + Notes footnote (kernel §3), and — when the type declares a memory
 * scope — its cross-session MEMORY.md (kernel §5). Memory is best-effort: a
 * missing/unreadable file simply contributes nothing. Kept here so both
 * sub-agent entry points (Task / Team) compose the prompt identically.
 */
export function buildSubagentSystemPrompt(
  type: SubagentType,
  base: string,
  env: { workspaceRoot?: string } = {},
): string {
  let prompt = enhanceSystemPromptWithEnvDetails(base, env);
  if (type.memory) {
    // Lazy import avoids loading node:fs in pure-registry consumers.
    const mem = loadMemoryBlock(type.memory, type.name, env.workspaceRoot ?? process.cwd());
    if (mem) prompt = `${prompt}\n\n${mem}`;
  }
  return prompt;
}

// Indirection so subagents.ts has no static dependency on node:fs (agent-memory
// pulls in fs/os); resolved synchronously via require-like dynamic access only
// when a type actually declares memory.
let _loadMemory:
  | ((scope: "user" | "project" | "local", type: string, root: string) => string | null)
  | null = null;

/** Inject the memory loader (CLI/tests). Falls back to a no-op until set. */
export function setAgentMemoryLoader(
  loader: (scope: "user" | "project" | "local", type: string, root: string) => string | null,
): void {
  _loadMemory = loader;
}

function loadMemoryBlock(
  scope: "user" | "project" | "local",
  type: string,
  root: string,
): string | null {
  return _loadMemory ? _loadMemory(scope, type, root) : null;
}
