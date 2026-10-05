// ============================================================
// Official parameter-name compatibility (Claude Code parity)
// ============================================================
// Official Claude Code spells tool parameters in snake_case — `file_path`,
// `notebook_path`, `new_source` — while this project's internals use
// camelCase (`filePath`, `cellIndex`, `source`). Both spellings therefore
// address the SAME argument, and nothing reconciled them: a model (or an
// official skill / subagent / hook / hand-written call) using the official
// name got `Unrecognized key: "file_path"` from the strictObject parse, or a
// raw TypeError when `.call()` was reached without validation.
//
// That is a kernel-parity defect, not a cosmetic naming choice. Official
// prompts, documentation, skills and hooks all say `file_path`; several
// third-party models are trained on Claude-shaped tool schemas and emit it
// unprompted. The most frequently called tools in the product were unusable
// through the official spelling.
//
// The fix has to be bidirectional and non-breaking:
//
//   1. The model-facing JSON Schema advertises the OFFICIAL spelling as
//      canonical (`file_path`, marked required), because that is what the
//      model should be told to emit. The legacy camelCase stays as an
//      accepted, optional alias so existing configs, transcripts, docs and
//      tests keep working.
//   2. Input is normalized official → internal BEFORE `safeParse`, so
//      internal code (getPath, checkPermissions, call) only ever sees the
//      canonical internal name. Normalization happens inside validateInput,
//      which the executor runs BEFORE permission checks (tool-executor.ts:
//      validate → checkPermissions → call), so permission decisions are made
//      on normalized input and an alias can never bypass a path check.
//
// Aliases are declared only where official's name means exactly what our
// internal name means. NotebookEdit `cell_id` qualifies only because `cellId`
// was implemented as a genuine content-addressed lookup first — see that entry.
// ============================================================

export interface OfficialParamAlias {
  /** The name official Claude Code uses for this argument. */
  official: string;
  /** The name this project uses internally. */
  internal: string;
}

export const OFFICIAL_PARAM_ALIASES: Record<string, OfficialParamAlias[]> = {
  read: [{ official: "file_path", internal: "filePath" }],
  write: [{ official: "file_path", internal: "filePath" }],
  edit: [{ official: "file_path", internal: "filePath" }],
  multi_edit: [{ official: "file_path", internal: "filePath" }],
  notebook_edit: [
    { official: "notebook_path", internal: "filePath" },
    { official: "new_source", internal: "source" },
    { official: "cell_type", internal: "cellType" },
    { official: "edit_mode", internal: "mode" },
    // Official `cell_id` is content-addressed (the cell's own Jupyter id) while
    // the old `cellIndex` was a 0-based position — aliasing those two WOULD edit
    // the wrong cell. So `cellId` was implemented as a real content-addressed
    // lookup instead (notebook_edit), which makes the rename safe: both sides
    // now mean "the cell carrying this id".
    { official: "cell_id", internal: "cellId" },
  ],
  web_fetch: [{ official: "prompt", internal: "fetchInfo" }],
  job_output: [
    { official: "task_id", internal: "job_id" },
    { official: "block", internal: "wait" },
    { official: "timeout", internal: "timeout_ms" },
  ],
  lsp_diagnostics: [{ official: "file_path", internal: "filePath" }],
  lsp_completions: [{ official: "file_path", internal: "filePath" }],
  lsp: [{ official: "file_path", internal: "filePath" }],
  // Official `context` is exactly our `-C`: lines before AND after each match.
  // Official `offset` (skip the first N results) is implemented outright in
  // grep.ts, so it is a real parameter rather than an alias.
  grep: [{ official: "context", internal: "-C" }],
  // Official `script` and our `plan` are both "the orchestration input". NOT
  // strictly identical — official's script is a JS module, ours is JSON data —
  // so Workflow.call() rejects a non-`{` script with a specific message instead
  // of letting it die in JSON.parse.
  workflow: [{ official: "script", internal: "plan" }],
};

function aliasesFor(toolName: string): OfficialParamAlias[] {
  return OFFICIAL_PARAM_ALIASES[toolName] ?? [];
}

/**
 * Rewrite official parameter names to their internal spelling.
 *
 * Returns the SAME reference when nothing applies (the common case, so the hot
 * path allocates nothing). When an argument arrives under BOTH spellings the
 * internal one wins and the official duplicate is dropped, rather than failing
 * the strict parse — the two cannot disagree in practice, and erroring here
 * would be a worse outcome than picking one.
 */
export function normalizeOfficialParams(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = aliasesFor(toolName);
  if (aliases.length === 0) return input;
  let out = input;
  for (const { official, internal } of aliases) {
    if (!(official in input)) continue;
    if (out === input) out = { ...input };
    const value = out[official];
    delete out[official];
    if (!(internal in out)) out[internal] = value;
  }
  return out;
}

/**
 * Present the official spelling as canonical in the model-facing JSON Schema.
 *
 * The internal property keeps its description and type but is demoted to an
 * optional alias, and the parameter is dropped from `required` entirely —
 * NOT renamed to the official spelling (review fix): JSON Schema `required`
 * is a literal key list, so `required: ["file_path"]` makes provider-side
 * strict validation REJECT a call that uses the advertised `filePath` alias.
 * Neither spelling can be marked required without rejecting the other, so
 * presence is enforced by our own validateInput instead (its error names the
 * advertised spelling via advertisedParamName).
 */
export function applyOfficialParamAliases(
  toolName: string,
  properties: Record<string, unknown>,
  required: string[],
): { properties: Record<string, unknown>; required: string[] } {
  const aliases = aliasesFor(toolName);
  if (aliases.length === 0) return { properties, required };
  const props = { ...properties };
  const req = required.slice();
  for (const { official, internal } of aliases) {
    const spec = props[internal];
    // The tool does not actually declare this parameter — never advertise a
    // name we would then reject at parse time.
    if (spec === undefined || official === internal) continue;
    props[official] = spec;
    props[internal] = {
      ...(spec as Record<string, unknown>),
      description:
        `${(spec as { description?: string }).description ?? ""} (legacy alias for \`${official}\`; \`${official}\` is preferred)`.trim(),
    };
    // Required-ness is NOT transferable (see the doc comment): drop the
    // parameter from `required` rather than renaming it, so provider-side
    // strict schema validation accepts either spelling.
    const index = req.indexOf(internal);
    if (index !== -1) req.splice(index, 1);
  }
  return { properties: props, required: req };
}

/**
 * The advertised spelling of a parameter — official when it has one.
 *
 * Validation errors must name the parameter the model was actually TOLD to
 * use. The schema advertises `file_path`, so reporting `filePath: Required`
 * sends the model looking for a parameter that does not appear in its schema.
 */
export function advertisedParamName(toolName: string, internal: string): string {
  return aliasesFor(toolName).find((a) => a.internal === internal)?.official ?? internal;
}

/**
 * The `tool_input` object a hook command receives.
 *
 * Official hook configs interpolate `${tool_input.file_path}`; the runtime only
 * holds the internal `filePath`. Emitting both keys lets an unmodified official
 * hook resolve its placeholders while any hook already written against this
 * project keeps working. This is a serialization-time expansion only — the
 * executor's internal object is untouched, so hook input rewrites are still
 * validated against the real schema.
 */
export function hookToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = aliasesFor(toolName);
  if (aliases.length === 0) return input;
  let out = input;
  for (const { official, internal } of aliases) {
    if (official in input || !(internal in input)) continue;
    if (out === input) out = { ...input };
    out[official] = input[internal];
  }
  return out;
}
