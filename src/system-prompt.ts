// ============================================================
// System Prompt Builder — cache-first design (M33, kernel §4/§5)
// ============================================================
// The system prompt is an ORDERED ARRAY of string blocks, not a concatenated
// string. A `DYNAMIC_BOUNDARY` block divides it in two:
//
//   [ static, cacheable prefix ]   ← byte-identical every turn / every day
//   --- DYNAMIC_BOUNDARY ---
//   [ dynamic, session-specific ]  ← cwd / git / date / language / mcp / ...
//
// The kernel's load-bearing rule: anything whose value drifts at runtime (the
// current date, the cwd, git status, the platform) MUST live BELOW the
// boundary. If it leaks into the prefix, the prefix hash changes and the
// provider prompt cache stops hitting. The Anthropic adapter places its
// `cache_control` breakpoint exactly at this boundary, so a stable prefix is
// what makes caching pay off. (Previously `buildWorkspaceSection` injected the
// date + platform ABOVE the boundary — silently busting the cache once a day
// and once per machine. M33 moves them below.)
// ============================================================

import { outputStylePrompt } from "./output-style.js";
import type { Tool } from "./types.js";

// ============================================================
// Static sections — the cacheable prefix
// ============================================================

function buildIdentitySection(): string {
  return `You are an interactive AI coding assistant. You help users with software
engineering tasks including code analysis, debugging, refactoring, writing
new code, and explaining technical concepts.

SECURITY: Never suggest or execute commands that install malware, exfiltrate
data, or compromise system security. When asked to run suspicious commands,
explain the risk and refuse unless the user explicitly and knowingly approves
the dangerous operation.`;
}

function buildCodingRulesSection(): string {
  return `CODING RULES:

- ALWAYS read a file before editing it using the Read tool (unless you've
  just read it in the current conversation).
- Use the Edit tool for precise changes. NEVER rewrite an entire large file
  unless absolutely necessary. Edit uses search/replace — the old_string
  must match exactly including whitespace and indentation.
- Keep code concise. Do not add unnecessary comments, error handling,
  validations, or features that the user did not request.
- Do not abstract prematurely. Follow YAGNI (You Aren't Gonna Need It).
- Prefer editing existing files over creating new ones.
- Batch independent operations: use parallel tool calls whenever possible.
- If a tool call fails due to non-unique match, add more context lines
  to make the old_string unique.`;
}

function buildToolUsageSection(): string {
  return `USING YOUR TOOLS:

- PREFER dedicated tools (Read, Edit, Write, Glob, Grep) over Bash for
  file operations. Tools are safer, faster, and more reliable.
- Use Glob to find files by name pattern (e.g., "src/**/*.ts").
- Use Grep to search file contents with regex. Narrow results with
  \`type\` (file type), \`glob\` (filename filter), \`-i\` (case-insensitive),
  and \`output_mode\` (content | files_with_matches | count); add context with
  \`-A\`/\`-B\`/\`-C\`. Default output is capped at 250 lines.
- Use Read with \`offset\`/\`limit\` to read a specific line window of a large
  file instead of loading it whole.
- Use Bash ONLY for: running build/test commands, git operations,
  package managers (npm, pip, cargo), and other CLI tasks that don't
  have a dedicated tool.
- When using Bash: commands must be non-interactive (no stdin prompts).
  Add --yes or equivalent flags for package managers.
- Call independent tools in PARALLEL for maximum efficiency.
  Example: reading 3 files → 3 simultaneous Read calls.
  Example: Grep + Glob → parallel calls.`;
}

function buildOutputStyleSection(style: string): string {
  return `OUTPUT STYLE:\n\n${outputStylePrompt(style)}`;
}

function buildDestructiveActionsSection(): string {
  return `DESTRUCTIVE ACTIONS:

Before performing potentially destructive actions, consider:
- Is this reversible? Can the user undo easily?
- What is the blast radius? How many things could break?
- Does this affect files outside the workspace?

The following ALWAYS require explicit user confirmation:
- Deleting files or directories (rm, del, etc.)
- Force-pushing to git (git push --force)
- Database modifications (DROP, DELETE, TRUNCATE)
- Installing packages that execute postinstall scripts
- Running commands that pipe downloaded content to a shell (curl|bash)`;
}

function buildToolDescriptionsSection(tools: Tool[]): string {
  const lines = ["AVAILABLE TOOLS:", ""];
  for (const tool of tools) {
    if (!tool.isEnabled()) continue;
    lines.push(
      `${tool.name} — ${tool.promptDescription}`,
      `  Parameters: ${JSON.stringify(tool.inputSchema.properties)}`,
      "",
    );
  }
  return lines.join("\n");
}

// ============================================================
// Memoized dynamic-section registry (kernel §4)
// ============================================================
// Dynamic sections are computed through a name-keyed cache that survives across
// turns and is invalidated only on a session reset (/clear, /compact). Two ways
// to register:
//
//   systemPromptSection(name, compute)
//     — memoized. Computed once, reused until resetSystemPromptCache().
//
//   DANGEROUS_uncachedSystemPromptSection(name, compute, reason)
//     — recomputed EVERY call. The `reason` is mandatory: breaking the cache
//       must be an explicit, auditable decision, never an accident. Used for
//       values that genuinely drift between turns (the date, MCP server state).
//
// The discipline is the point: most sections are memoized; the few that bust
// the cache must say why, so "accidentally recomputed every turn" can't happen.

const sectionCache = new Map<string, string>();
/** Names registered via the DANGEROUS_ variant, with their stated reason. */
const uncachedReasons = new Map<string, string>();

/** Register/resolve a memoized section. Computed once, reused until reset. */
export function systemPromptSection(name: string, compute: () => string): string {
  const hit = sectionCache.get(name);
  if (hit !== undefined) return hit;
  const value = compute();
  sectionCache.set(name, value);
  return value;
}

/**
 * Register/resolve a section that is recomputed on every call (cache-busting).
 * `reason` documents WHY this section cannot be cached — it is recorded for
 * audit (see listUncachedSections) so cache busts stay visible and rare.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: () => string,
  reason: string,
): string {
  uncachedReasons.set(name, reason);
  return compute();
}

/** Clear the memoized section cache. Wire to /clear and /compact. */
export function resetSystemPromptCache(): void {
  sectionCache.clear();
}

/** The recorded reasons for every cache-busting section (for audit/tests). */
export function listUncachedSections(): ReadonlyMap<string, string> {
  return uncachedReasons;
}

// ============================================================
// Dynamic sections — below the boundary, never cached into the prefix
// ============================================================

/**
 * Environment info as its own recomputable block (kernel §5). cwd / platform /
 * shell / OS / model — stable within a session, so memoized; but kept BELOW the
 * boundary because the values vary across machines and the prefix above must be
 * byte-identical for all sessions. The date is deliberately NOT here — it goes
 * through a runtime reminder (see buildDateReminder) so this block stays
 * date-free and cacheable.
 */
function computeEnvInfo(workspaceRoot: string, model?: string): string {
  const lines = [
    "# Environment",
    `- Working directory: ${workspaceRoot}`,
    `- Platform: ${process.platform}`,
    `- Shell: ${process.env.SHELL || process.env.ComSpec || "unknown"}`,
    `- OS: ${process.platform} ${process.env.OS || ""}`.trimEnd(),
  ];
  if (model) lines.push(`- Model: ${model}`);
  if (process.platform === "win32") {
    lines.push("- On Windows, prefer Unix shell syntax where the shell is bash.");
  }
  lines.push(
    "",
    "Note: Prefer absolute paths over relative paths. The shell's cwd may reset",
    "between Bash calls, so do not rely on a persisted cwd — pass absolute paths.",
  );
  return lines.join("\n");
}

/**
 * The current date, delivered as a `<system-reminder>` rather than baked into
 * any cacheable text (kernel §5). This is the one value most likely to silently
 * bust a daily cache, so it lives here, isolated, and recomputed every build.
 */
function buildDateReminder(): string {
  const date = new Date().toISOString().split("T")[0];
  return DANGEROUS_uncachedSystemPromptSection(
    "date",
    () => `<system-reminder>\nToday's date is ${date}.\n</system-reminder>`,
    "the calendar date changes daily; caching it would serve a stale date",
  );
}

export interface SystemPromptOptions {
  workspaceRoot: string;
  tools: Tool[];
  /** Content of CLAUDE.md from workspace root */
  claudeMdContent?: string;
  /** Git status info */
  gitStatus?: string;
  /** Language preference detected from user */
  languagePreference?: string;
  /** Active model id, surfaced in the environment block */
  model?: string;
  /** MCP server instructions, if any servers are connected */
  mcpInstructions?: string;
  /** Active output style name (default / explanatory / learning / custom). */
  outputStyle?: string;
}

// ============================================================
// Boundary + assembly
// ============================================================

/**
 * The cache-boundary marker. Everything above is the stable, cacheable prefix;
 * everything from this block down is session/user-specific. The Anthropic
 * adapter (formatSystemForAnthropic) places its cache_control breakpoint here.
 * Its literal value is part of the cross-module contract — do not change it
 * without updating the adapter + tests.
 */
export const DYNAMIC_BOUNDARY =
  "--- SYSTEM PROMPT DYNAMIC BOUNDARY ---\n" +
  "Everything below this line is session/user-specific and cannot be cached.";

/**
 * Build the system prompt as an ORDERED ARRAY of blocks (kernel §4). Static
 * blocks come first (cacheable prefix), then the boundary, then the dynamic
 * blocks. Join with `renderSystemPrompt` before sending to a provider — the
 * boundary block is preserved in the joined string so adapters can still split
 * on it to place a cache breakpoint.
 *
 * `CLAUDE_CODE_SIMPLE=1` is an escape hatch: returns a single minimal block,
 * for debugging or running against a degraded/strict provider.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string[] {
  if (process.env.CLAUDE_CODE_SIMPLE === "1") {
    return ["You are an interactive AI coding assistant. Help with the user's task."];
  }

  // --- Static, cacheable prefix (memoized; identical across sessions) ---
  // The output-style section is memoized per style name so switching styles
  // recomputes only that block while the rest of the prefix stays cached.
  const outputStyle = options.outputStyle ?? "default";
  const staticBlocks = [
    systemPromptSection("identity", buildIdentitySection),
    systemPromptSection("coding_rules", buildCodingRulesSection),
    systemPromptSection("tool_usage", buildToolUsageSection),
    systemPromptSection(`output_style:${outputStyle}`, () => buildOutputStyleSection(outputStyle)),
    systemPromptSection("destructive_actions", buildDestructiveActionsSection),
    // Tool descriptions are stable within a session (the enabled tool set does
    // not change turn-to-turn), so they belong in the cacheable prefix.
    buildToolDescriptionsSection(options.tools),
  ];

  // --- Dynamic suffix (below the boundary; values drift at runtime) ---
  const dynamicBlocks: string[] = [DYNAMIC_BOUNDARY];

  dynamicBlocks.push(buildDateReminder());
  dynamicBlocks.push(computeEnvInfo(options.workspaceRoot, options.model));

  if (options.claudeMdContent) {
    dynamicBlocks.push(`[PROJECT CONTEXT from CLAUDE.md]\n${options.claudeMdContent}`);
  }
  if (options.gitStatus) {
    dynamicBlocks.push(`[GIT STATUS]\n${options.gitStatus}`);
  }
  if (options.languagePreference) {
    dynamicBlocks.push(
      `[LANGUAGE PREFERENCE]\nThe user prefers responses in: ${options.languagePreference}`,
    );
  }
  if (options.mcpInstructions) {
    // MCP servers connect/disconnect between turns, so this is intentionally
    // cache-busting when present.
    dynamicBlocks.push(
      DANGEROUS_uncachedSystemPromptSection(
        "mcp_instructions",
        () => `[MCP SERVERS]\n${options.mcpInstructions}`,
        "MCP servers connect/disconnect between turns; their instructions drift",
      ),
    );
  }
  // Scratchpad: a stable reminder that the model may think before acting.
  dynamicBlocks.push(
    "[SCRATCHPAD]\nThink step by step before acting on complex tasks. Plan, then execute.",
  );

  return [...staticBlocks, ...dynamicBlocks];
}

/** Join system-prompt blocks into the single string a ModelCaller expects. */
export function renderSystemPrompt(blocks: string[]): string {
  return blocks.join("\n\n");
}
