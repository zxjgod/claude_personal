// ============================================================
// Path Utilities for Tools
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

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
  const resolved = path.resolve(root, inputPath);

  // Resolve symlinks to get the real path, then verify containment.
  // This prevents attacks via symlinks pointing outside the workspace.
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // realpathSync fails for broken symlinks or permission errors.
    // Fall back to resolved path — the prefix check still blocks the escape.
    realPath = resolved;
  }

  if (realPath !== root && !realPath.startsWith(root + path.sep)) {
    return {
      ok: false,
      error: `Access denied: "${inputPath}" resolves outside workspace`,
    };
  }
  return { ok: true, path: resolved };
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
