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
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedGitExe: string | undefined;

/**
 * Resolve git to an ABSOLUTE path on Windows (review fix: "git execFile CWD
 * 劫持"). CreateProcess' search order includes the CURRENT directory, so a
 * bare "git" in a workspace containing a planted git.exe/git.cmd executes the
 * planted binary — and gatherGitContext runs automatically at CLI startup.
 * An absolute path skips the search entirely. PATH entries are user-machine
 * config (not project-controlled), so the first hit is trusted. Non-Windows
 * keeps the bare name (POSIX execvp does not search CWD unless PATH says so).
 */
export function resolveGitExecutable(): string {
  if (process.platform !== "win32") return "git";
  if (cachedGitExe !== undefined) return cachedGitExe;
  let pathEnv: string | undefined;
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() === "path") pathEnv = v;
  }
  for (const dir of (pathEnv ?? "").split(";")) {
    if (!dir) continue;
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const candidate = path.join(dir, `git${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        cachedGitExe = candidate;
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  // Not found on PATH — fall back to the bare name (fails as before).
  cachedGitExe = "git";
  return cachedGitExe;
}

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

async function git(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveGitExecutable(), args, {
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
  const inside = await git(["rev-parse", "--is-inside-work-tree"], workspaceRoot, timeoutMs);
  if (inside?.trim() !== "true") return null;

  const branchRaw = await git(["rev-parse", "--abbrev-ref", "HEAD"], workspaceRoot, timeoutMs);
  const branch = branchRaw?.trim() || "(detached)";

  const statusRaw = await git(["status", "--porcelain"], workspaceRoot, timeoutMs);
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
    lines.push(`Uncommitted changes (${ctx.dirtyFiles.length}${ctx.dirtyTruncated ? "+" : ""}):`);
    for (const f of ctx.dirtyFiles) lines.push(`  ${f}`);
  }

  if (ctx.recentCommits.length > 0) {
    lines.push("Recent commits:");
    for (const c of ctx.recentCommits) lines.push(`  - ${c}`);
  }

  return lines.join("\n");
}

// --- /commit & /pr helpers (M13.1) ---

/** A single changed file with its git status code and one-line diffstat. */
export interface GitChangedFile {
  /** Raw porcelain status, e.g. "M", "A", "D", "??", " M". */
  status: string;
  /** Path as git reports it (may include rename "a -> b"). */
  path: string;
  /** Insertions/deletions from `git diff --numstat`, if available. */
  insertions?: number;
  deletions?: number;
}

export interface GitDiffSummary {
  branch: string;
  /** Files changed relative to HEAD (staged + unstaged, porcelain). */
  files: GitChangedFile[];
  /** Files changed relative to the upstream tracking branch (for /pr). */
  upstreamFiles: GitChangedFile[];
  /** Commits on this branch not on the upstream (for /pr). */
  branchCommits: string[];
  /** Whether any of the lists was truncated. */
  truncated: boolean;
}

interface DiffOptions {
  maxFiles?: number;
  maxCommits?: number;
  timeoutMs?: number;
}

/**
 * Collect the change set used by /commit (vs HEAD) and /pr (vs upstream).
 * Best-effort: a non-git dir or missing upstream yields empty upstream lists.
 * Never throws.
 */
export async function gatherDiffSummary(
  workspaceRoot: string,
  options: DiffOptions = {},
): Promise<GitDiffSummary | null> {
  const maxFiles = options.maxFiles ?? 60;
  const maxCommits = options.maxCommits ?? 30;
  const timeoutMs = options.timeoutMs ?? 5000;

  const inside = await git(["rev-parse", "--is-inside-work-tree"], workspaceRoot, timeoutMs);
  if (inside?.trim() !== "true") return null;

  const branchRaw = await git(["rev-parse", "--abbrev-ref", "HEAD"], workspaceRoot, timeoutMs);
  const branch = branchRaw?.trim() || "(detached)";

  const parsePorcelain = (raw: string | null): GitChangedFile[] =>
    (raw ?? "")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .slice(0, maxFiles)
      .map((line) => {
        // Porcelain v1: "XY path" (XY is 2 chars). Strip the status, keep path.
        const status = line.slice(0, 2).trim() || "?";
        const rest = line.slice(3).trim();
        return { status, path: rest };
      });

  // Files changed vs HEAD (staged + unstaged combined).
  const headStatus = await git(["status", "--porcelain"], workspaceRoot, timeoutMs);
  const headTruncated = (headStatus ?? "").split("\n").filter(Boolean).length > maxFiles;
  const files = parsePorcelain(headStatus);

  // numstat for insertions/deletions (only works for tracked, non-binary).
  const numstatRaw = await git(["diff", "--numstat", "HEAD"], workspaceRoot, timeoutMs);
  const numstat = new Map<string, { ins: number | undefined; del: number | undefined }>();
  for (const line of (numstatRaw ?? "").split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const ins = parts[0] === "-" ? undefined : Number(parts[0]);
      const del = parts[1] === "-" ? undefined : Number(parts[1]);
      numstat.set(parts.slice(2).join("\t"), { ins, del });
    }
  }
  for (const f of files) {
    const ns = numstat.get(f.path);
    if (ns) {
      f.insertions = ns.ins;
      f.deletions = ns.del;
    }
  }

  // Upstream tracking branch for /pr.
  const upstreamRaw = await git(
    ["rev-parse", "--abbrev-ref", "@{upstream}"],
    workspaceRoot,
    timeoutMs,
  );
  let upstreamFiles: GitChangedFile[] = [];
  let branchCommits: string[] = [];
  if (upstreamRaw) {
    const upstream = upstreamRaw.trim();
    const prStatus = await git(
      ["diff", "--name-status", upstream + "...HEAD"],
      workspaceRoot,
      timeoutMs,
    );
    upstreamFiles = (prStatus ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, maxFiles)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: status ?? "M", path: rest.join(" -> ") };
      });
    const commitsRaw = await git(
      ["log", upstream + "..HEAD", "--pretty=format:%s"],
      workspaceRoot,
      timeoutMs,
    );
    branchCommits = (commitsRaw ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, maxCommits);
  }

  return {
    branch,
    files,
    upstreamFiles,
    branchCommits,
    truncated: headTruncated,
  };
}

/**
 * Suggest a conventional-commit subject from a diff summary. Pure, no git.
 * Heuristic: group by the dominant change type, derive a scope from the most
 * touched top-level dir, and pick a verb from the status mix. This is a draft
 * for the user to edit — not a final message.
 */
export function suggestCommitSubject(summary: GitDiffSummary): string {
  if (summary.files.length === 0) return "chore: no changes to commit";

  // Type from the status mix.
  const hasAdd = summary.files.some((f) => f.status.includes("A") || f.status === "??");
  const hasDel = summary.files.some((f) => f.status.includes("D"));
  const hasMod = summary.files.some((f) => f.status.includes("M"));
  const type = hasAdd && !hasMod && !hasDel ? "feat" : hasDel && !hasAdd ? "chore" : "refactor";

  // Scope from the most common top-level directory of touched paths.
  const dirs = summary.files.map((f) => f.path.split("/")[0] || "").filter(Boolean);
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
  let scope = "";
  if (counts.size > 0) {
    scope = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }

  // Subject: count + the first changed path as a hint.
  const first = summary.files[0]!.path.replace(/^.*\//, "");
  const n = summary.files.length;
  const scopePart = scope ? "(" + scope + ")" : "";
  const plural = n > 1 ? "s" : "";
  const hint = n > 1 ? ", …" : "";
  const subject = type + scopePart + ": update " + n + " file" + plural + " (" + first + hint + ")";
  return subject;
}
