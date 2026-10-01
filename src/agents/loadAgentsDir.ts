// ============================================================
// Disk Sub-agent Source — load <name>.md from .claude/agents/
// ============================================================
// Real Claude Code lets users define their own sub-agents as Markdown files
// under `<root>/.claude/agents/` (and `~/.claude/agents/`). Each file declares
// frontmatter + a body that becomes the sub-agent's system prompt. This module
// scans those directories and registers every valid file as a SubagentType, so
// the Task tool's `subagent_name` enum and the /agents listing pick them up
// automatically.
//
// File shape:
//
//   ---
//   name: pr-reviewer
//   description: Review a diff for correctness and security
//   whenToUse: When you want an independent review of pending changes
//   tools: [read, grep, glob]
//   maxTurns: 20
//   memory: project
//   model: sonnet
//   ---
//   You are a careful pull-request reviewer. Read the diff and report …
//
// `tools` maps to the SubagentType's `toolNames`; `maxTurns` and `memory` are
// passed through. `model` is parsed and surfaced on the type for /agents but
// does not override the session model (sub-agent loops inherit the parent's
// model config). The body is the sub-agent's system prompt.
// ============================================================

import * as path from "node:path";
import { registerSubagentType, type SubagentType } from "../subagents.js";
import { loadDiskEntries } from "../utils/disk-loader.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { ccrPath } from "../workspace-config.js";

/** User-scope agents root can be redirected for tests / sandboxes. */
const USER_AGENTS_ENV = "CCR_USER_AGENTS_DIR";

/** Roots scanned for disk agents, lowest → highest precedence (project wins). */
export function agentDirRoots(workspaceRoot: string): string[] {
  const roots = [ccrPath(workspaceRoot, "agents")];
  if (process.env[USER_AGENTS_ENV]) roots.unshift(process.env[USER_AGENTS_ENV]!);
  return roots;
}

/** Reject an agent filename that would escape the agents root. */
function isSafeAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name !== "." && name !== "..";
}

function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v)
    ? v
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function asNumber(v: string | string[] | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Build a SubagentType from one parsed `.md` file. */
function agentFromFile(
  name: string,
  body: string,
  frontmatter: Record<string, string | string[]>,
): SubagentType {
  const memory = asString(frontmatter.memory);
  return {
    name: asString(frontmatter.name) || name,
    description: asString(frontmatter.description) || `Sub-agent "${name}"`,
    whenToUse: asString(frontmatter.whenToUse),
    toolNames: asList(frontmatter.tools) ?? [],
    systemPrompt: body,
    maxTurns: asNumber(frontmatter.maxTurns),
    // memory must be one of the supported scopes, or undefined.
    memory: memory === "user" || memory === "project" || memory === "local" ? memory : undefined,
  };
}

/**
 * Scan the disk agent roots and register every valid `<name>.md`. Returns the
 * names registered (project entries override same-named user entries). Missing
 * roots are skipped silently — disk agents are optional.
 */
export function loadAgentsDir(workspaceRoot: string): string[] {
  return loadDiskEntries({
    roots: agentDirRoots(workspaceRoot),
    accepts: (entry) => entry.isFile() && entry.name.endsWith(".md"),
    nameOf: (entry) => {
      const name = entry.name.slice(0, -".md".length);
      return isSafeAgentName(name) ? name : undefined;
    },
    fileOf: (root, entry) => path.join(root, entry.name),
    parse: (entry) => {
      const { frontmatter, body } = parseFrontmatter(entry.raw);
      return body ? agentFromFile(entry.name, body, frontmatter) : undefined;
    },
    register: registerSubagentType,
  });
}
