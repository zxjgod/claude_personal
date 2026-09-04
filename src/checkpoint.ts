// ============================================================
// Checkpoint — turn-boundary file snapshots for rewind (P0-3)
// ============================================================
// Shadows the ORIGINAL content of every file the session's Write/Edit/
// MultiEdit/Notebook tools touch, plus a boundary snapshot of the changed
// set at each user-turn start. restoreToTurn() then rewinds on-disk state
// to the moment just before a given user turn ran:
//
//   • file FIRST modified in turn T:
//       - rewinding to turn ≤ T → restore original content (delete if the
//         file did not exist before the session);
//       - rewinding to turn > T → restore the boundary snapshot taken at
//         that turn's start (the file was mid-flight by then).
//
// Turn ↔ message binding: beginUserTurn() optionally tags the user MESSAGE
// object (WeakMap) with its turn number, and turnOfMessage() reads it back.
// The rewind UIs key off the message tag directly — no ordinal arithmetic
// that synthetic agent-loop injections, /clear, auto-compaction or /resume
// could desynchronize.
//
// Sub-agents fork their tool sessionId (`<parent>-agent-<ts>`,
// tools/extended/agent.ts) to isolate read-tracking; their file writes must
// still rewind with the parent conversation, so bucket keys normalize that
// suffix away.
//
// Only tool-mediated writes are tracked. Files mutated by Bash (shell
// commands) are outside this net — same caveat as the session /diff view.
// ============================================================

import fs from "node:fs";
import { forgetChanges } from "./change-tracker.js";
import { refreshRead } from "./read-tracker.js";

interface SessionCheckpoints {
  /** 1-based index of the turn currently running (0 = none started). */
  currentTurn: number;
  /** path → content before the FIRST session write (null = file didn't exist). */
  originals: Map<string, string | null>;
  /** path → the 1-based turn in which the path was first modified. */
  firstWriteTurn: Map<string, number>;
  /** turn → { path → on-disk content at that turn's START boundary }. */
  turnSnapshots: Map<number, Map<string, string | null>>;
  /** turn → epoch ms when the boundary was taken (menu display). */
  turnTimestamps: Map<number, number>;
  /** path → {mtime, content} read cache (see snapshotAt). */
  contentCache: Map<string, { mtimeMs: number | null; content: string | null }>;
}

const sessions = new Map<string, SessionCheckpoints>();
// Message object → its 1-based checkpoint turn (see header). Weak so tagged
// messages can be GC'd with the conversation they belong to.
const turnTags = new WeakMap<object, number>();

/**
 * Normalize a bucket key: sub-agent forks (`<parent>-agent-<ts>`) share the
 * PARENT's bucket so their file writes rewind with the parent conversation.
 */
function bucketKey(sessionId: string): string {
  return sessionId.replace(/-agent-\d+$/, "");
}

function bucket(sessionId: string): SessionCheckpoints {
  const key = bucketKey(sessionId);
  let s = sessions.get(key);
  if (!s) {
    s = {
      currentTurn: 0,
      originals: new Map(),
      firstWriteTurn: new Map(),
      turnSnapshots: new Map(),
      turnTimestamps: new Map(),
      contentCache: new Map(),
    };
    sessions.set(key, s);
  }
  return s;
}

function readOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read a tracked file's current content through an mtime cache: beginUserTurn
 * runs on EVERY submit, and re-reading every tracked file each time puts fs
 * reads on the input hot path. statSync is the only syscall an untouched file
 * pays. (mtime granularity on old filesystems is ~1s; a boundary snapshot
 * could be one fast edit stale in a pathological submit-within-a-second flow
 * — acceptable for a rewind checkpoint.)
 */
function snapshotAt(s: SessionCheckpoints, filePath: string): string | null {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  const cached = s.contentCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.content;
  const content = readOrNull(filePath);
  s.contentCache.set(filePath, { mtimeMs, content });
  return content;
}

/** Upper bound on retained boundary snapshots (memory guard). Rewinds to
 *  turns older than the retained window become conversation-only. */
const MAX_TURN_SNAPSHOTS = 100;

function pruneOldestSnapshots(s: SessionCheckpoints): void {
  while (s.turnSnapshots.size > MAX_TURN_SNAPSHOTS) {
    // Turn numbers are monotonic per bucket EXCEPT across a rewind (numbers
    // are reused from the rewind point) — so "oldest" = smallest still-live
    // turn, which is exactly what a fresh loop over the keys gives.
    let oldest = Number.POSITIVE_INFINITY;
    for (const t of s.turnSnapshots.keys()) if (t < oldest) oldest = t;
    if (oldest === Number.POSITIVE_INFINITY) break;
    s.turnSnapshots.delete(oldest);
    s.turnTimestamps.delete(oldest);
  }
}

/**
 * Record a user-turn boundary, i.e. "the world as it was when this message
 * was sent" — exactly the state restoreToTurn rewinds to. When `msg` (the
 * user message about to run) is given, it is tagged with the turn number so
 * the rewind UI can map message → boundary without ordinal arithmetic.
 * Returns the 1-based turn index.
 */
export function beginUserTurn(sessionId: string, msg?: object): number {
  const s = bucket(sessionId);
  s.currentTurn += 1;
  const snapshot = new Map<string, string | null>();
  for (const path of s.originals.keys()) snapshot.set(path, snapshotAt(s, path));
  s.turnSnapshots.set(s.currentTurn, snapshot);
  s.turnTimestamps.set(s.currentTurn, Date.now());
  pruneOldestSnapshots(s);
  if (msg !== undefined) turnTags.set(msg, s.currentTurn);
  return s.currentTurn;
}

/** The checkpoint turn a user message was tagged with (null = untagged,
 *  e.g. loaded by /resume or injected without a boundary). */
export function turnOfMessage(msg: object): number | null {
  return turnTags.get(msg) ?? null;
}

/**
 * Shadow a file's original content. Tools call this immediately BEFORE their
 * fs write; only the first call per path (per session) captures, so the
 * stored value is the true pre-session content no matter how many edits
 * follow. Also records the turn of the first write (restore targeting).
 */
export function shadowBeforeWrite(sessionId: string, filePath: string): void {
  const s = bucket(sessionId);
  if (!s.originals.has(filePath)) {
    s.originals.set(filePath, snapshotAt(s, filePath));
    s.firstWriteTurn.set(filePath, Math.max(1, s.currentTurn));
  }
}

export interface RestoreResult {
  /** Files whose content was rewritten to an earlier state. */
  restored: string[];
  /** Session-created files deleted by the rewind. */
  deleted: string[];
}

/**
 * Restore on-disk state to the boundary just before `turn` (1-based) ran,
 * and drop checkpoint data for turns ≥ `turn` (they no longer happened).
 * The turn counter rolls back so the NEXT beginUserTurn reuses `turn` —
 * otherwise a post-rewind session would map fresh turns onto pruned
 * boundaries that no longer exist.
 * Never throws — a failed write is skipped (reported by absence).
 */
export function restoreToTurn(sessionId: string, turn: number): RestoreResult {
  const s = sessions.get(bucketKey(sessionId));
  if (!s) return { restored: [], deleted: [] };
  const target = Math.max(1, turn);
  const boundary = s.turnSnapshots.get(target);
  const restored: string[] = [];
  const deleted: string[] = [];

  for (const [path, original] of s.originals) {
    const firstTurn = s.firstWriteTurn.get(path) ?? target;
    let content: string | null | undefined;
    if (firstTurn >= target) {
      content = original;
    } else {
      content = boundary?.get(path);
    }
    if (content === undefined) continue; // not tracked at that boundary
    try {
      if (content === null) {
        // Original did not exist — remove the session-created file. Only
        // report a deletion when a file was actually removed.
        if (fs.existsSync(path)) {
          fs.rmSync(path);
          deleted.push(path);
        }
      } else {
        fs.mkdirSync(dirname(path), { recursive: true });
        fs.writeFileSync(path, content, "utf-8");
        restored.push(path);
        // The restored content differs on disk from what the session last
        // read/wrote — refresh the read-tracker's mtime so a follow-up Edit
        // isn't rejected as "changed on disk since it was last read".
        try {
          refreshRead(bucketKey(sessionId), path, fs.statSync(path).mtimeMs);
        } catch {
          /* stat failure right after write — skip tracker refresh */
        }
      }
    } catch {
      // Best-effort restore: a locked/readonly file is reported by absence.
    }
  }

  // /diff hygiene: paths FULLY undone by this rewind (first write ≥ target,
  // so they are back to pristine) no longer count as session changes.
  // Mid-flight files (edited in an earlier turn) keep their change entry —
  // those edits genuinely still stand.
  const undone: string[] = [];
  for (const [path, firstTurn] of s.firstWriteTurn) {
    if (firstTurn >= target) undone.push(path);
  }
  if (undone.length > 0) forgetChanges(bucketKey(sessionId), undone);

  // Prune future state: turns ≥ target never happened, and files whose first
  // write was ≥ target are back to pristine (drop their shadow so a later
  // edit re-shadows the restored content as the new "original"; deeper
  // rewinds can still reach the pre-session original for files whose first
  // write came BEFORE target — those shadows intentionally survive).
  for (const t of [...s.turnSnapshots.keys()]) {
    if (t >= target) {
      s.turnSnapshots.delete(t);
      s.turnTimestamps.delete(t);
    }
  }
  for (const [path, firstTurn] of [...s.firstWriteTurn.entries()]) {
    if (firstTurn >= target) {
      s.firstWriteTurn.delete(path);
      s.originals.delete(path);
    }
  }
  // Roll the counter back so the next boundary reuses `target`.
  s.currentTurn = Math.min(s.currentTurn, target - 1);
  return { restored, deleted };
}

/** Files modified so far this session (path → first-write turn). */
export function changedFiles(sessionId: string): Map<string, number> {
  const s = sessions.get(bucketKey(sessionId));
  return s ? new Map(s.firstWriteTurn) : new Map();
}

/** Turn boundaries recorded so far: [{turn, timestamp, filesChanged}]. */
export function listTurns(sessionId: string): Array<{
  turn: number;
  timestamp: number;
  filesChanged: number;
}> {
  const s = sessions.get(bucketKey(sessionId));
  if (!s) return [];
  const out: Array<{ turn: number; timestamp: number; filesChanged: number }> = [];
  for (const [turn, timestamp] of s.turnTimestamps) {
    // The turn's own edits are the ones whose first write is exactly `turn`.
    let filesChanged = 0;
    for (const ft of s.firstWriteTurn.values()) if (ft === turn) filesChanged++;
    out.push({ turn, timestamp, filesChanged });
  }
  return out.sort((a, b) => a.turn - b.turn);
}

/** Clear checkpoints for a session (e.g. on /clear). */
export function resetCheckpoints(sessionId: string): void {
  sessions.delete(bucketKey(sessionId));
}

/** Test/util: clear everything. */
export function resetAllCheckpoints(): void {
  sessions.clear();
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : ".";
}
