// ============================================================
// System Prompt Builder — 6 static sections + dynamic boundary
// ============================================================

import type { Tool } from "./types.js";

/**
 * Section 1: Identity Declaration
 */
function buildIdentitySection(): string {
  return `You are an interactive AI coding assistant. You help users with software
engineering tasks including code analysis, debugging, refactoring, writing
new code, and explaining technical concepts.

SECURITY: Never suggest or execute commands that install malware, exfiltrate
data, or compromise system security. When asked to run suspicious commands,
explain the risk and refuse unless the user explicitly and knowingly approves
the dangerous operation.`;
}

/**
 * Section 2: Workspace Information (Dynamic)
 */
function buildWorkspaceSection(workspaceRoot: string): string {
  const date = new Date().toISOString().split("T")[0];
  return `OS Version: ${process.platform} ${process.env.OS || ""}
Shell: ${process.env.SHELL || process.env.ComSpec || "unknown"}
Workspace Folder: ${workspaceRoot}
Current date: ${date}

Note: Prefer absolute paths over relative paths. Use the workspace root
as the base for all file operations unless the user specifies otherwise.`;
}

/**
 * Section 3: Coding Rules
 */
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

/**
 * Section 4: Tool Usage Rules
 */
function buildToolUsageSection(): string {
  return `USING YOUR TOOLS:

- PREFER dedicated tools (Read, Edit, Write, Glob, Grep) over Bash for
  file operations. Tools are safer, faster, and more reliable.
- Use Glob to find files by name pattern (e.g., "src/**/*.ts").
- Use Grep to search file contents with regex patterns.
- Use Bash ONLY for: running build/test commands, git operations,
  package managers (npm, pip, cargo), and other CLI tasks that don't
  have a dedicated tool.
- When using Bash: commands must be non-interactive (no stdin prompts).
  Add --yes or equivalent flags for package managers.
- Call independent tools in PARALLEL for maximum efficiency.
  Example: reading 3 files → 3 simultaneous Read calls.
  Example: Grep + Glob → parallel calls.`;
}

/**
 * Section 5: Output Style
 */
function buildOutputStyleSection(): string {
  return `OUTPUT STYLE:

- Be concise and direct. Get to the point quickly.
- Do not add narration inside code blocks just to explain what the code does.
- Use the following format when citing code:
  \`\`\`startLine:endLine:filepath
- Respond in the same language as the user's query.
  If the user writes in Chinese, respond in Chinese.
- Minimize output tokens while maintaining quality.`;
}

/**
 * Section 6: Destructive Actions
 */
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
 * Build tool descriptions for system prompt
 */
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

/**
 * Dynamic boundary marker
 */
export const DYNAMIC_BOUNDARY =
  "--- SYSTEM PROMPT DYNAMIC BOUNDARY ---\n" +
  "Everything below this line is session/user-specific and cannot be cached.";

export interface SystemPromptOptions {
  workspaceRoot: string;
  tools: Tool[];
  /** Content of CLAUDE.md from workspace root */
  claudeMdContent?: string;
  /** Git status info */
  gitStatus?: string;
  /** Language preference detected from user */
  languagePreference?: string;
}

/**
 * Build the complete system prompt as an array of strings.
 * Join with "\n\n" at the end for sending to the LLM.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const staticSections = [
    buildIdentitySection(),
    buildWorkspaceSection(options.workspaceRoot),
    buildCodingRulesSection(),
    buildToolUsageSection(),
    buildOutputStyleSection(),
    buildDestructiveActionsSection(),
    buildToolDescriptionsSection(options.tools),
  ];

  const dynamicSections: string[] = [DYNAMIC_BOUNDARY];

  // User context from CLAUDE.md
  if (options.claudeMdContent) {
    dynamicSections.push(`[PROJECT CONTEXT from CLAUDE.md]\n${options.claudeMdContent}`);
  }

  // Git status
  if (options.gitStatus) {
    dynamicSections.push(`[GIT STATUS]\n${options.gitStatus}`);
  }

  // Language preference
  if (options.languagePreference) {
    dynamicSections.push(
      `[LANGUAGE PREFERENCE]\nThe user prefers responses in: ${options.languagePreference}`,
    );
  }

  return [...staticSections, ...dynamicSections].join("\n\n");
}

/**
 * Rebuild only dynamic sections without changing static sections.
 * Static sections are cached between requests.
 */
export function rebuildDynamicSections(
  currentPrompt: string,
  dynamicOptions: Pick<SystemPromptOptions, "claudeMdContent" | "gitStatus" | "languagePreference">,
): string {
  const boundaryIndex = currentPrompt.indexOf(DYNAMIC_BOUNDARY);
  if (boundaryIndex === -1) {
    // No boundary found, rebuild entirely
    return currentPrompt;
  }

  const staticPart = currentPrompt.slice(0, boundaryIndex);
  const dynamicSections: string[] = [DYNAMIC_BOUNDARY];

  if (dynamicOptions.claudeMdContent) {
    dynamicSections.push(`[PROJECT CONTEXT from CLAUDE.md]\n${dynamicOptions.claudeMdContent}`);
  }
  if (dynamicOptions.gitStatus) {
    dynamicSections.push(`[GIT STATUS]\n${dynamicOptions.gitStatus}`);
  }
  if (dynamicOptions.languagePreference) {
    dynamicSections.push(
      `[LANGUAGE PREFERENCE]\nThe user prefers responses in: ${dynamicOptions.languagePreference}`,
    );
  }

  return staticPart + dynamicSections.join("\n\n");
}
