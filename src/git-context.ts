// ============================================================
// Git Context — repo status injection (12.4)
// ============================================================
// Gathers a compact snapshot of the workspace's git state (branch, dirty
// files, recent commits) for injection into the system prompt's dynamic
// section. This gives the model the same situational awareness a developer
// has when opening a repo: what branch they're on, what's uncommitted, and
// what just changed.
//
// All commands are read-only (status/branch/log) and run with a short
// timeout. A non-git directory, missing git, or any failure yields null —
// the caller simply omits the [GIT STATUS] block.
// ============================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitContext {
  branch: string;
  /** Short `git status --porcelain` lines (capped). */
  dirtyFiles: string[];
  /** Whether more dirty files existed than the cap. */
  dirtyTruncated: boolean;
  /** Recent commit subject lines (newest first, capped). */
  recentCommits: string[];
}

interface GatherOptions {
  maxDirty?: number;
  maxCommits?: number;
  timeoutMs?: number;
}

async function git(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Gather git context for `workspaceRoot`, or null if it isn't a git repo or
 * git is unavailable. Never throws.
 */
export async function gatherGitContext(
  workspaceRoot: string,
  options: GatherOptions = {},
): Promise<GitContext | null> {
  const maxDirty = options.maxDirty ?? 20;
  const maxCommits = options.maxCommits ?? 5;
  const timeoutMs = options.timeoutMs ?? 3000;

  // Confirm this is a work tree first; bail fast otherwise.
  const inside = await git(
    ["rev-parse", "--is-inside-work-tree"],
    workspaceRoot,
    timeoutMs,
  );
  if (!inside || inside.trim() !== "true") return null;

  const branchRaw = await git(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    workspaceRoot,
    timeoutMs,
  );
  const branch = branchRaw?.trim() || "(detached)";

  const statusRaw = await git(
    ["status", "--porcelain"],
    workspaceRoot,
    timeoutMs,
  );
  const allDirty = (statusRaw ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  const dirtyFiles = allDirty.slice(0, maxDirty);
  const dirtyTruncated = allDirty.length > maxDirty;

  const logRaw = await git(
    ["log", `-${maxCommits}`, "--pretty=format:%s"],
    workspaceRoot,
    timeoutMs,
  );
  const recentCommits = (logRaw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return { branch, dirtyFiles, dirtyTruncated, recentCommits };
}

/**
 * Render a GitContext into the plain-text block used in the system prompt's
 * dynamic section. Pure and synchronous.
 */
export function formatGitContext(ctx: GitContext): string {
  const lines: string[] = [`Branch: ${ctx.branch}`];

  if (ctx.dirtyFiles.length === 0) {
    lines.push("Working tree: clean");
  } else {
    lines.push(
      `Uncommitted changes (${ctx.dirtyFiles.length}${ctx.dirtyTruncated ? "+" : ""}):`,
    );
    for (const f of ctx.dirtyFiles) lines.push(`  ${f}`);
  }

  if (ctx.recentCommits.length > 0) {
    lines.push("Recent commits:");
    for (const c of ctx.recentCommits) lines.push(`  - ${c}`);
  }

  return lines.join("\n");
}
