// ============================================================
// Session CWD — persist Bash's working directory across calls (M39)
// ============================================================
// Claude Code's Bash tool remembers the working directory within a session;
// a fresh-shell-per-call design (this project's) does not. We keep a single
// session-keyed cwd so a successful `cd <dir>` sticks for the NEXT bash call.
// Lightweight on purpose — a session-level variable, not a PTY: each command
// still runs in its own fresh shell, we just seed the spawn cwd from the
// last remembered directory.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

const cwds = new Map<string, string>();

/**
 * The remembered cwd for a session, or undefined (callers fall back to workspace
 * root). Returns undefined — and clears the stale entry — when the remembered
 * directory no longer exists, so a cwd deleted after the last `cd` cannot make
 * every subsequent spawn fail with ENOENT (M39 follow-up).
 */
export function getCwd(sessionId: string): string | undefined {
  const cwd = cwds.get(sessionId);
  if (cwd === undefined) return undefined;
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {
    // Directory vanished — fall through and clear the stale entry.
  }
  cwds.delete(sessionId);
  return undefined;
}

export function setCwd(sessionId: string, cwd: string): void {
  cwds.set(sessionId, cwd);
}

/** Forget the remembered cwd (called on /clear — a fresh conversation starts fresh). */
export function clearCwd(sessionId: string): void {
  cwds.delete(sessionId);
}

/**
 * Extract the target directory from a BARE `cd <dir>` command. Returns
 * undefined for everything else — `cd` alone, compound commands (`cd x && …`,
 * `cd x; …`, pipes, redirections) — so we never mistake a sub-step of a larger
 * command for a directory change. The argument may be quoted.
 */
export function parseCdTarget(command: string): string | undefined {
  const trimmed = command.trim();
  // A bare `cd <dir>` only. Reject shell metacharacters that would make the
  // parse ambiguous (compound/conditional/piped/redirected commands).
  if (/[;&|<>]/.test(trimmed)) return undefined;
  const match = /^cd\s+(.+)$/i.exec(trimmed);
  if (!match) return undefined;
  let target = match[1]!.trim();
  if (
    target.length >= 2 &&
    ((target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'")))
  ) {
    target = target.slice(1, -1);
  }
  if (target.length === 0) return undefined;
  return target;
}

/**
 * Resolve a cd target against the current cwd and, when it names an existing
 * directory, remember it. Returns the new cwd on success, undefined otherwise.
 *
 * Deliberately does NOT enforce workspace containment: Bash is already an
 * unrestricted shell — a single command can `cd` anywhere, so remembering the
 * cwd after a successful `cd` adds no new escape surface. It only makes the
 * NEXT call's spawn cwd match what the user just asked for.
 *
 * Called only from the foreground Bash path (bash.ts) on a successful exit.
 * A background job's `cd` is intentionally NOT remembered: a detached job has
 * no "next command" in the session, so persisting its cwd would be both
 * meaningless and racy (the job may outlive the turn that spawned it).
 */
export function rememberCd(
  sessionId: string,
  baseCwd: string,
  command: string,
): string | undefined {
  const target = parseCdTarget(command);
  if (target === undefined) return undefined;
  const resolved = path.resolve(baseCwd, target);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      setCwd(sessionId, resolved);
      return resolved;
    }
  } catch {
    // Target doesn't exist / isn't a directory — leave the remembered cwd alone.
  }
  return undefined;
}
