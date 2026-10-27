// ============================================================
// Sub-agent Registry — configurable sub-agent types
// ============================================================
// Each sub-agent type declares which core tools it may use and the
// system prompt that shapes its behavior. The Task tool resolves a
// type by name and runs it in an isolated agent loop.
// ============================================================

import { loadProjectInstructions, renderInstructions } from "./project-instructions.js";
import { getSkill, resolveSkillPrompt } from "./skills.js";
import { getSubagentSettings } from "./subagent-settings.js";
import { estimateTokensQuick } from "./token-estimator.js";
import { canonicalToolKey } from "./tools/utils/official-names.js";
import type { Message, ModelConfig, Tool } from "./types.js";

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
  inheritTools?: boolean;
  disallowedTools?: string[];
  /**
   * Shorter selection hint rendered in place of whenToUse when the
   * custom-agent description budget is blown (official 2.1.202
   * `whenToUseLean` — Y$l picks it when the lean flag is set).
   */
  whenToUseLean?: string;
  model?: string;
  effort?: string;
  /**
   * Extended-thinking override (拍板 #21). Default: sub-agents run with
   * thinking OFF (official 2.1.88). `true` lets the parent's thinking config
   * pass through for THIS type; `false` pins it off even when the /agents
   * global toggle enabled thinking.
   */
  thinking?: boolean;
  /**
   * 拍板 #14-B (official 2.1.202): agent-scoped MCP servers declared in
   * frontmatter — the agent spawns its OWN connections (closed when it
   * finishes), gated by one-time fingerprint trust (agents/agent-mcp.ts).
   */
  mcpServers?: Record<string, import("./mcp/index.js").MCPServerConfig>;
  skills?: string[];
  permissionMode?: string;
  hooks?: unknown;
  /**
   * True when the definition came from a USER-owned root (~/.claude-code-
   * replica/agents) — its `hooks` register directly. Project/plugin-scope
   * agents go through the one-time fingerprint trust gate in
   * scoped-execution.prepareAgentHooks (review fix: repo-declared agent hooks
   * used to run shell with no gate at all).
   */
  hooksTrusted?: boolean;
  background?: boolean;
  isolation?: "worktree";
  /** System prompt for the sub-agent's loop. */
  systemPrompt: string;
  /** Turn budget; falls back to the Task tool default when omitted. */
  maxTurns?: number;
  /**
   * Official `omitClaudeMd` frontmatter field: when true, the sub-agent's
   * system prompt skips the user / project / local CLAUDE.md (+ rules) block
   * that buildSubagentSystemPrompt would otherwise inject. Official built-ins
   * Explore and Plan skip it to keep research fast and inexpensive.
   */
  omitClaudeMd?: boolean;
  /**
   * Registration origin. Only "built-in" is meaningful: the agent-description
   * token budget (official 2.1.202 doctor check) counts every NON-built-in
   * type, because custom descriptions ride along in the Task/Agent prompt.
   */
  source?: string;
  /**
   * Cross-session memory scope (M35, kernel §5). When set, the sub-agent's
   * MEMORY.md for this type+scope is loaded and injected into its system prompt,
   * letting a repeatedly-used type accumulate experience. Omitted → no memory.
   */
  memory?: "user" | "project" | "local";
}

const EXPLORER_PROMPT = [
  // #45 honesty: bash is NOT a read-only boundary — the prompt states the
  // intent (exploration) instead of claiming an enforcement that doesn't
  // exist. Official Explore is denylist-based (write/edit/spawn removed,
  // everything else incl. web + MCP stays), so name the intent, not a list.
  "You are a code-exploration sub-agent. Your tools are for EXPLORING code —",
  "write/edit and agent-spawning tools are disabled; use bash only for",
  "read-oriented commands (ls, git log, rg, ...); do not modify anything.",
  "",
  "Instructions:",
  "- Use the available tools to complete your task",
  // Official Explore convention: the caller names a thoroughness level and
  // the agent scales its effort to it.
  '- Scale effort to the requested thoroughness: "quick" = targeted lookups (1-3 searches),',
  '  "medium" = balanced exploration, "very thorough" = comprehensive analysis across the codebase;',
  "  when no level is named, default to medium",
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
  // Official general-purpose system prompt (2.1.202 COf) condensed to this
  // project's style: the intro and report conventions are verbatim-official.
  "You are a general-purpose sub-agent. Given the user's message, use the tools",
  "available to complete the task. Complete the task fully — don't gold-plate,",
  "but don't leave it half-done.",
  "",
  "Instructions:",
  "- Prefer precise edits over rewrites",
  "- Do not ask clarifying questions — work with what you have",
  "- When you complete the task, respond with a concise report covering what was",
  "  done and any key findings — the caller will relay this to the user, so it",
  "  only needs the essentials (no tool calls in the final response)",
].join("\n");

// Registry of built-in sub-agent types. Each lists the core tools it may use.
const SUBAGENT_TYPES = new Map<string, SubagentType>([
  [
    "code-explorer",
    {
      name: "code-explorer",
      description:
        "Code exploration: search and summarize across many files (toolset includes bash — by-intent exploration, not an enforced read-only boundary)",
      // Official Explore whenToUse (2.1.202 source), adapted to this name.
      whenToUse:
        "Fast read-only search agent for locating code. Use it to find files by pattern " +
        '(eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API ' +
        'endpoints"), or answer "where is X defined / which files reference Y." Do NOT ' +
        "use it for code review, design-doc auditing, cross-file consistency checks, or " +
        "open-ended analysis — it reads excerpts rather than whole files and will miss " +
        'content past its read window. When calling, specify search breadth: "quick" for ' +
        'a single targeted lookup, "medium" for moderate exploration, or "very thorough" ' +
        "to search across multiple locations and naming conventions.",
      // Official Explore whenToUseLean (2.1.202 source), adapted.
      whenToUseLean:
        "Read-only search agent for broad fan-out searches — when answering means " +
        "sweeping many files, directories, or naming conventions and you only need the " +
        "conclusion, not the file dumps. It reads excerpts rather than whole files, so " +
        "it locates code; it doesn't review or audit it. Specify search breadth: " +
        '"medium" for moderate exploration, "very thorough" for multiple locations and ' +
        "naming conventions.",
      // Official Explore is DENYLIST-based (2.1.202): disallowedTools = [Agent,
      // Artifact, ExitPlanMode, Edit, Write, NotebookEdit] — everything else
      // (Web, Todo, Skill, MCP) stays available. Our equivalents: agent/task
      // (officially Task is an Agent alias, so its Agent ban covers both),
      // write, edit, notebookedit; Artifact/ExitPlanMode don't exist here.
      toolNames: [],
      inheritTools: true,
      disallowedTools: ["agent", "task", "write", "edit", "notebookedit"],
      systemPrompt: EXPLORER_PROMPT,
      maxTurns: 20,
      source: "built-in",
      // Official Explore skips CLAUDE.md files (and the git status snapshot,
      // which this project does not inject anyway) to keep research cheap.
      omitClaudeMd: true,
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
      maxTurns: 30,
      source: "built-in",
    },
  ],
  [
    "general",
    {
      name: "general",
      description: "Read/write worker: complete a multi-step task end to end",
      // Official general-purpose whenToUse (2.1.202) verbatim.
      whenToUse:
        "General-purpose agent for researching complex questions, searching for code, " +
        "and executing multi-step tasks. When you are searching for a keyword or file " +
        "and are not confident that you will find the right match in the first few " +
        "tries use this agent to perform the search for you.",
      // Official general-purpose: tools ["*"] — everything (spawning included;
      // the S8t=5 nesting cap bounds recursion).
      toolNames: [],
      inheritTools: true,
      systemPrompt: GENERAL_PROMPT,
      maxTurns: 20,
      source: "built-in",
    },
  ],
]);

/** Register or override a sub-agent type (used by tests and extensions). */
export function registerSubagentType(type: SubagentType): void {
  SUBAGENT_TYPES.set(type.name, type);
}

/** Remove disk/plugin registrations while retaining compiled-in agent types. */
export function removeCustomSubagentTypes(): void {
  for (const [name, type] of SUBAGENT_TYPES) {
    if (type.source !== "built-in") SUBAGENT_TYPES.delete(name);
  }
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
export function listSubagentSelectionHints(
  lean?: boolean,
): Array<{ name: string; whenToUse: string }> {
  return Array.from(SUBAGENT_TYPES.values()).map((t) => ({
    name: t.name,
    // Official Y$l: lean flag + a defined whenToUseLean wins over whenToUse.
    whenToUse: (lean && t.whenToUseLean) || t.whenToUse || t.description,
  }));
}

// Official parity (2.1.202 startup/doctor check): the parent reads every
// custom agent's "name: whenToUse" hint to pick a sub-agent, so oversized
// descriptions tax every session. Official warns when the NON-built-in total
// exceeds 15,000 tokens ("Large agent descriptions (~N tokens > 15,000)").
export const AGENT_DESCRIPTION_TOKEN_LIMIT = 15_000;

/** Estimated token total of all custom (non-built-in) agent descriptions. */
export function agentDescriptionTokens(): number {
  let total = 0;
  for (const t of SUBAGENT_TYPES.values()) {
    if (t.source === "built-in") continue;
    total += estimateTokensQuick(`${t.name}: ${t.whenToUse ?? t.description}`);
  }
  return total;
}

// Official parity (2.1.202): CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS removes
// the built-in Explore/Plan agents (wjr gate). Maps to this project's
// built-ins: code-explorer (our Explore analog) and any plan-named built-in.
// Only built-ins are removed — a user-defined agent with the same name stays.
const EXPLORE_PLAN_BUILTIN_NAMES = new Set(["code-explorer", "explore", "plan"]);

/** Honor CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS; returns removed type names. */
export function applyDisableExplorePlanEnv(): string[] {
  if (!process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS) return [];
  const removed: string[] = [];
  for (const t of Array.from(SUBAGENT_TYPES.values())) {
    if (t.source === "built-in" && EXPLORE_PLAN_BUILTIN_NAMES.has(t.name.toLowerCase())) {
      SUBAGENT_TYPES.delete(t.name);
      removed.push(t.name);
    }
  }
  return removed;
}

// Official 2.1.202 type-name normalization (bTt): NFKC → lowercase → strip
// whitespace/dashes/underscores, truncated to 60 chars (tCe). So
// "Code Explorer" ≡ "code-explorer" ≡ "code_explorer". An exact registry hit
// wins; otherwise a UNIQUE normalized match resolves (telemetry
// tengu_subagent_type_normalized) and multiple matches are an ambiguity error
// (subagent_type_ambiguous).
export function normalizeSubagentTypeName(name: string): string {
  const stripped = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return Array.from(stripped).slice(0, 60).join("");
}

export type SubagentTypeResolution =
  | { kind: "found"; type: SubagentType; normalized: boolean }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "not-found" };

// Official built-in name aliases (拍板 c=B): official 2.1.202 built-ins are
// Explore / Plan / general-purpose; we keep our own names primary but accept
// the official names for the equivalents we ship. Keys are in NORMALIZED form
// (normalizeSubagentTypeName output). "Plan" has no local analog — omitting
// it keeps the honest "unknown type" error rather than a wrong mapping.
// Precedence: exact registry hit > alias > normalized scan, so a user-defined
// agent named "Explore" overrides the alias (official: user agents override
// built-ins with the same name).
export const SUBAGENT_TYPE_ALIASES: Record<string, string> = {
  explore: "code-explorer",
  generalpurpose: "general",
};

export function resolveSubagentType(name: string): SubagentTypeResolution {
  const direct = SUBAGENT_TYPES.get(name);
  if (direct) return { kind: "found", type: direct, normalized: false };
  const target = normalizeSubagentTypeName(name);
  const alias = SUBAGENT_TYPE_ALIASES[target];
  if (alias) {
    const aliased = SUBAGENT_TYPES.get(alias);
    if (aliased) return { kind: "found", type: aliased, normalized: true };
  }
  const matches = Array.from(SUBAGENT_TYPES.values()).filter(
    (t) => normalizeSubagentTypeName(t.name) === target,
  );
  if (matches.length === 1) return { kind: "found", type: matches[0], normalized: true };
  if (matches.length > 1) return { kind: "ambiguous", matches: matches.map((t) => t.name) };
  return { kind: "not-found" };
}

/**
 * Resolve a sub-agent's tool set from the full available tool list.
 * S3: an entry ending in `*` matches by prefix — `mcp__*` grants every MCP
 * tool, `mcp__github__*` every tool of one server. This is also how disk
 * agents (.claude/agents/*.md `tools:` frontmatter) reach MCP tools.
 */
export function resolveSubagentTools(type: SubagentType, available: Tool[]): Tool[] {
  // Same canonical form execution uses, so a disk agent's official spelling
  // (`tools: Read, Grep`) and official aliases (`TodoWrite`, `TaskOutput`)
  // resolve to the same tools — see tools/utils/official-names.ts.
  const canonical = canonicalToolKey;
  const byName = new Map(available.map((t) => [canonical(t.name), t]));
  const resolved = new Set<Tool>();
  for (const name of type.toolNames) {
    if (name.endsWith("*")) {
      const prefix = canonical(name.slice(0, -1));
      for (const tool of available) {
        if (canonical(tool.name).startsWith(prefix)) resolved.add(tool);
      }
      continue;
    }
    const tool = byName.get(canonical(name));
    if (tool) resolved.add(tool);
  }
  const denied = new Set((type.disallowedTools ?? []).map(canonical));
  return (type.inheritTools ? available : [...resolved]).filter(
    (tool) => !denied.has(canonical(tool.name)),
  );
}

export function subagentModelConfig(
  type: SubagentType | undefined,
  parent: ModelConfig,
  callTimeModel?: string,
): ModelConfig {
  const aliases: Record<string, string> = {
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6",
    haiku: "claude-haiku-4-5",
  };
  // Official parity — measured from the 2.1.202 binary (function B7), which
  // contradicts the docs page: CLAUDE_CODE_SUBAGENT_MODEL env > Agent-tool
  // call-time `model` param > frontmatter `model` > parent model. The env var
  // "forces one model onto every subagent" — it is the highest-precedence
  // override, not a fallback. Forks (type === undefined) are excluded from
  // ALL overrides: officially a fork keeps the main session's model, and its
  // byte-identical prompt prefix is what makes the parent's prompt cache
  // reusable ("Ignored for subagent_type: 'fork' — forks always inherit the
  // parent model").
  const forced = type ? process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim() || undefined : undefined;
  const frontmatter = type?.model && type.model !== "inherit" ? type.model : undefined;
  const rawModel = forced ?? (type ? callTimeModel?.trim() || undefined : undefined) ?? frontmatter;
  const model = rawModel
    ? parent.provider === "anthropic"
      ? process.env[`CCR_MODEL_${rawModel.toUpperCase()}`] || aliases[rawModel] || rawModel
      : rawModel
    : undefined;
  // 拍板 #21 = official 2.1.88: sub-agents run with extended thinking OFF by
  // default — the parent's thinking budget must not bleed into a task executor.
  // Escape hatches (first wins): agent frontmatter `thinking: true|false` >
  // the /agents global toggle (subagent-settings, default off). When enabled,
  // the parent's options.thinking passes through untouched. Forks (type ===
  // undefined) ARE the current agent and keep the parent's thinking as-is.
  const thinkingEnabled = type ? (type.thinking ?? getSubagentSettings().thinking) : true;
  const options = {
    ...parent.options,
    ...(thinkingEnabled ? {} : { thinking: false }),
    ...(type?.effort ? { effort: type.effort } : {}),
  };
  return {
    ...parent,
    ...(model ? { model } : {}),
    options,
  };
}
/**
 * Resolve an agent's declared skills into prompt text.
 *
 * Review fix ("agent 预加载 skills 绕过项目 shell 指令审批"): a project-scope
 * skill with `!`cmd`` directives expands shell at RESOLUTION time. The Skill
 * tool requires explicit approval for that; preloading ran the same expansion
 * unconditionally. The gate now applies here too — without an approval channel
 * (headless) the skill's shell is NOT expanded and a skip note is injected.
 */
export async function preloadAgentSkills(
  type: SubagentType,
  root: string,
  askUser?: import("./types.js").AskUserFn,
): Promise<string> {
  const content: string[] = [];
  for (const name of type.skills ?? []) {
    const skill = getSkill(name);
    if (!skill || skill.disableModelInvocation) continue;
    if (skill.hasShellDirectives && skill.diskScope === "project") {
      const approved = askUser
        ? await askUser(
            { name: "skill" } as Parameters<import("./types.js").AskUserFn>[0],
            { skill: name, args: "" },
            `agent "${type.name}" preloads project-scope skill "${name}" which executes shell (!\`...\`) from the workspace repo`,
          )
        : false;
      if (!approved) {
        content.push(
          `Skill ${name}: SKIPPED — it is a project-scope template with shell directives and was ` +
            `not approved for this agent. Invoke it yourself as /${name} if you want it.`,
        );
        continue;
      }
    }
    content.push(`Skill ${name}:\n${await resolveSkillPrompt(skill, { workspaceRoot: root })}`);
  }
  return content.join("\n\n");
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
  if (_coreTools) return _coreTools.filter((tool) => tool.isEnabled());
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
  // omitClaudeMd (official frontmatter field): skip the user / project / local
  // CLAUDE.md + rules block for this sub-agent. Built-in Explore/Plan behave
  // this way upstream to keep research fast.
  if (!type.omitClaudeMd) {
    const instructions = renderInstructions(
      loadProjectInstructions(env.workspaceRoot ?? process.cwd()),
    );
    if (instructions) prompt += `\n\n${instructions}`;
  }
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
