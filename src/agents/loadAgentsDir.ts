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
//   omitClaudeMd: true
//   ---
//   You are a careful pull-request reviewer. Read the diff and report …
//
// `tools` maps to the SubagentType's `toolNames`; `maxTurns` and `memory` are
// passed through. `model` is honored by subagentModelConfig (alias resolution
// included) unless CLAUDE_CODE_SUBAGENT_MODEL forces one model onto every
// sub-agent. `omitClaudeMd: true` skips CLAUDE.md injection into the
// sub-agent's system prompt. The body is the sub-agent's system prompt.
// ============================================================

import * as path from "node:path";
import { userConfigRoot } from "../settings.js";
import { registerSubagentType, type SubagentType } from "../subagents.js";
import { loadDiskEntries } from "../utils/disk-loader.js";
import { frontmatterList, frontmatterString, parseFrontmatter } from "../utils/frontmatter.js";
import { ccrPath } from "../workspace-config.js";

/** User-scope agents root can be redirected for tests / sandboxes. */
const USER_AGENTS_ENV = "CCR_USER_AGENTS_DIR";

/** Roots scanned for disk agents, lowest → highest precedence (project wins). */
export function agentDirRoots(workspaceRoot: string): string[] {
  const roots = [ccrPath(workspaceRoot, "agents")];
  roots.unshift(process.env[USER_AGENTS_ENV] || path.join(userConfigRoot(), "agents"));
  return roots;
}

/** Reject an agent filename that would escape the agents root. */
function isSafeAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name !== "." && name !== "..";
}

const asString = frontmatterString;

const asList = frontmatterList;

/** Validate a frontmatter mcpServers map (拍板 #14-B). Defensive: entries
 * without a valid transport type are dropped; prototype-polluting keys too. */
function asMcpServers(value: unknown): SubagentType["mcpServers"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: NonNullable<SubagentType["mcpServers"]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const cfg = entry as Record<string, unknown>;
    if (cfg.type !== "stdio" && cfg.type !== "http" && cfg.type !== "sse" && cfg.type !== "ws")
      continue;
    out[key] = cfg as unknown as NonNullable<SubagentType["mcpServers"]>[string];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Build a SubagentType from one parsed `.md` file. */
function agentFromFile(
  name: string,
  body: string,
  frontmatter: Record<string, unknown>,
): SubagentType {
  const memory = asString(frontmatter.memory);
  return {
    name: asString(frontmatter.name) || name,
    description: asString(frontmatter.description) || `Sub-agent "${name}"`,
    whenToUse: asString(frontmatter.whenToUse),
    toolNames: asList(frontmatter.tools) ?? [],
    inheritTools: frontmatter.tools === undefined,
    disallowedTools: asList(frontmatter.disallowedTools ?? frontmatter["disallowed-tools"]),
    model: asString(frontmatter.model),
    effort: asString(frontmatter.effort),
    // 拍板 #21: per-agent thinking escape hatch (default is OFF globally).
    thinking:
      asString(frontmatter.thinking) === "true"
        ? true
        : asString(frontmatter.thinking) === "false"
          ? false
          : undefined,
    skills: asList(frontmatter.skills),
    permissionMode: asString(frontmatter.permissionMode),
    hooks: frontmatter.hooks,
    background: asString(frontmatter.background) === "true",
    isolation: asString(frontmatter.isolation) === "worktree" ? "worktree" : undefined,
    // Official field: skip user/project/local CLAUDE.md for this sub-agent.
    omitClaudeMd: asString(frontmatter.omitClaudeMd ?? frontmatter["omit-claude-md"]) === "true",
    // 拍板 #14-B: agent-scoped MCP servers (validated; connected per-run
    // under the fingerprint trust gate in agents/agent-mcp.ts).
    mcpServers: asMcpServers(frontmatter.mcpServers),
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
export function loadAgentsDir(
  workspaceRoot: string,
  options: { roots?: string[]; namespace?: string } = {},
): string[] {
  // The USER-owned root's agents are trusted to declare hooks; project-root
  // agents go through prepareAgentHooks' fingerprint gate (see SubagentType.
  // hooksTrusted). Mirrors the skills loader's user-root trust tier.
  const userRoot = path.resolve(
    process.env[USER_AGENTS_ENV] || path.join(userConfigRoot(), "agents"),
  );
  return loadDiskEntries({
    roots: options.roots ?? agentDirRoots(workspaceRoot),
    recursive: true,
    accepts: (entry) => entry.isFile() && entry.name.endsWith(".md"),
    nameOf: (entry) => {
      const name = entry.name.slice(0, -".md".length);
      return isSafeAgentName(name) ? name : undefined;
    },
    fileOf: (root, entry) => path.join(root, entry.name),
    parse: (entry) => {
      const { frontmatter, body } = parseFrontmatter(entry.raw);
      return body
        ? {
            ...agentFromFile(entry.name, body, frontmatter),
            hooksTrusted: path.resolve(entry.root) === userRoot,
          }
        : undefined;
    },
    register: (agent) =>
      registerSubagentType(
        options.namespace
          ? {
              ...agent,
              name: `${options.namespace}:${agent.name}`,
              hooks: undefined,
              permissionMode: undefined,
              skills: agent.skills?.map((name) =>
                name.includes(":") ? name : `${options.namespace}:${name}`,
              ),
            }
          : agent,
      ),
  });
}
