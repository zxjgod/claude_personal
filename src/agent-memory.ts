// ============================================================
// Agent Memory — per-agentType cross-session memory (M35, kernel §5)
// ============================================================
// Optional persistence that lets a repeatedly-used agent TYPE accumulate
// experience across sessions. Three scopes:
//
//   user    <userConfigRoot>/agent-memory/<type>/MEMORY.md  shared across projects
//   project .claude/agent-memory/<type>/MEMORY.md     shared via VCS
//   local   .claude/agent-memory-local/<type>/MEMORY.md  gitignored, env-redirectable
//
// loadAgentMemoryPrompt() ensures the directory exists, reads MEMORY.md if
// present, and returns a scope-tagged prompt block for injection into the
// agent's system prompt. A path-traversal guard rejects malicious agentType
// values so a crafted type ("../../etc") can't escape the memory root.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { userConfigRoot } from "./settings.js";
import { atomicWriteFile, withFileLock } from "./utils/file-lock.js";
import { ccrPath } from "./workspace-config.js";

export type MemoryScope = "user" | "project" | "local";

/** Local-scope root can be redirected for tests / sandboxes. */
const LOCAL_ENV = "CCR_AGENT_MEMORY_LOCAL_DIR";

/**
 * Reject an agentType that would escape its memory root (kernel §5). Allows
 * only a conservative slug; anything with a separator, "..", or empty result
 * throws. This runs before any path join, so traversal can't happen.
 */
export function assertSafeAgentType(agentType: string): string {
  const t = agentType.trim();
  if (!t || !/^[a-zA-Z0-9_-]+$/.test(t)) {
    throw new Error(`Unsafe agent type for memory path: ${JSON.stringify(agentType)}`);
  }
  return t;
}

/** Resolve the memory directory for an agentType under a given scope. */
export function agentMemoryDir(
  scope: MemoryScope,
  agentType: string,
  workspaceRoot: string,
): string {
  const safe = assertSafeAgentType(agentType);
  let root: string;
  switch (scope) {
    case "user":
      root = process.env.CCR_AGENT_MEMORY_USER_DIR || path.join(userConfigRoot(), "agent-memory");
      break;
    case "project":
      root = path.join(workspaceRoot, ".claude", "agent-memory");
      break;
    case "local":
      root = process.env[LOCAL_ENV] || path.join(workspaceRoot, ".claude", "agent-memory-local");
      break;
  }
  const dir = path.join(root, safe);
  // Defense in depth: the resolved dir must stay under root even if safe ever
  // loosens. (assertSafeAgentType already prevents traversal.)
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(dir);
  if (
    resolvedDir !== path.join(resolvedRoot, safe) &&
    !resolvedDir.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Refusing to use agent-memory path outside its root: ${resolvedDir}`);
  }
  return dir;
}

/** Absolute path to the MEMORY.md file for an agentType under a scope. */
export function agentMemoryFile(
  scope: MemoryScope,
  agentType: string,
  workspaceRoot: string,
): string {
  return path.join(agentMemoryDir(scope, agentType, workspaceRoot), "MEMORY.md");
}

const SCOPE_HINT: Record<MemoryScope, string> = {
  user: "Cross-project memory — keep lessons general and reusable.",
  project: "Project-scoped memory — tailored to THIS repository.",
  local: "Local, gitignored memory — machine-specific notes.",
};

/**
 * Load the memory prompt block for an agentType under a scope (kernel §5).
 * Ensures the directory exists. Returns null when there is no MEMORY.md yet (so
 * callers can skip injecting an empty block). Read failures degrade to null —
 * memory is best-effort and must never break an agent run.
 */
export function loadAgentMemoryPrompt(
  scope: MemoryScope,
  agentType: string,
  workspaceRoot: string,
): string | null {
  // Validate up front so a traversal attempt throws loudly (a security error,
  // not a best-effort miss). Genuine I/O problems below still degrade to null.
  assertSafeAgentType(agentType);
  let file: string;
  try {
    const dir = agentMemoryDir(scope, agentType, workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "MEMORY.md");
  } catch {
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null; // no file yet, or unreadable
  }
  if (!content) return null;
  return [`[AGENT MEMORY · ${scope}]`, SCOPE_HINT[scope], "", content].join("\n");
}

/**
 * Persist memory for an agentType under a scope. Creates the directory,
 * path-guarded. Best-effort: returns false on any write failure rather than
 * throwing into an agent run.
 */
export function saveAgentMemory(
  scope: MemoryScope,
  agentType: string,
  workspaceRoot: string,
  content: string,
): boolean {
  try {
    const dir = agentMemoryDir(scope, agentType, workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "MEMORY.md");
    withFileLock(file, () => atomicWriteFile(file, content));
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one line of memory to an agentType's MEMORY.md (F1 write path).
 * saveAgentMemory overwrites the whole file, so callers appending must merge:
 * read the current content, add the line under a "## Auto-saved" heading (or
 * the existing one), write back. Idempotent per line. Best-effort like every
 * memory write — returns false instead of throwing.
 */
export function appendAgentMemory(
  scope: MemoryScope,
  agentType: string,
  workspaceRoot: string,
  line: string,
): boolean {
  try {
    return withFileLock(agentMemoryFile(scope, agentType, workspaceRoot), () =>
      appendAgentMemoryLocked(scope, agentType, workspaceRoot, line),
    );
  } catch {
    return false;
  }
}
function appendAgentMemoryLocked(
  scope: MemoryScope,
  agentType: string,
  workspaceRoot: string,
  line: string,
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let existing = "";
  try {
    existing = fs.readFileSync(agentMemoryFile(scope, agentType, workspaceRoot), "utf-8");
  } catch {
    existing = ""; // no file yet
  }
  const bullet = `- ${trimmed.replace(/\s+/g, " ")}`;
  // Windows editors save MEMORY.md with CRLF, which defeats the line-based
  // dedupe (`bullet\n` never matches `bullet\r\n`) and re-accumulates the same
  // lesson on every save. Compare — and rebuild — against an LF-normalized
  // copy so the file converges to one newline style.
  const normalized = existing.replace(/\r\n/g, "\n");
  if (normalized.includes(`${bullet}\n`) || normalized.endsWith(bullet)) return true; // dedupe
  const HEADING = "## Auto-saved";
  let next: string;
  if (normalized.includes(HEADING)) {
    next = `${normalized.replace(/\s*$/, "\n")}${bullet}\n`;
  } else {
    const prefix = normalized.trim() ? `${normalized.replace(/\s*$/, "\n\n")}` : "";
    next = `${prefix}${HEADING}\n${bullet}\n`;
  }
  atomicWriteFile(agentMemoryFile(scope, agentType, workspaceRoot), next);
  return true;
}
