// ============================================================
// Change Tracker — record file mutations made during a session
// ============================================================
// Write/Edit/MultiEdit report each successful mutation here so /diff can
// summarize what changed this session. Keyed by sessionId so concurrent
// sessions stay isolated (same pattern as read-tracker.ts).
//
// We store a compact record per file: the kind of change, how many times it
// was touched, and the latest human-readable detail (size for writes, a
// unified-ish diff snippet for edits). This is for the user's situational
// awareness, not a git replacement.
// ============================================================

export type ChangeKind = "created" | "modified";

export interface FileChange {
  /** Workspace-relative (or absolute fallback) path. */
  path: string;
  kind: ChangeKind;
  /** How many edit/write operations touched this file this session. */
  edits: number;
  /** Latest short detail line (e.g. size, or a diff snippet). */
  detail?: string;
  /** Timestamp of the most recent change. */
  updatedAt: number;
}

// sessionId -> (path -> change)
const changes = new Map<string, Map<string, FileChange>>();

function bucket(sessionId: string): Map<string, FileChange> {
  let m = changes.get(sessionId);
  if (!m) {
    m = new Map();
    changes.set(sessionId, m);
  }
  return m;
}

/**
 * Record a file mutation. The first time a path is seen, `kind` is honored
 * (created vs modified); subsequent records keep the original kind — a file
 * created then edited this session stays "created" — and bump the edit count.
 */
export function recordChange(
  sessionId: string,
  path: string,
  kind: ChangeKind,
  detail?: string,
): void {
  const m = bucket(sessionId);
  const existing = m.get(path);
  if (existing) {
    existing.edits += 1;
    existing.detail = detail ?? existing.detail;
    existing.updatedAt = Date.now();
    return;
  }
  m.set(path, { path, kind, edits: 1, detail, updatedAt: Date.now() });
}

/** All changes for a session, most-recently-updated first. */
export function listChanges(sessionId: string): FileChange[] {
  const m = changes.get(sessionId);
  if (!m) return [];
  return Array.from(m.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Clear tracked changes for a session (e.g. on /clear). */
export function clearChanges(sessionId: string): void {
  changes.delete(sessionId);
}

/**
 * Drop specific paths from a session's change set — used by checkpoint
 * restore: a file rewound to its pre-session state is no longer "changed
 * this session", so /diff must stop listing it.
 */
export function forgetChanges(sessionId: string, paths: string[]): void {
  const m = changes.get(sessionId);
  if (!m) return;
  for (const p of paths) m.delete(p);
}

/** Test/util: clear everything. */
export function resetChangeTracker(): void {
  changes.clear();
}
