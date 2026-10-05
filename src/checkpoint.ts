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
// object with its turn number and session id; user messages persist this
// association so turnOfMessage() can read it after a restart.
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
//
// Persistence (Top10 follow-up C8): shadows and turn boundaries are mirrored
// to `.claude/checkpoints/<bucket>/` — content-addressed blobs plus a
// state.json index — so /rewind survives a process restart or /resume (it
// used to be pure memory: kill the CLI and every checkpoint was gone). The
// mirror is best-effort: any I/O failure degrades to the old memory-only
// behavior, never breaking a tool write. In-memory retention is bounded
// (MAX_CHECKPOINT_MEMORY_BYTES): older turn snapshots live on disk only and
// are re-read lazily by restoreToTurn.
// ============================================================

import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { forgetChanges } from "./change-tracker.js";
import { refreshRead } from "./read-tracker.js";
import { renameSyncWithRetry } from "./utils/atomic-rename.js";

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
const storageRoots = new Map<string, string>();

let workspaceRootResolver: (() => string) | undefined;

/** Default storage resolver for newly encountered sessions; existing buckets stay pinned. */
export function setCheckpointWorkspaceRootResolver(resolver: (() => string) | undefined): void {
  workspaceRootResolver = resolver;
}

// ============================================================
// Disk persistence (Top10 follow-up C8)
// ============================================================

/** On-disk shape of one bucket's index. Blob ids are sha256 hex; `null`
 *  content ("file did not exist") needs no blob. */
interface PersistedBucket {
  version: 1;
  currentTurn: number;
  originals: Record<string, { blob: string | null; firstWriteTurn: number }>;
  turns: Record<string, { ts: number; files: Record<string, string | null> }>;
}

/** Soft cap on checkpoint CONTENT bytes held in memory per process. Beyond
 *  it, older turn snapshots are dropped from memory (disk copy remains and
 *  restoreToTurn re-reads them lazily). */
const MAX_CHECKPOINT_MEMORY_BYTES = 64 * 1024 * 1024;

/** Fallback root for unbound sessions. The CLI binds each session explicitly. */
function checkpointRoot(): string {
  const ws = workspaceRootResolver?.() || process.env.WORKSPACE_ROOT || process.cwd();
  return nodePath.join(ws, ".claude", "checkpoints");
}

function bucketDir(key: string): string {
  let root = storageRoots.get(key);
  if (!root) {
    root = nodePath.dirname(checkpointRoot());
    storageRoots.set(key, root);
  }
  return nodePath.join(root, "checkpoints", key.replace(/[^a-zA-Z0-9_.-]/g, "_"));
}

/** Session storage follows the session file, independently of /cd and worktrees. */
export function bindCheckpointSession(sessionId: string, workspaceRoot: string): void {
  const key = bucketKey(sessionId);
  const root = nodePath.join(nodePath.resolve(workspaceRoot), ".claude");
  const previous = storageRoots.get(key);
  if (previous && previous !== root) {
    sessions.delete(key);
    diskMirrors.delete(key);
  }
  storageRoots.set(key, root);
}

function writeBlob(key: string, content: string | null): string | null {
  if (content === null) return null;
  try {
    const hash = createHash("sha256").update(content).digest("hex");
    const dir = nodePath.join(bucketDir(key), "blobs");
    const file = nodePath.join(dir, hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, "utf-8");
      renameSyncWithRetry(tmp, file);
    }
    return hash;
  } catch {
    return null; // best-effort: memory copy still works
  }
}

/**
 * Read a content blob. THREE states (review follow-up #7③):
 *  - `string` — the blob's content;
 *  - `null` — the shadow legitimately recorded "file did not exist" (hash is
 *    null); a restore DELETES the file for this;
 *  - `undefined` — the blob is missing/unreadable on disk. Must NEVER be
 *    conflated with null: a lost blob would otherwise tell restoreToTurn the
 *    file never existed and get it DELETED. Callers skip undefined paths.
 */
function readBlob(key: string, hash: string | null): string | null | undefined {
  if (hash === null) return null;
  try {
    return fs.readFileSync(nodePath.join(bucketDir(key), "blobs", hash), "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Blob GC (review follow-up #7①): content-addressed blobs are shared, and
 * rewinds/prunes only drop their state.json references — the files themselves
 * used to leak forever. Delete every blob the FRESH on-disk index no longer
 * references. Best-effort; runs after a rewind (the only pruning event).
 */
function gcBlobs(key: string): void {
  try {
    const mirror = loadPersisted(key); // fresh from disk, not the in-memory copy
    // Fourth-round review: an unreadable/missing/corrupt index must ABORT
    // the GC — treating it as an empty reachable set deleted EVERY blob on
    // disk, so a single failed state.json write (AV/backup placeholder
    // blocking the rewrite of the same filename) later escalated into
    // destroying all remaining rewind depth the in-memory mirror still
    // references. Conservative rule: no readable index → no GC. (Known
    // limitation, accepted: no cross-process lock — a same-session second
    // terminal that wrote a blob between our index read and the unlinks can
    // lose that one blob to GC; the reader treats it as missing and skips,
    // degrading rewind depth without deleting live files.)
    if (!mirror) return;
    const dir = nodePath.join(bucketDir(key), "blobs");
    const reachable = new Set<string>();
    for (const o of Object.values(mirror.originals)) {
      if (o.blob) reachable.add(o.blob);
    }
    for (const t of Object.values(mirror.turns)) {
      for (const b of Object.values(t.files)) if (b) reachable.add(b);
    }
    for (const name of fs.readdirSync(dir)) {
      if (!reachable.has(name)) {
        try {
          fs.unlinkSync(nodePath.join(dir, name));
        } catch {
          /* another process may hold it — skip */
        }
      }
    }
  } catch {
    /* no blobs dir — nothing to GC */
  }
}

/** Full index (mirror of memory + any turns evicted from memory). Kept per
 *  bucket so persistState never needs the evicted contents in RAM. */
const diskMirrors = new Map<string, PersistedBucket>();

function persistState(key: string, s: SessionCheckpoints): void {
  try {
    let mirror = diskMirrors.get(key);
    if (!mirror) {
      mirror = { version: 1, currentTurn: 0, originals: {}, turns: {} };
      diskMirrors.set(key, mirror);
    }
    mirror.currentTurn = s.currentTurn;
    for (const [path, firstTurn] of s.firstWriteTurn) {
      if (!mirror.originals[path]) {
        const content = s.originals.get(path);
        // Tracked in firstWriteTurn but content UNKNOWN (e.g. hydrated after
        // its blob was lost — hydration deliberately keeps the bookkeeping
        // without the originals entry). Writing blob:null here would tell a
        // later rewind "file did not exist pre-session" and get it DELETED
        // (#7③). Skip; a re-capture or the next persistState can retry.
        if (content === undefined) continue;
        const blob = writeBlob(key, content);
        // A FAILED blob write (non-null content, null hash) must not persist
        // as blob:null — hydration would read that as "file did not exist
        // pre-session" and a rewind would DELETE the file (#7③). Skip the
        // entry; the next persistState retries.
        if (content !== null && blob === null) continue;
        mirror.originals[path] = { blob, firstWriteTurn: firstTurn };
      }
    }
    // Drop pruned entries from the mirror (rewind/reset hygiene).
    for (const path of Object.keys(mirror.originals)) {
      if (!s.firstWriteTurn.has(path)) delete mirror.originals[path];
    }
    for (const t of Object.keys(mirror.turns)) {
      if (!s.turnTimestamps.has(Number(t)) && !s.turnSnapshots.has(Number(t))) {
        // Keep turns that are only on disk (memory-evicted) — they are still
        // rewound-able; drop turns the session actually pruned.
        const pruned = Number(t) > s.currentTurn || !diskTurnLive(key, s, Number(t));
        if (pruned) delete mirror.turns[t];
      }
    }
    const dir = bucketDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const file = nodePath.join(dir, "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mirror), "utf-8");
    renameSyncWithRetry(tmp, file);
  } catch {
    // Best-effort mirror; memory checkpoints keep working.
  }
}

/** A turn is live if memory still has it OR it was recorded and not rewound
 *  past. Simple monotonic rule: turns ≤ currentTurn that were ever written. */
function diskTurnLive(_key: string, s: SessionCheckpoints, turn: number): boolean {
  return turn <= s.currentTurn;
}

function loadPersisted(key: string): PersistedBucket | null {
  try {
    const raw = fs.readFileSync(nodePath.join(bucketDir(key), "state.json"), "utf-8");
    const parsed = JSON.parse(raw) as PersistedBucket;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Approximate content bytes currently held in memory for a bucket. */
function memoryBytes(s: SessionCheckpoints): number {
  let bytes = 0;
  for (const c of s.originals.values()) bytes += c?.length ?? 0;
  for (const snap of s.turnSnapshots.values()) {
    for (const c of snap.values()) bytes += c?.length ?? 0;
  }
  return bytes;
}

/** Evict the OLDEST turn snapshots from memory until under the byte cap.
 *  Disk copies remain; restoreToTurn re-reads them lazily. */
function evictToMemoryCap(s: SessionCheckpoints): void {
  while (memoryBytes(s) > MAX_CHECKPOINT_MEMORY_BYTES && s.turnSnapshots.size > 1) {
    let oldest = Number.POSITIVE_INFINITY;
    for (const t of s.turnSnapshots.keys()) if (t < oldest) oldest = t;
    if (oldest === Number.POSITIVE_INFINITY) break;
    s.turnSnapshots.delete(oldest);
  }
}

/** Boundary lookup with disk fallback (memory-evicted or hydrated buckets). */
function boundaryFor(
  key: string,
  s: SessionCheckpoints,
  turn: number,
): Map<string, string | null> | undefined {
  const inMemory = s.turnSnapshots.get(turn);
  if (inMemory) return inMemory;
  const mirror = diskMirrors.get(key) ?? loadPersisted(key);
  const entry = mirror?.turns[String(turn)];
  if (!entry) return undefined;
  const out = new Map<string, string | null>();
  for (const [path, blob] of Object.entries(entry.files)) {
    const content = readBlob(key, blob);
    // A lost blob (undefined) is skipped, leaving the path "not tracked at
    // this boundary" — restoreToTurn then leaves the file untouched instead
    // of misreading the loss as "did not exist" and deleting it (#7③).
    if (content !== undefined) out.set(path, content);
  }
  return out;
}

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
    // Hydrate from the disk mirror (Top10 follow-up C8): a restarted/resumed
    // process regains the shadows and turn index, so /rewind can still
    // restore files. Turn SNAPSHOT contents stay lazy (boundaryFor reads
    // blobs on demand) to keep hydration cheap.
    const persisted = loadPersisted(key);
    if (persisted) {
      diskMirrors.set(key, persisted);
      s.currentTurn = persisted.currentTurn;
      for (const [p, o] of Object.entries(persisted.originals ?? {})) {
        // Undefined = blob lost on disk. Keep the firstWriteTurn bookkeeping
        // but NO originals entry: restoreToTurn iterates originals, so the
        // path is skipped (file untouched) instead of being deleted as a
        // phantom "session-created" file (#7③).
        const content = readBlob(key, o.blob);
        if (content !== undefined) s.originals.set(p, content);
        s.firstWriteTurn.set(p, o.firstWriteTurn);
      }
      for (const [t, entry] of Object.entries(persisted.turns ?? {})) {
        s.turnTimestamps.set(Number(t), entry.ts);
      }
    }
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
 * pays.
 *
 * TRUST DOMAIN: the cache is only valid between writes we KNOW about. Every
 * tool-mediated write is preceded by shadowBeforeWrite and every restore
 * writes through restoreToTurn — both DELETE the path's cache entry, so the
 * next boundary read can't hit a same-mtime stale entry (back-to-back writes
 * within one mtime tick are exactly what CI tmpdirs produce). Writes from
 * outside the domain (Bash) share the standing checkpoint caveat.
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

/** Drop a path's cached content — called after any write we performed or
 *  are about to perform (shadowBeforeWrite precedes a tool's write). */
function invalidateCache(s: SessionCheckpoints, filePath: string): void {
  s.contentCache.delete(filePath);
}

/**
 * Upper bound on boundary snapshots held IN MEMORY (memory guard). Review
 * follow-up #7②: the old comment claimed older turns "become conversation-
 * only" — since C8 that is false. A memory-pruned turn's snapshot still lives
 * on disk (state.json + blobs) and boundaryFor() serves it lazily, so rewinds
 * past this window still restore files. Timestamps are deliberately KEPT here
 * so /rewind's turn list stays complete and matches what a restart would
 * re-hydrate (previously a turn vanished from the list at the 100-cap and
 * reappeared after a restart).
 */
const MAX_TURN_SNAPSHOTS = 100;

function pruneOldestSnapshots(s: SessionCheckpoints): void {
  while (s.turnSnapshots.size > MAX_TURN_SNAPSHOTS) {
    // Turn numbers are monotonic per bucket EXCEPT across a rewind (numbers
    // are reused from the rewind point) — so "oldest" = smallest still-live
    // turn, which is exactly what a fresh loop over the keys gives.
    let oldest = Number.POSITIVE_INFINITY;
    for (const t of s.turnSnapshots.keys()) if (t < oldest) oldest = t;
    if (oldest === Number.POSITIVE_INFINITY) break;
    s.turnSnapshots.delete(oldest); // disk copy survives; boundaryFor re-reads
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
  const key = bucketKey(sessionId);
  const s = bucket(sessionId);
  s.currentTurn += 1;
  const snapshot = new Map<string, string | null>();
  for (const path of s.originals.keys()) snapshot.set(path, snapshotAt(s, path));
  s.turnSnapshots.set(s.currentTurn, snapshot);
  s.turnTimestamps.set(s.currentTurn, Date.now());
  pruneOldestSnapshots(s);
  // Memory cap: oldest snapshots may live on disk only from here on (C8).
  evictToMemoryCap(s);
  // Mirror the boundary to disk: blobs for each tracked file's content plus
  // the index entry. Best-effort — failures keep the memory checkpoint alive.
  try {
    let mirror = diskMirrors.get(key);
    if (!mirror) {
      mirror = { version: 1, currentTurn: 0, originals: {}, turns: {} };
      diskMirrors.set(key, mirror);
    }
    const files: Record<string, string | null> = {};
    for (const [p, c] of snapshot) {
      if (c === null) files[p] = null;
      else {
        const blob = writeBlob(key, c);
        if (blob !== null) files[p] = blob;
      }
    }
    mirror.turns[String(s.currentTurn)] = { ts: s.turnTimestamps.get(s.currentTurn)!, files };
    mirror.currentTurn = s.currentTurn;
    persistState(key, s);
  } catch {
    // best-effort
  }
  if (msg !== undefined) {
    turnTags.set(msg, s.currentTurn);
    if ("role" in msg && msg.role === "user") {
      Object.assign(msg, { checkpoint: { sessionId: key, turn: s.currentTurn } });
    }
  }
  return s.currentTurn;
}

/** Resolve a live or persisted tag; untagged legacy and synthetic messages return null. */
export function turnOfMessage(msg: object, sessionId?: string): number | null {
  if ("checkpoint" in msg) {
    const tag = msg.checkpoint as { sessionId?: unknown; turn?: unknown } | undefined;
    if (
      tag &&
      typeof tag.sessionId === "string" &&
      Number.isSafeInteger(tag.turn) &&
      Number(tag.turn) > 0
    ) {
      if (sessionId !== undefined && tag.sessionId !== bucketKey(sessionId)) return null;
      return Number(tag.turn);
    }
  }
  return turnTags.get(msg) ?? null;
}

/**
 * Shadow a file's original content. Tools call this immediately BEFORE their
 * fs write; only the first call per path (per session) captures, so the
 * stored value is the true pre-session content no matter how many edits
 * follow. Also records the turn of the first write (restore targeting).
 */
export function shadowBeforeWrite(sessionId: string, filePath: string): void {
  const key = bucketKey(sessionId);
  const s = bucket(sessionId);
  if (!s.originals.has(filePath)) {
    s.originals.set(filePath, snapshotAt(s, filePath));
    s.firstWriteTurn.set(filePath, Math.max(1, s.currentTurn));
    // Persist the new shadow (C8) so a kill before the turn boundary still
    // leaves the pre-session original recoverable.
    persistState(key, s);
  }
  // A tool write follows IMMEDIATELY after this call — whatever the capture
  // just cached is about to be stale, and the write can land within the same
  // mtime tick (CI tmpdirs do exactly this). Drop the entry so the next
  // boundary read can't hit it (see snapshotAt's trust-domain note).
  invalidateCache(s, filePath);
}

export interface RestoreResult {
  /** Files whose content was rewritten to an earlier state. */
  restored: string[];
  /** Session-created files deleted by the rewind. */
  deleted: string[];
  failures?: Array<{ path: string; error: string }>;
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
  const key = bucketKey(sessionId);
  // bucket() (not the raw map) so a restarted process hydrates the disk
  // mirror and can still rewind (Top10 follow-up C8).
  const s = bucket(sessionId);
  if (s.currentTurn === 0 && s.originals.size === 0) return { restored: [], deleted: [] };
  const target = Math.max(1, turn);
  const boundary = boundaryFor(key, s, target);
  const restored: string[] = [];
  const deleted: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  for (const path of s.firstWriteTurn.keys()) {
    if (!s.originals.has(path)) {
      failures.push({ path, error: "Checkpoint original content is missing or unreadable." });
    }
  }

  for (const [path, original] of s.originals) {
    const firstTurn = s.firstWriteTurn.get(path) ?? target;
    let content: string | null | undefined;
    if (firstTurn >= target) {
      content = original;
    } else {
      content = boundary?.get(path);
    }
    if (content === undefined) {
      failures.push({ path, error: "Checkpoint boundary content is missing or unreadable." });
      continue;
    }
    try {
      if (content === null) {
        // Original did not exist — remove the session-created file. Only
        // report a deletion when a file was actually removed.
        if (fs.existsSync(path)) {
          fs.rmSync(path);
          invalidateCache(s, path); // we just changed the disk state
          deleted.push(path);
        }
      } else {
        fs.mkdirSync(dirname(path), { recursive: true });
        // Restore atomically so a crash cannot leave a half-written file. The
        // temp file lives beside the destination, ensuring rename stays on the
        // same filesystem and readers see either old or restored content.
        const tmp = `${path}.${process.pid}.${Date.now()}.rewind.tmp`;
        try {
          fs.writeFileSync(tmp, content, "utf-8");
          renameSyncWithRetry(tmp, path);
        } finally {
          try {
            if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
          } catch {
            /* best effort cleanup */
          }
        }
        invalidateCache(s, path); // we just changed the disk state
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
    } catch (error) {
      failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Retain the boundary and shadows on partial failure, so retry is possible.
  if (failures.length) return { restored, deleted, failures };

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
  // Prune the disk mirror the same way (C8): rewound-away turns and shadows
  // must not survive on disk, or a restart would resurrect future state.
  const mirror = diskMirrors.get(key);
  if (mirror) {
    for (const t of Object.keys(mirror.turns)) {
      if (Number(t) >= target) delete mirror.turns[t];
    }
    for (const [p, o] of Object.entries(mirror.originals)) {
      if (o.firstWriteTurn >= target) delete mirror.originals[p];
    }
  }
  persistState(key, s);
  // The prune above orphaned blobs (state.json references dropped, files left
  // behind) — reclaim them now (#7①). A rewind is the only pruning event, so
  // this is the only place GC needs to run; resetCheckpoints rm -rf's the
  // whole bucket anyway.
  gcBlobs(key);
  return { restored, deleted };
}

/** Files modified so far this session (path → first-write turn). Hydrates
 *  from the disk mirror after a restart (C8). */
export function changedFiles(sessionId: string): Map<string, number> {
  const s = bucket(sessionId);
  return new Map(s.firstWriteTurn);
}

/** Turn boundaries recorded so far: [{turn, timestamp, filesChanged}].
 *  Hydrates from the disk mirror after a restart (C8). */
export function listTurns(sessionId: string): Array<{
  turn: number;
  timestamp: number;
  filesChanged: number;
}> {
  const s = bucket(sessionId);
  const out: Array<{ turn: number; timestamp: number; filesChanged: number }> = [];
  for (const [turn, timestamp] of s.turnTimestamps) {
    // The turn's own edits are the ones whose first write is exactly `turn`.
    let filesChanged = 0;
    for (const ft of s.firstWriteTurn.values()) if (ft === turn) filesChanged++;
    out.push({ turn, timestamp, filesChanged });
  }
  return out.sort((a, b) => a.turn - b.turn);
}

/** Clear checkpoints for a session (e.g. on /clear) — memory AND disk (C8). */
export function resetCheckpoints(sessionId: string): void {
  const key = bucketKey(sessionId);
  sessions.delete(key);
  diskMirrors.delete(key);
  try {
    fs.rmSync(bucketDir(key), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  storageRoots.delete(key);
}

/** Test/util: clear everything — memory buckets, disk mirrors, and the
 *  persisted checkpoint tree for the current workspace root. */
export function resetAllCheckpoints(): void {
  sessions.clear();
  diskMirrors.clear();
  try {
    fs.rmSync(checkpointRoot(), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  storageRoots.clear();
}

/** Test-only: drop in-memory state WITHOUT touching disk — simulates a
 *  process restart so hydration-from-disk paths can be exercised. */
export function __clearCheckpointMemoryForTests(): void {
  sessions.clear();
  diskMirrors.clear();
  storageRoots.clear();
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : ".";
}
