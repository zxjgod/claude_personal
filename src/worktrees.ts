import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export interface WorktreeInfo {
  path: string;
  branch: string;
  repository: string;
  baseCommit: string;
}
const active = new Map<string, WorktreeInfo[]>();
const registeredRoots = new Set<string>();
const rootKey = (root: string): string =>
  process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
export function isRegisteredWorktree(root: string): boolean {
  return registeredRoots.has(rootKey(root));
}

export async function worktreeGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15000, windowsHide: true });
  return stdout.trim();
}

export function activeWorkspace(sessionId: string, fallback: string): string {
  const entry = active.get(sessionId)?.at(-1);
  return entry && fs.existsSync(entry.path) ? entry.path : fallback;
}

export function pushWorktree(sessionId: string, entry: WorktreeInfo): void {
  const stack = active.get(sessionId) ?? [];
  stack.push(entry);
  active.set(sessionId, stack);
}
export function currentWorktree(sessionId: string): WorktreeInfo | undefined {
  return active.get(sessionId)?.at(-1);
}
export function popWorktree(sessionId: string): void {
  const stack = active.get(sessionId);
  stack?.pop();
  if (!stack?.length) active.delete(sessionId);
}
export function resetWorktrees(sessionId: string): void {
  active.delete(sessionId);
}

export async function createIsolatedWorktree(
  repository: string,
  name: string,
  baseRef = "HEAD",
): Promise<WorktreeInfo> {
  if (
    (await worktreeGit(["rev-parse", "--is-inside-work-tree"], repository).catch(() => "")) !==
    "true"
  )
    throw new Error("Not a git repository");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || name.includes(".."))
    throw new Error("Invalid worktree name");
  const branch = `codex/${name}`;
  const wtPath = path.resolve(repository, ".claude", "worktrees", name);
  const baseCommit = await worktreeGit(
    ["rev-parse", "--verify", `${baseRef}^{commit}`],
    repository,
  );
  await worktreeGit(["worktree", "add", "-b", branch, wtPath, baseCommit], repository);
  registeredRoots.add(rootKey(wtPath));
  return { path: wtPath, branch, repository: path.resolve(repository), baseCommit };
}

export async function openExistingWorktree(
  repository: string,
  target: string,
): Promise<WorktreeInfo> {
  const resolved = fs.realpathSync(path.resolve(repository, target));
  const entries = (
    await worktreeGit(
      ["-c", "core.quotePath=false", "worktree", "list", "--porcelain", "-z"],
      repository,
    )
  ).split("\0\0");
  const entry = entries.find((item) =>
    item
      .split("\0")
      .some(
        (line) =>
          line.startsWith("worktree ") &&
          rootKey(fs.realpathSync(line.slice(9))) === rootKey(resolved),
      ),
  );
  if (!entry) throw new Error("Path is not a registered worktree of this repository");
  if (resolved === fs.realpathSync(repository))
    throw new Error("The primary checkout is already the workspace");
  const branch =
    entry
      .split("\0")
      .find((line) => line.startsWith("branch "))
      ?.slice(7)
      .replace(/^refs\/heads\//, "") ?? "";
  const baseCommit = await worktreeGit(["rev-parse", "HEAD"], repository);
  registeredRoots.add(rootKey(resolved));
  return { path: resolved, branch, repository: path.resolve(repository), baseCommit };
}

export async function inspectWorktree(
  entry: WorktreeInfo,
): Promise<{ dirty: boolean; uniqueCommits: boolean }> {
  const dirty = !!(await worktreeGit(
    ["status", "--porcelain", "--untracked-files=all"],
    entry.path,
  ));
  const unique = await worktreeGit(
    ["rev-list", "--count", `HEAD`, `^${entry.baseCommit}`],
    entry.path,
  );
  return { dirty, uniqueCommits: Number(unique) > 0 };
}

/** Never remove data when status cannot be determined. Branch deletion follows successful removal. */
export async function removeIsolatedWorktree(
  entry: WorktreeInfo,
  discard = false,
): Promise<string | undefined> {
  const registered = await openExistingWorktree(entry.repository, entry.path);
  const state = await inspectWorktree(entry);
  if (!discard && (state.dirty || state.uniqueCommits))
    throw new Error(
      "Worktree has uncommitted changes or unmerged commits; keep it or explicitly discard changes",
    );
  await worktreeGit(
    ["worktree", "remove", ...(discard ? ["--force"] : []), registered.path],
    entry.repository,
  );
  registeredRoots.delete(rootKey(registered.path));
  if (registered.branch) {
    try {
      await worktreeGit(["branch", discard ? "-D" : "-d", registered.branch], entry.repository);
    } catch (error) {
      return `Worktree removed, but branch ${registered.branch} was retained: ${String(error)}`;
    }
  }
  return undefined;
}

export async function finishIsolatedWorktree(entry: WorktreeInfo): Promise<boolean> {
  try {
    const state = await inspectWorktree(entry);
    if (state.dirty || state.uniqueCommits) return false;
    const warning = await removeIsolatedWorktree(entry);
    if (warning) console.warn(warning);
    return true;
  } catch {
    return false;
  }
}
