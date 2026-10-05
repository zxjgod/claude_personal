// ============================================================
// Inline Agent Definitions — the official `--agents <json>` flag
// ============================================================
// Official Claude Code lets a single command line carry ad-hoc agent
// definitions that live for that session only:
//
//   ccr --agents '{"reviewer":{"description":"…","prompt":"…"}}' --agent reviewer
//
// This module owns the JSON → SubagentType translation and its validation.
// It deliberately does NOT read argv: the flag layer (cli-session-flags.ts)
// hands over raw text, so the shape rules stay testable on their own.
//
// Validation policy — the reason this is not a `JSON.parse` plus a cast:
// an unrecognised key or a mistyped field would otherwise be dropped
// silently and the agent would come up with defaults the user never asked
// for, which is indistinguishable from the flag working. So:
//   - structural problems (not an object, missing/blank description or
//     prompt, a name that is not filename-safe, a wrong type for a KNOWN
//     field) are hard errors naming the offending agent and field;
//   - UNKNOWN keys are warnings, not errors, so a definition written for a
//     newer official release still boots with the parts we do understand.
// ============================================================

import { registerSubagentType, type SubagentType } from "../subagents.js";

export interface InlineAgentsResult {
  agents: SubagentType[];
  /** Fatal problems: nothing is registered when this is non-empty. */
  errors: string[];
  /** Non-fatal notes, e.g. unrecognised keys. */
  warnings: string[];
}

/** Mirrors the on-disk agent filename rule in loadAgentsDir. */
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const KNOWN_KEYS = new Set([
  "description",
  "prompt",
  "systemPrompt",
  "whenToUse",
  "tools",
  "disallowedTools",
  "model",
  "effort",
  "skills",
  "permissionMode",
  "background",
  "isolation",
  "maxTurns",
  "memory",
]);

function asStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Parse one `<name>: <definition>` entry. Returns the agent plus any problem,
 * so one bad entry does not hide the problems in the next.
 */
function agentFromDefinition(
  name: string,
  definition: unknown,
  errors: string[],
  warnings: string[],
): SubagentType | undefined {
  const where = `agent "${name}"`;
  if (!SAFE_NAME.test(name)) {
    errors.push(
      `${where}: invalid name — use 1-64 characters from A-Z a-z 0-9 _ - (a disk agent's file name must satisfy the same rule).`,
    );
    return undefined;
  }
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    errors.push(`${where}: definition must be a JSON object.`);
    return undefined;
  }
  const def = definition as Record<string, unknown>;
  for (const key of Object.keys(def)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${where}: ignoring unrecognised field "${key}".`);
  }

  // `prompt` is the official spelling; `systemPrompt` is accepted because it is
  // what the on-disk .md loader and SubagentType itself call it, and users copy
  // between the two forms constantly.
  const prompt = asOptionalString(def.prompt) ?? asOptionalString(def.systemPrompt);
  if (!prompt) {
    errors.push(`${where}: "prompt" is required and must be a non-empty string.`);
    return undefined;
  }
  const description = asOptionalString(def.description);
  if (!description) {
    errors.push(`${where}: "description" is required and must be a non-empty string.`);
    return undefined;
  }

  const tools = asStringList(def.tools);
  if (def.tools !== undefined && !tools) {
    errors.push(`${where}: "tools" must be an array of strings.`);
    return undefined;
  }
  const disallowedTools = asStringList(def.disallowedTools);
  if (def.disallowedTools !== undefined && !disallowedTools) {
    errors.push(`${where}: "disallowedTools" must be an array of strings.`);
    return undefined;
  }
  const skills = asStringList(def.skills);
  if (def.skills !== undefined && !skills) {
    errors.push(`${where}: "skills" must be an array of strings.`);
    return undefined;
  }
  const maxTurns = asOptionalNumber(def.maxTurns);
  if (def.maxTurns !== undefined && maxTurns === undefined) {
    errors.push(`${where}: "maxTurns" must be a number.`);
    return undefined;
  }
  if (def.background !== undefined && typeof def.background !== "boolean") {
    errors.push(`${where}: "background" must be a boolean.`);
    return undefined;
  }
  const memory = asOptionalString(def.memory);
  if (def.memory !== undefined && memory !== "user" && memory !== "project" && memory !== "local") {
    errors.push(`${where}: "memory" must be one of "user", "project", "local".`);
    return undefined;
  }
  const isolation = asOptionalString(def.isolation);
  if (def.isolation !== undefined && isolation !== "worktree") {
    errors.push(`${where}: "isolation" must be "worktree".`);
    return undefined;
  }

  return {
    name,
    description,
    whenToUse: asOptionalString(def.whenToUse),
    toolNames: tools ?? [],
    // Omitting `tools` means "inherit the parent's set", matching the .md
    // loader — an agent that declared no tools asked for no restriction, not
    // for zero tools.
    inheritTools: def.tools === undefined,
    disallowedTools,
    model: asOptionalString(def.model),
    effort: asOptionalString(def.effort),
    skills,
    permissionMode: asOptionalString(def.permissionMode),
    hooks: undefined,
    background: def.background === true,
    isolation: isolation === "worktree" ? "worktree" : undefined,
    systemPrompt: prompt,
    maxTurns,
    memory: memory === "user" || memory === "project" || memory === "local" ? memory : undefined,
  };
}

/**
 * Parse the `--agents` payload.
 *
 * All-or-nothing on structural errors: registering the subset that happened to
 * be well-formed would give a session that runs with some requested agents
 * silently missing — the same silent-partial-success failure the flag is meant
 * to avoid. Warnings never block registration.
 */
export function parseInlineAgents(json: string): InlineAgentsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { agents: [], errors: [`--agents is not valid JSON: ${String(error)}`], warnings };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      agents: [],
      errors: [
        '--agents must be a JSON object mapping agent names to definitions, e.g. {"reviewer":{"description":"...","prompt":"..."}}.',
      ],
      warnings,
    };
  }
  const agents: SubagentType[] = [];
  for (const [name, definition] of Object.entries(parsed as Record<string, unknown>)) {
    const agent = agentFromDefinition(name, definition, errors, warnings);
    if (agent) agents.push(agent);
  }
  return errors.length > 0 ? { agents: [], errors, warnings } : { agents, errors, warnings };
}

/**
 * Parse and register. Registration happens only when nothing is wrong, and
 * AFTER the disk/plugin agents are loaded, so an inline definition with a
 * colliding name overrides them for this session — the precedence a user
 * expects when they type the definition out on the command line.
 */
export function registerInlineAgents(json: string): InlineAgentsResult {
  const result = parseInlineAgents(json);
  if (result.errors.length === 0) {
    for (const agent of result.agents) registerSubagentType(agent);
  }
  return result;
}
