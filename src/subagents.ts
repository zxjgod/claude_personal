// ============================================================
// Sub-agent Registry — configurable sub-agent types
// ============================================================
// Each sub-agent type declares which core tools it may use and the
// system prompt that shapes its behavior. The Task tool resolves a
// type by name and runs it in an isolated agent loop.
// ============================================================

import type { Tool } from "./types.js";

export interface SubagentType {
  name: string;
  /** One-line description shown in the Task tool's prompt. */
  description: string;
  /** Names of core tools this sub-agent may use. */
  toolNames: string[];
  /** System prompt for the sub-agent's loop. */
  systemPrompt: string;
  /** Turn budget; falls back to the Task tool default when omitted. */
  maxTurns?: number;
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
      toolNames: ["read", "glob", "grep", "bash"],
      systemPrompt: EXPLORER_PROMPT,
    },
  ],
  [
    "code-reviewer",
    {
      name: "code-reviewer",
      description: "Read-only review: assess code for bugs, risk, and clarity",
      toolNames: ["read", "glob", "grep"],
      systemPrompt: REVIEWER_PROMPT,
    },
  ],
  [
    "general",
    {
      name: "general",
      description: "Read/write worker: complete a multi-step task end to end",
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

/** Resolve a sub-agent's tool set from the full available tool list. */
export function resolveSubagentTools(type: SubagentType, available: Tool[]): Tool[] {
  return type.toolNames
    .map((name) => available.find((t) => t.name === name))
    .filter((t): t is Tool => t !== undefined);
}
