// ============================================================
// Official tool-name compatibility (Claude Code parity)
// ============================================================
// Sibling of utils/official-params.ts, which handles tool PARAMETER names. This
// module handles tool NAMES.
//
// Official Claude Code exposes `Read`, `Edit`, `Write`, `WebFetch`, `Bash`,
// `TodoWrite`, `TaskOutput`, `AskUserQuestion`, `ListMcpResources`, … while this
// project registers `read`, `edit`, `write`, `web_fetch`, `bash`, `todo`,
// `job_output`, `ask_user_question`, `mcp_list_resources`, …
//
// Before this module every lookup was `tools.find(t => t.name === name)`, so a
// model using official names got `Tool "Read" is not available.` — it could not
// run a single call. That is the same class of defect as the parameter-name gap
// and just as blocking: several third-party models are trained on Claude-shaped
// tool names, and official skills/subagents/hooks are written against them.
//
// One resolver, used by execution, early streaming execution, both provider
// adapters, speculative prefetch, sub-agent tool sets and permission rules — so
// those paths can no longer disagree about what a tool is called. Before, only
// permission rules normalized (through a hand-maintained alias table in
// permission-policy.ts), so a rule could match a tool that execution then
// refused to find.
//
// Derivation is the primary mechanism: inserting `_` at camel-case boundaries
// turns `AskUserQuestion` into `ask_user_question` and `NotebookEdit` into
// `notebook_edit`, which covers almost everything. The table below is only for
// the pairs where official and this project genuinely disagree on the WORD, not
// just the casing — aliasing those would paper over a real naming difference.
// ============================================================

/**
 * Official name → this project's name, keyed by the official name lowercased
 * and stripped of separators.
 *
 * This table is the AUTHORITY for every official name whose words run together
 * without a separator. It cannot be derived: nothing distinguishes `webfetch` →
 * `web_fetch` from `webfetch` → `webfetch` without knowing the words. Both the
 * camelCase form (`WebFetch`) and the concatenated form (`webfetch`, which is
 * what permission rules are usually written in) lowercase to the same key, so
 * one entry covers both.
 *
 * Only genuine word-for-word differences belong here. Names that merely differ
 * in casing — `Read`, `Edit`, `Bash`, `Grep`, `Glob`, `Task`, `Agent`,
 * `NotebookEdit`, `EnterWorktree`, `ExitPlanMode`, `TaskCreate`, `CronCreate`,
 * `ScheduleWakeup`, `Workflow`, `REPL`, `ReportFindings` — are handled by the
 * camel→snake fallback in canonicalToolKey, so they are deliberately absent.
 */
export const OFFICIAL_TOOL_NAME_ALIASES: Record<string, string> = {
  webfetch: "web_fetch",
  websearch: "web_search",
  askuserquestion: "ask_user_question",
  enterplanmode: "enter_plan_mode",
  exitplanmode: "exit_plan_mode",
  enterworktree: "enter_worktree",
  exitworktree: "exit_worktree",
  multiedit: "multi_edit",
  // Word-level differences, not just casing.
  notebookedit: "notebook_edit",
  todowrite: "todo",
  taskoutput: "job_output",
  joboutput: "job_output",
  jobkill: "job_kill",
  joblist: "job_list",
  listmcpresources: "mcp_list_resources",
  readmcpresource: "mcp_read_resource",
  readmcpresourcedir: "mcp_read_resource",
  clawondesign: "designsync",
};

/**
 * The canonical, comparison-safe form of a tool name.
 *
 * Both sides of every comparison — a rule's tool name, a registered tool's
 * name, a model's requested name — go through here, which is what makes the
 * permission, execution and visibility paths agree by construction.
 */
export function canonicalToolKey(name: string): string {
  const trimmed = name.trim();
  const alias = OFFICIAL_TOOL_NAME_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Find the registered tool a model meant, tolerating official spellings.
 *
 * Exact match first — the common path allocates nothing and can never surprise
 * — then the canonical comparison. Returns undefined for a genuinely unknown
 * name so callers keep reporting `Unknown tool: X` rather than silently
 * substituting something else.
 */
export function resolveTool<T extends { name: string }>(name: string, tools: T[]): T | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const key = canonicalToolKey(name);
  return tools.find((t) => canonicalToolKey(t.name) === key);
}
