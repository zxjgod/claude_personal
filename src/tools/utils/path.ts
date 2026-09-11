// ============================================================
// Path Utilities for Tools
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { isBlockedPath } from "../../permissions.js";

/** Apply the sensitive-file policy to both the supplied and canonical path. */
export function resolveAllowedWorkspaceFile(inputPath: string, workspaceRoot: string) {
  const resolution = resolveInWorkspace(inputPath, workspaceRoot);
  if (!resolution.ok) return resolution;
  if (isBlockedPath(inputPath) || isBlockedPath(resolution.path)) {
    return { ok: false as const, error: "Access denied: path is blocked for security reasons." };
  }
  return resolution;
}

/**
 * Resolve a user-supplied path against the workspace root and confirm it
 * stays inside the workspace. Returns the absolute path on success, or an
 * error string on rejection.
 *
 * Guards three escape vectors:
 *  1. Prefix aliasing — "/proj" must not match a sibling "/proj-evil".
 *     We compare against `workspaceRoot + path.sep` (and allow the root
 *     itself).
 *  2. Absolute-path override — `path.resolve(root, "/etc/passwd")` discards
 *     the root and returns "/etc/passwd". We resolve, then re-verify
 *     containment, so an absolute input outside the workspace is rejected.
 *  3. Symlink escape — a symlink inside the workspace pointing outside.
 *     We call realpathSync to resolve symlinks, then verify the real path
 *     is still contained.
 */
export function resolveInWorkspace(
  inputPath: string,
  workspaceRoot: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const root = path.resolve(workspaceRoot);
  const rootReal = (() => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  })();
  const resolved = path.resolve(rootReal, inputPath);

  // Resolve symlinks to get the real path, then verify containment. A
  // not-yet-existing tail (a write creating a new file) is tolerated; a symlink
  // that points outside the workspace is rejected by the containment check below
  // (never by blind fallback, which used to let writeFileSync follow the link).
  const real = resolveRealPathOrError(inputPath, resolved);
  if (!real.ok) {
    return real;
  }

  const normalizeForContainment = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedRoot = normalizeForContainment(rootReal);
  const normalizedReal = normalizeForContainment(real.path);
  if (normalizedReal !== normalizedRoot && !normalizedReal.startsWith(normalizedRoot + path.sep)) {
    return {
      ok: false,
      error: `Access denied: "${inputPath}" resolves outside workspace`,
    };
  }
  // Return the symlink-resolved path so the caller operates on the REAL target,
  // not a symlink that could be swapped after this check (TOCTOU). For
  // not-yet-existing files `real.path` is the real ancestor + literal suffix —
  // the best containment verdict available before the file exists.
  return { ok: true, path: real.path };
}

/**
 * Resolve `resolved` to its real path, following symlinks, while tolerating a
 * not-yet-existing tail (writes that create new files). Walks up to the deepest
 * EXISTING ancestor and re-appends the missing suffix. Any symlink component is
 * followed (relative to its own directory) so the caller's containment check
 * can reject a link that escapes the workspace — a dangling link whose target
 * does not exist yet simply becomes a not-yet-created tail and is then judged
 * by containment too.
 */
function resolveRealPathOrError(
  inputPath: string,
  resolved: string,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: fs.realpathSync(resolved) };
  } catch {
    // Path does not fully exist — fall through to the ancestor walk below.
  }
  let cur = resolved;
  const suffix: string[] = [];
  const seenLinks = new Set<string>();
  for (;;) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(cur);
    } catch {
      st = undefined;
    }
    if (st === undefined) {
      // `cur` does not exist — its basename is a not-yet-created tail component.
      const parent = path.dirname(cur);
      if (parent === cur) {
        return {
          ok: false,
          error: `Access denied: "${inputPath}" cannot be resolved inside the workspace`,
        };
      }
      suffix.unshift(path.basename(cur));
      cur = parent;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (seenLinks.has(cur)) {
        return {
          ok: false,
          error: `Access denied: "${inputPath}" traverses a symbolic-link cycle`,
        };
      }
      seenLinks.add(cur);
      cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
      continue;
    }
    // Deepest existing non-symlink ancestor: resolve and re-append the tail.
    return { ok: true, path: path.join(fs.realpathSync(cur), ...suffix) };
  }
}

/** Workspace-relative path for display; falls back to absolute if outside. */
export function relForDisplay(absPath: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, absPath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return absPath;
}

/** Current mtimeMs of a file, or undefined if it doesn't exist. */
export function statMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}
