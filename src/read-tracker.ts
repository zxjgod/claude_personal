// ============================================================
// Read Tracker — enforce "read before edit"
// ============================================================
// Edits to a file are only allowed after the model has read it, and only
// if the file hasn't changed on disk since that read. This mirrors Claude
// Code's safeguard against blind edits that clobber unseen content.
//
// Keyed by sessionId + resolved path so concurrent sessions don't leak
// state into each other. The stored value is the file's mtimeMs at read
// time; an edit re-checks the current mtime and rejects on mismatch.
// ============================================================

import * as fs from "node:fs";

const readState = new Map<string, number>();

function key(sessionId: string, resolvedPath: string): string {
  const canonical = fs.existsSync(resolvedPath)
    ? fs.realpathSync.native(resolvedPath)
    : resolvedPath;
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return `${sessionId}\x00${identity}`;
}

/** Record that a file was read at the given mtime. */
export function markRead(sessionId: string, resolvedPath: string, mtimeMs: number): void {
  readState.set(key(sessionId, resolvedPath), mtimeMs);
}

export interface ReadCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a file may be edited: it must have been read this session, and its
 * on-disk mtime must match what was seen at read time. `currentMtimeMs` of
 * undefined means the file doesn't exist yet (new file) — that's allowed.
 */
export function checkReadBeforeEdit(
  sessionId: string,
  resolvedPath: string,
  currentMtimeMs: number | undefined,
): ReadCheck {
  // New file (no current mtime) — nothing to clobber, allow.
  if (currentMtimeMs === undefined) return { ok: true };

  const seen = readState.get(key(sessionId, resolvedPath));
  if (seen === undefined) {
    return {
      ok: false,
      reason:
        "File has not been read in this session. Read it first so edits are based on current content.",
    };
  }
  if (seen !== currentMtimeMs) {
    return {
      ok: false,
      reason: "File has changed on disk since it was last read. Re-read it before editing.",
    };
  }
  return { ok: true };
}

/** Update the tracked mtime after a successful write/edit (so chained edits work). */
export function refreshRead(sessionId: string, resolvedPath: string, mtimeMs: number): void {
  readState.set(key(sessionId, resolvedPath), mtimeMs);
}

/** Test/util: clear all tracked state. */
export function resetReadTracker(): void {
  readState.clear();
}
