// ============================================================
// Read Tracker — enforce "read before edit"
// ============================================================
// Edits to a file are only allowed after the model has read it, and only
// if the file hasn't changed on disk since that read. This mirrors Claude
// Code's safeguard against blind edits that clobber unseen content.
//
// Keyed by sessionId + resolved path so concurrent sessions don't leak
// state into each other.
//
// Version check (review fix "同 mtime 外部修改不会被发现"): mtime alone
// misses an external rewrite that preserves/restores mtime or lands inside
// the filesystem's timestamp granularity. The tracked state therefore also
// carries the file SIZE and, when cheaply available, a digest of the first
// DIGEST_CAP bytes; the edit gate recomputes both and rejects on any
// mismatch. Residual risk (same mtime+size+identical head, different tail)
// is accepted and noted.
// ============================================================

import { createHash } from "node:crypto";
import * as fs from "node:fs";

/** Digest at most this many leading bytes — full-file hashing on every edit
 *  gate would put large-file reads on the tool hot path for marginal gain. */
const DIGEST_CAP = 1024 * 1024;

interface ReadState {
  mtimeMs: number;
  size?: number;
  digest?: string;
}

const readState = new Map<string, ReadState>();

function key(sessionId: string, resolvedPath: string): string {
  const canonical = fs.existsSync(resolvedPath)
    ? fs.realpathSync.native(resolvedPath)
    : resolvedPath;
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return `${sessionId}\x00${identity}`;
}

/** Cheap identity of a file on disk right now; undefined parts stay unknown. */
function currentIdentity(resolvedPath: string): { size?: number; digest?: string } {
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) return {};
    const handle = fs.openSync(resolvedPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(DIGEST_CAP, stat.size));
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      return {
        size: stat.size,
        digest: createHash("sha256").update(buffer.subarray(0, bytes)).digest("hex"),
      };
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return {};
  }
}

/** Record that a file was read at the given mtime (optionally with size/digest
 *  the caller already has — read.ts passes the content it just read). */
export function markRead(
  sessionId: string,
  resolvedPath: string,
  mtimeMs: number,
  extra?: { size?: number; digest?: string },
): void {
  readState.set(key(sessionId, resolvedPath), { mtimeMs, ...extra });
}

export interface ReadCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a file may be edited: it must have been read this session, its
 * on-disk mtime must match what was seen at read time, and — when known —
 * size and content digest must match too. `currentMtimeMs` of undefined means
 * the file doesn't exist yet (new file) — that's allowed.
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
  if (seen.mtimeMs !== currentMtimeMs) {
    return {
      ok: false,
      reason: "File has changed on disk since it was last read. Re-read it before editing.",
    };
  }
  // Same mtime: confirm the CONTENT identity too (external same-mtime writes).
  if (seen.size !== undefined || seen.digest !== undefined) {
    const current = currentIdentity(resolvedPath);
    if (seen.size !== undefined && current.size !== undefined && seen.size !== current.size) {
      return {
        ok: false,
        reason: "File has changed on disk since it was last read. Re-read it before editing.",
      };
    }
    if (
      seen.digest !== undefined &&
      current.digest !== undefined &&
      seen.digest !== current.digest
    ) {
      return {
        ok: false,
        reason: "File has changed on disk since it was last read. Re-read it before editing.",
      };
    }
  }
  return { ok: true };
}

/** Update the tracked state after a successful write/edit (so chained edits work). */
export function refreshRead(
  sessionId: string,
  resolvedPath: string,
  mtimeMs: number,
  extra?: { size?: number; digest?: string },
): void {
  // Deliberately NOT inheriting the previous size/digest: the file content
  // just changed under our own write, and the old identity would fail the
  // next gate comparison (chained-edit regression). Callers that know the
  // new content pass it in; otherwise tracking degrades to mtime-only,
  // which is exactly what the pre-digest behavior guaranteed.
  readState.set(key(sessionId, resolvedPath), { mtimeMs, ...extra });
}

/** Drop every tracked read for one session — /clear must not carry the old
 *  conversation's read grants into the new one (review fix). */
export function clearSessionReads(sessionId: string): void {
  const prefix = `${sessionId}\x00`;
  for (const k of [...readState.keys()]) if (k.startsWith(prefix)) readState.delete(k);
}

/** Test/util: clear all tracked state. */
export function resetReadTracker(): void {
  readState.clear();
}
