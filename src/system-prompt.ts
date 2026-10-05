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
import type { PermissionPolicy } from "./permission-policy.js";
import { visibleTools } from "./tools/registry.js";
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

/**
 * One line per ENABLED tool: `name — description` (the short UI-facing field),
 * sorted by name codepoint. This section is an INDEX, not documentation: the
 * authoritative full description (`promptDescription`) and the JSON Schema
 * travel in the API `tools` argument on every request — the old code dumped
 * promptDescription here too, double-carrying ~3.6k tokens per request and
 * contradicting this section's own comment (Top10 #10).
 *
 * Sorting matters for caching: the registry's Map order shifts when MCP tools
 * re-register mid-session, and an unstable order changes this section's bytes,
 * busting the entire cacheable prefix even when the tool SET is unchanged.
 * Codepoint comparison (not localeCompare) so the order is byte-stable across
 * machines and ICU builds.
 */
function buildToolDescriptionsSection(tools: Tool[], policy?: PermissionPolicy): string {
  const lines = ["AVAILABLE TOOLS:", ""];
  const enabled = visibleTools(tools, policy).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const tool of enabled) {
    lines.push(`${tool.name} — ${tool.description}`, "");
  }
  return lines.join("\n");
}

/**
 * djb2 fingerprint of the enabled tool set (sorted name+description pairs) —
 * the memo key for the tools section. Sorted so a pure registry reorder (MCP
 * re-registration) fingerprints identically and the memo (and the prompt
 * prefix) survives; any real content change produces a new key. A trailing
 * separator per part (fourth-round review) removes the boundary ambiguity
 * where one part's description ends in NUL and the next part's name begins —
 * two different sets could otherwise fold into the same byte stream.
 */
function toolSetFingerprint(tools: Tool[], policy?: PermissionPolicy): string {
  const parts = visibleTools(tools, policy)
    .map((t) => `${t.name}\0${t.description}\0`)
    .sort();
  let h = 5381;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h = ((h << 5) + h + part.charCodeAt(i)) | 0;
    }
  }
  return (h >>> 0).toString(36);
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
  /**
   * Active permission policy. Tools it denies outright are withheld from the
   * AVAILABLE TOOLS index, matching what the adapters send in the `tools`
   * argument — the index and the payload must advertise the same set or the
   * model reads about a capability it cannot actually call.
   */
  permissionPolicy?: PermissionPolicy;
  /**
   * Official `--agent <name>`: the selected sub-agent's persona for this
   * session. Its prompt is PREPENDED to the identity section rather than
   * replacing it, because the harness contract below this point (coding rules,
   * tool descriptions, permission boundaries) is what keeps the model honest
   * about what it can actually do — an agent definition should not be able to
   * erase that. Documented as a deviation from the official flag.
   */
  agentPersona?: { name: string; prompt: string };
  /**
   * Official `--brief`: SendUserMessage is registered for this session, so the
   * prompt tells the model how to use the channel. Omitted when the flag is
   * absent (the default) — the section would otherwise advertise a tool the
   * model cannot call.
   */
  brief?: boolean;
  /**
   * Official `--file <specs...>`: files pulled from the Files API into
   * `<cwd>/<sessionId>/uploads/` at startup. Both the landed files AND the
   * ones that failed are listed — a spec that did not download must never
   * read to the model as one that did.
   */
  startupFiles?: Array<{ path: string; bytesWritten?: number; error?: string }>;
}

/**
 * The `--file` section: where startup-downloaded resources landed, and which
 * requests failed. The failure lines are load-bearing — without them a model
 * asked about a missing attachment would answer from imagination.
 */
export function buildStartupFilesSection(
  files: Array<{ path: string; bytesWritten?: number; error?: string }>,
): string {
  const landed = files.filter((f) => !f.error);
  const failed = files.filter((f) => f.error);
  const lines: string[] = [
    "[STARTUP FILES]",
    "Files requested with --file were downloaded into this workspace:",
  ];
  for (const f of landed) {
    lines.push(`- ${f.path} (${f.bytesWritten ?? 0} bytes) — read it with the Read tool.`);
  }
  if (failed.length > 0) {
    lines.push("These --file requests did NOT download. Do not act as if they exist:");
    for (const f of failed) lines.push(`- ${f.error}`);
  }
  return lines.join("\n");
}

/**
 * The `--brief` prompt section.
 *
 * Adapted from official's `BRIEF_PROACTIVE_SECTION`, which tells the model that
 * text outside SendUserMessage is "visible if the user expands the detail
 * view, but most won't". That is a fact about official's chat view, not about
 * this terminal, where plain assistant text is fully visible — stating it
 * verbatim would teach the model to distrust output the user actually reads.
 * The behavioural substance is kept (ack → work → result, checkpoints at phase
 * boundaries, second person, tight messages); the claim about visibility is not.
 */
export function buildBriefChannelSection(): string {
  return [
    "[BRIEF CHANNEL]",
    "SendUserMessage is your dedicated line to the user. It reaches them verbatim and",
    "survives independently of whatever tool call happened to run last, so anything",
    "meant to be READ goes through it. Narration printed around a tool call is not a",
    "substitute: the user asked a question, and a paragraph about running tests is not",
    "the answer.",
    "",
    "When the user says something, the reply they read comes through SendUserMessage.",
    "",
    "If you can answer right away, send the answer. If you need to go look — run a",
    "command, read files, check something — ack first in one line, then work, then send",
    "the result. Without the ack they are staring at a spinner.",
    "",
    "For longer work: ack → work → result. Between those, send a checkpoint when",
    "something useful happened — a decision you made, a surprise you hit, a phase",
    'boundary. Skip the filler ("running tests..."): a checkpoint earns its place by',
    "carrying information.",
    "",
    "Keep messages tight — the decision, the file:line, the PR number. Second person",
    'always ("your config"), never third.',
  ].join("\n");
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
  // The tools section is memoized under a tool-set fingerprint key (Top10 #10):
  // it used to be the ONLY static block rebuilt raw every turn, so an MCP
  // connect/disconnect mid-session (registry re-register changes both content
  // and Map order) silently changed the prefix bytes and busted the whole
  // provider prompt cache. Stale `tools:*` keys are evicted first so MCP churn
  // cannot accumulate dead entries; with the content sorted inside the section,
  // a pure reorder keeps the same fingerprint and stays cached.
  const toolsKey = `tools:${toolSetFingerprint(options.tools, options.permissionPolicy)}`;
  for (const key of [...sectionCache.keys()]) {
    if (key.startsWith("tools:") && key !== toolsKey) sectionCache.delete(key);
  }
  // Keyed by agent name so switching personas (a /agents switch, or a second
  // --agent build in one process during tests) recomputes only this block
  // instead of invalidating the whole static prefix.
  const persona = options.agentPersona;
  const staticBlocks = [
    systemPromptSection(persona ? `identity:agent:${persona.name}` : "identity", () =>
      persona
        ? `[SESSION AGENT: ${persona.name}]\n${persona.prompt}\n\n${buildIdentitySection()}`
        : buildIdentitySection(),
    ),
    systemPromptSection("coding_rules", buildCodingRulesSection),
    systemPromptSection("tool_usage", buildToolUsageSection),
    systemPromptSection(`output_style:${outputStyle}`, () => buildOutputStyleSection(outputStyle)),
    systemPromptSection("destructive_actions", buildDestructiveActionsSection),
    systemPromptSection(toolsKey, () =>
      buildToolDescriptionsSection(options.tools, options.permissionPolicy),
    ),
  ];
  // `--brief` is a per-process flag, so this block is part of the stable
  // prefix: a session that enables it pays the section once, and a session that
  // does not keeps the shorter cached prefix it already had.
  if (options.brief) staticBlocks.push(systemPromptSection("brief", buildBriefChannelSection));

  // --- Dynamic suffix (below the boundary; values drift at runtime) ---
  // Ordered MOST STABLE FIRST (Top10 follow-up A7③): prefix caching
  // invalidates everything after the first changed byte, so the drift-prone
  // blocks (date → git → MCP) go LAST. The old order put the date first —
  // one midnight rollover re-paid the full write price for CLAUDE.md, env and
  // everything below it; now a date change only invalidates date+git+mcp.
  const dynamicBlocks: string[] = [DYNAMIC_BOUNDARY];

  // Scratchpad: constant text — the most stable block below the boundary.
  dynamicBlocks.push(
    "[SCRATCHPAD]\nThink step by step before acting on complex tasks. Plan, then execute.",
  );

  if (options.claudeMdContent) {
    // Session-stable (the file rarely changes mid-session).
    dynamicBlocks.push(`[PROJECT CONTEXT from CLAUDE.md]\n${options.claudeMdContent}`);
  }
  dynamicBlocks.push(computeEnvInfo(options.workspaceRoot, options.model));
  if (options.languagePreference) {
    dynamicBlocks.push(
      `[LANGUAGE PREFERENCE]\nThe user prefers responses in: ${options.languagePreference}`,
    );
  }

  // Daily drift: the one value most likely to silently bust a cache.
  dynamicBlocks.push(buildDateReminder());

  // Per-turn drift: the git snapshot refreshes between turns.
  if (options.gitStatus) {
    dynamicBlocks.push(`[GIT STATUS]\n${options.gitStatus}`);
  }
  // `--file` resources: fixed for the session, but path content depends on
  // where the files landed, so it goes in the drift section rather than the
  // cached prefix. Listed LAST-but-one so a mid-session change still leaves
  // the MCP instructions — the most volatile of all — at the very end.
  if (options.startupFiles && options.startupFiles.length > 0) {
    dynamicBlocks.push(buildStartupFilesSection(options.startupFiles));
  }
  if (options.mcpInstructions) {
    // MCP servers connect/disconnect between turns, so this is intentionally
    // cache-busting when present — and therefore LAST.
    dynamicBlocks.push(
      DANGEROUS_uncachedSystemPromptSection(
        "mcp_instructions",
        () => `[MCP SERVERS]\n${options.mcpInstructions}`,
        "MCP servers connect/disconnect between turns; their instructions drift",
      ),
    );
  }

  return [...staticBlocks, ...dynamicBlocks];
}

/** Join system-prompt blocks into the single string a ModelCaller expects. */
export function renderSystemPrompt(blocks: string[]): string {
  return blocks.join("\n\n");
}
