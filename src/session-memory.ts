// ============================================================
// SessionMemory — session messages + metadata (M19.1)
// ============================================================
// Owns the session message snapshot: full conversation history stored as a
// single JSON file under <workspace>/.claude/sessions/<sessionId>.json.
//
// This is the relocated home of what used to live in persistence.ts. The old
// `PersistenceManager` is now a thin subclass (see persistence.ts) so every
// existing call site and the persistence test suite keep working unchanged.
//
// Behavior here is byte-for-byte the same as the previous PersistenceManager:
//   - serialized save chain (no read-modify-write clobber)
//   - atomic temp-file + rename write
//   - corrupt / missing file degrades to null instead of throwing
//
// Version History:
//   v1: Initial format with version, sessionId, createdAt, updatedAt, messages
//   v2: Added workspaceRoot, messageCount, completed fields
//   v3: Added taskState and lastTerminalReason. These describe runtime facts,
//       never whether an arbitrary user task is business-complete.
// ============================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { resetCheckpoints } from "./checkpoint.js";
import { releaseSessionGoal } from "./goal-runtime.js";
import { saveSessionRuntime } from "./session-runtime.js";
import { deleteRunsInDir } from "./subagent-store.js";
import { firstUserPreview } from "./tui/history-replay.js";
import type { Message } from "./types.js";
import { renameWithRetry } from "./utils/atomic-rename.js";
import { ccrPath } from "./workspace-config.js";

// --- Format Version ---

/** Current session format version. Increment when the schema changes. */
export const SESSION_FORMAT_VERSION = 3;

/**
 * Session ids are file-name components (sessions/<id>.json, transcript
 * sidecars, checkpoint buckets). Externally supplied ids (--session-id,
 * --resume, --from-pr metadata) must be restricted to a charset that cannot
 * traverse directories: no separators, no dots (kills ".."), bounded length.
 * Generated ids (UUID, "<id>-skill-<ts>") fit this by construction. The
 * optional ".corrupt-<digits>" suffix covers this module's own quarantine
 * backups, which load() re-reads under that name — still no separators, no
 * leading dot, no "..", so it cannot traverse either.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(\.corrupt-\d+)?$/;
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/** Bound on the lastSaved write-through cache (LRU by insertion order).
 *  Without it a long-running process pinned full message arrays for every
 *  session it ever saved (Top10 follow-up C3). */
const LAST_SAVED_CACHE_MAX = 4;

/** Durable lifecycle facts for a resumable main task. */
export type TaskState =
  | "waiting_for_model"
  | "waiting_for_tool"
  | "recovering"
  | "paused"
  | "failed"
  | "stopped_by_user";

/**
 * Normalize finish_reason from different providers to standard values.
 * Different LLM providers return different strings for the same concept.
 */
export function normalizeFinishReason(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  // Natural completion
  if (["stop", "end_turn", "completed", "end"].includes(lower)) return "stop";
  // Token limit reached
  if (["length", "max_tokens", "token_limit"].includes(lower)) return "length";
  // Tool use
  if (["tool_calls", "tool_use", "function_call"].includes(lower)) return "tool_calls";
  // Content filter
  if (["content_filter", "safety"].includes(lower)) return "content_filter";
  // Return as-is if unknown
  return raw;
}

/** Version migration map: old version → migration function */
type MigrationFn = (data: unknown) => SessionData;

/** Raw on-disk session shape probed by migrations; fields validated at runtime. */
interface RawSessionData {
  sessionId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  workspaceRoot?: unknown;
  messages?: unknown;
  messageCount?: unknown;
  completed?: unknown;
}

const migrations: Record<number, MigrationFn> = {
  // v1 → v2: Add workspaceRoot, messageCount, completed fields
  1: (data: unknown) => {
    const d = data as RawSessionData;
    if (!d || typeof d !== "object") {
      throw new Error("Invalid v1 session: data is not an object");
    }
    if (typeof d.sessionId !== "string" || !d.sessionId) {
      throw new Error("Invalid v1 session: missing or invalid sessionId");
    }
    if (!Array.isArray(d.messages)) {
      throw new Error("Invalid v1 session: missing or invalid messages array");
    }
    if (typeof d.createdAt !== "string" || typeof d.updatedAt !== "string") {
      throw new Error("Invalid v1 session: missing or invalid timestamps");
    }
    return {
      version: SESSION_FORMAT_VERSION,
      sessionId: d.sessionId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      workspaceRoot: (d.workspaceRoot || "") as string,
      messages: d.messages,
      messageCount: d.messages.length,
      completed: Boolean(d.completed),
      taskState: "paused" as TaskState,
    };
  },
  // v2 → v3: Existing "completed" only meant that the process exited cleanly.
  // Preserve it for compatibility, but represent the resumable lifecycle as
  // paused rather than inferring that the user's work is complete.
  2: (data: unknown) => {
    const d = data as RawSessionData;
    if (!d || typeof d !== "object") {
      throw new Error("Invalid v2 session: data is not an object");
    }
    if (typeof d.sessionId !== "string" || !d.sessionId) {
      throw new Error("Invalid v2 session: missing or invalid sessionId");
    }
    if (!Array.isArray(d.messages)) {
      throw new Error("Invalid v2 session: missing or invalid messages array");
    }
    if (typeof d.messageCount !== "number" || d.messageCount < 0) {
      throw new Error("Invalid v2 session: missing or invalid messageCount");
    }
    return {
      version: SESSION_FORMAT_VERSION,
      sessionId: d.sessionId,
      createdAt: d.createdAt as string,
      updatedAt: d.updatedAt as string,
      workspaceRoot: (d.workspaceRoot || "") as string,
      messages: d.messages,
      messageCount: d.messageCount,
      completed: Boolean(d.completed),
      taskState: "paused" as TaskState,
      lastTerminalReason: undefined,
    };
  },
};

// --- Types ---

export interface SessionData {
  version: number;
  sessionId: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  workspaceRoot: string;
  messages: Message[];
  messageCount: number;
  completed: boolean;
  /** Runtime state only; it intentionally carries no business-completion claim. */
  taskState: TaskState;
  /** Last terminal reason emitted by the agent loop, when one exists. */
  lastTerminalReason?: string;
  /** Display name from the official `-n, --name <name>` flag. */
  name?: string;
  /**
   * Pull request linked to this session by the official
   * `--from-pr [value]` flag. Official persists the same three fields
   * and matches on `prNumber`; `prRepository` is what keeps PR #7 of
   * one repo from resuming a session linked to PR #7 of another.
   */
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
}

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  completed: boolean;
  taskState: TaskState;
  lastTerminalReason?: string;
  /** Display name from the official `-n, --name <name>` flag. */
  name?: string;
  /** Linked pull request, from the official `--from-pr [value]` flag. */
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
}

export interface SessionCatalogEntry extends SessionMeta {
  pinned: boolean;
  preview: string;
}

// --- Session memory store ---

export class SessionMemory {
  /** Stable workspace owning session files, unaffected by the tools' current cwd. */
  get workspaceRoot(): string {
    return path.resolve(this.sessionsDir, "..", "..");
  }
  private sessionsDir: string;
  /**
   * Save serialization queue. `save()` does a read-modify-write (load existing
   * to preserve `createdAt`, then write), so concurrent saves from the TUI's
   * onSave + the loop's auto-save + an interrupting cleanup would race: the
   * second load reads stale data and the first write is clobbered, losing the
   * latest messages. Chaining every save onto a single Promise chain makes the
   * read-modify-write critical section effectively atomic.
   */
  private saveChain: Promise<void> = Promise.resolve();
  /**
   * P2 step 1: last-written SessionData per session, with the file mtime
   * observed right after the write. saveSerialized previously re-loaded and
   * JSON.parsed the ENTIRE session file on every save just to preserve
   * createdAt — O(messages) disk+parse work per turn. The cache is consulted
   * INSIDE the cross-process lock and only trusted when the on-disk mtime
   * still matches (Top10 #9): another process resuming the same session
   * bumps the mtime, and the divergence is then surfaced instead of being
   * blindly clobbered. Messages are kept by reference — the caller's own
   * array, so no extra copies.
   */
  private lastSaved = new Map<string, { data: SessionData; mtimeMs: number }>();
  /** Sessions for which the cross-process divergence warning already fired
   *  (once per session per process — every save would warn otherwise). */
  private warnedDivergence = new Set<string>();
  /** Sessions for which the "lock unavailable, save skipped" warning already
   *  fired (same once-per-session throttle). */
  private warnedLockSkip = new Set<string>();
  /** Last preview string actually written to the catalog for a session. */
  private lastPreviewWritten = new Map<string, string>();
  /**
   * Display names pending their first write, from the official
   * `-n, --name <name>` flag. Recorded rather than written immediately: the
   * session file may not exist yet, and every save call site (TUI onSave,
   * headless save, agent-loop autosave) would otherwise have to thread the
   * name through just to keep a label.
   */
  private pendingNames = new Map<string, string>();
  /**
   * Linked pull request per session, from the official
   * `--from-pr [value]` flag. Same deferred-write rationale as
   * pendingNames: the session file may not exist yet, and the linkage has
   * to survive the first auto-save without every call site knowing about it.
   */
  private pendingPullRequests = new Map<
    string,
    { prNumber: number; prUrl?: string; prRepository?: string }
  >();

  constructor(workspaceRoot: string) {
    this.sessionsDir = ccrPath(workspaceRoot, "sessions");
  }

  /** Set once the orphaned-tmp sweep has run for this instance. */
  private tmpSwept = false;

  /**
   * Ensure the sessions directory exists. On first use, also sweep orphaned
   * `*.tmp` files left by crashed/killed saves (Top10 follow-up C4) — but
   * only ones older than a minute, so a concurrent live process's in-flight
   * tmp→rename window is never touched. `.lock` dirs and `.corrupt-` backups
   * are deliberately not swept.
   */
  private ensureDir(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    if (this.tmpSwept) return;
    this.tmpSwept = true;
    try {
      const cutoff = Date.now() - 60_000;
      for (const entry of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
        const full = path.join(this.sessionsDir, entry.name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        } catch {
          // Raced with its owner's rename — fine.
        }
      }
    } catch {
      // Sweep is best-effort; never blocks the save.
    }
  }

  /**
   * Get the file path for a session
   */
  private sessionPath(sessionId: string): string {
    // Defense in depth (review: "--session-id/--resume 无格式校验目录穿越"):
    // a sessionId containing separators or ".." would escape sessionsDir.
    // Entry points validate too, but every path constructor is a floor.
    if (!isValidSessionId(sessionId)) {
      throw new Error(`Invalid session id: ${JSON.stringify(sessionId.slice(0, 64))}`);
    }
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  private catalogPath(): string {
    return path.join(this.sessionsDir, "catalog.json");
  }

  private async readCatalog(): Promise<Record<string, { pinned?: boolean; preview?: string }>> {
    try {
      const raw = await fsPromises.readFile(this.catalogPath(), "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const out: Record<string, { pinned?: boolean; preview?: string }> = {};
      for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const pinned = (value as { pinned?: unknown }).pinned;
        const preview = (value as { preview?: unknown }).preview;
        out[sessionId] = {
          pinned: Boolean(pinned),
          preview: typeof preview === "string" ? preview : undefined,
        };
      }
      return out;
    } catch {
      // A missing or unreadable catalog degrades to an empty one.
      return {};
    }
  }

  private async writeCatalogRaw(
    catalog: Record<string, { pinned?: boolean; preview?: string }>,
  ): Promise<void> {
    this.ensureDir();
    const filePath = this.catalogPath();
    // pid-suffixed like saveSerialized (fourth-round review): the lockless
    // optimistic fallback in updateCatalog also writes, and a SHARED fixed
    // tmp name could interleave with a locked writer's rename — tearing
    // catalog.json into invalid JSON. The startup tmp sweep still matches
    // (endsWith ".tmp").
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(catalog, null, 2), "utf-8");
    await renameWithRetry(tmpPath, filePath);
  }

  /**
   * Atomic catalog read-modify-write (review follow-up M3). The old
   * readCatalog() → mutate → writeCatalog() sequence held the lock only for
   * the WRITE: two processes pinning/previewing concurrently both read the
   * old state and the later writer silently dropped the earlier one's entry.
   * The lock must span the whole cycle.
   *
   * Degradation: if the lock cannot be acquired (another process holds it
   * past the retry budget), warn and fall back to the optimistic
   * read-modify-write — the catalog is low-risk metadata, and losing a pin
   * under rare contention beats throwing into callers that don't expect it.
   */
  private async updateCatalog(
    mutate: (
      catalog: Record<string, { pinned?: boolean; preview?: string }>,
    ) => Promise<boolean> | boolean,
  ): Promise<void> {
    this.ensureDir();
    const filePath = this.catalogPath();
    try {
      await fsPromises.writeFile(filePath, "{}", { encoding: "utf-8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let release: (() => Promise<void>) | undefined;
    let locked = false;
    try {
      release = await lockfile.lock(filePath, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
        stale: 10000,
        onCompromised: (err: Error) => {
          console.warn(`session-memory: catalog lock was compromised: ${err.message}`);
        },
      });
      locked = true;
    } catch (lockError) {
      console.warn(
        `session-memory: catalog lock unavailable, updating optimistically: ${
          lockError instanceof Error ? lockError.message : String(lockError)
        }`,
      );
    }
    try {
      const catalog = await this.readCatalog();
      const changed = await mutate(catalog);
      if (changed !== false) await this.writeCatalogRaw(catalog);
    } finally {
      if (locked && release) {
        await release().catch(() => {
          // Ignore unlock errors (file may have been deleted)
        });
      }
    }
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    await this.updateCatalog((catalog) => {
      if (pinned) {
        catalog[sessionId] = { ...(catalog[sessionId] ?? {}), pinned: true };
      } else {
        // Unpin but keep preview if it exists
        const existing = catalog[sessionId];
        if (existing?.preview) {
          catalog[sessionId] = { preview: existing.preview };
        } else {
          delete catalog[sessionId];
        }
      }
      return true;
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Review follow-up M4: route the delete through the SAME serialization
    // the saves use. A save queued before the delete must flush FIRST (then
    // the unlink removes its file); without chaining, the unlink could land
    // between the queued save's read and its rename, and the save would
    // resurrect a session whose catalog entry was already cleaned — an orphan.
    const task = this.saveChain.then(() => this.deleteSerialized(sessionId));
    this.saveChain = task.catch(() => undefined);
    return task;
  }

  private async deleteSerialized(sessionId: string): Promise<void> {
    const filePath = this.sessionPath(sessionId);
    // Take the cross-process lock around the unlink so a concurrent save in
    // ANOTHER process doesn't interleave (best-effort: if the lock is
    // unavailable, still delete — same availability-over-strictness tradeoff
    // as the save path, and the other process's in-memory state is beyond
    // our reach regardless).
    let release: (() => Promise<void>) | undefined;
    try {
      if (fs.existsSync(filePath)) {
        try {
          release = await lockfile.lock(filePath, {
            retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
            stale: 10000,
            onCompromised: () => {},
          });
        } catch (lockError) {
          console.warn(
            `session-memory: could not lock ${sessionId} for deletion, removing anyway: ${
              lockError instanceof Error ? lockError.message : String(lockError)
            }`,
          );
        }
      }
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Top10 follow-up C5: the session's transcript sidecar must go too —
      // it used to survive as an orphan that listSessions never showed but
      // resume-adjacent tooling could still stumble over.
      try {
        fs.unlinkSync(path.join(this.sessionsDir, `${sessionId}.transcript.jsonl`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Fourth-round review: the session's checkpoint BUCKET must go too —
      // .claude/checkpoints/<bucket>/ held every shadowed-file blob and used
      // to survive session deletion forever (the 64MB cap only bounds RAM,
      // and gcBlobs only fires on rewind), so the tree grew unboundedly.
      // resetCheckpoints clears memory + disk best-effort; it targets the
      // deleted sessionId only, never the running session's bucket.
      try {
        resetCheckpoints(sessionId);
      } catch {
        // best-effort — bucket cleanup must not fail the session delete
      }
      // 拍板 #19: the session's sub-agent run records are FULL transcripts in
      // sessions/subagents-<id>/. deleteRuns used to have no caller at all, so
      // they outlived the session forever (and every /agents history re-read
      // them). They go with the session.
      try {
        deleteRunsInDir(this.sessionsDir, sessionId);
      } catch {
        // best-effort — record cleanup must not fail the session delete
      }
    } finally {
      if (release) {
        await release().catch(() => {
          // Ignore unlock errors (file is gone — that's the point)
        });
      }
    }
    // A deleted session's cached last-written object must go too, or a later
    // save would resurrect its createdAt/version from the stale cache.
    this.lastSaved.delete(sessionId);
    releaseSessionGoal(sessionId);
    try {
      fs.unlinkSync(
        path.join(path.dirname(this.sessionsDir), "session-runtime", `${sessionId}.json`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(`Could not delete session runtime: ${String(error)}`);
    }
    this.lastPreviewWritten.delete(sessionId);
    this.warnedDivergence.delete(sessionId);
    this.warnedLockSkip.delete(sessionId);
    await this.updateCatalog((catalog) => {
      if (!catalog[sessionId]) return false; // nothing to clean, skip the write
      delete catalog[sessionId];
      return true;
    });
  }

  async isPinned(sessionId: string): Promise<boolean> {
    const catalog = await this.readCatalog();
    return Boolean(catalog[sessionId]?.pinned);
  }

  async getCatalogEntry(
    sessionId: string,
    messagePreview?: string,
  ): Promise<SessionCatalogEntry | null> {
    const data = await this.load(sessionId);
    if (!data) return null;
    const catalog = await this.readCatalog();
    return {
      sessionId: data.sessionId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messageCount,
      completed: data.completed,
      taskState: data.taskState,
      lastTerminalReason: data.lastTerminalReason,
      name: data.name,
      prNumber: data.prNumber,
      prUrl: data.prUrl,
      prRepository: data.prRepository,
      pinned: Boolean(catalog[sessionId]?.pinned),
      preview: messagePreview ?? firstUserPreview(data.messages),
    };
  }

  async searchSessions(query: string): Promise<SessionCatalogEntry[]> {
    const q = query.trim().toLowerCase();
    const sessions = await this.listSessions();
    const catalog = await this.readCatalog();
    const enriched: SessionCatalogEntry[] = [];
    for (const session of sessions) {
      // Use cached preview from catalog, only load full session if not cached
      let preview = catalog[session.sessionId]?.preview;
      if (!preview) {
        const data = await this.load(session.sessionId);
        preview = data ? firstUserPreview(data.messages) : "";
      }
      const entry: SessionCatalogEntry = {
        ...session,
        pinned: Boolean(catalog[session.sessionId]?.pinned),
        preview,
      };
      if (!q) {
        enriched.push(entry);
        continue;
      }
      const haystack = [
        entry.sessionId,
        entry.createdAt,
        entry.updatedAt,
        entry.preview,
        entry.taskState,
        entry.name ?? "",
        // Official's picker shows the PR a session is linked to, so the
        // number is searchable text there; matching it here makes
        // `/resume 42` and `--session 42` find the PR session too.
        entry.prNumber === undefined ? "" : `PR #${entry.prNumber}`,
        entry.pinned ? "pinned" : "",
      ]
        .join(" ")
        .toLowerCase();
      if (haystack.includes(q)) enriched.push(entry);
    }
    return enriched.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }

  /**
   * Generate a new session ID
   */
  generateId(): string {
    return crypto.randomUUID();
  }

  /**
   * Save a session to disk.
   *
   * Writes are serialized via `saveChain` so concurrent callers (TUI onSave,
   * loop auto-save, cleanup-on-exit) don't interleave their read-modify-write
   * and clobber each other. The actual file write is atomic: we write to a
   * sibling temp file then rename, so a crash mid-write never leaves a
   * truncated/partial session file (which would make the session unresumable).
   * Returns a Promise that resolves once THIS save has flushed.
   */
  /**
   * Attach a display name to a session. Takes effect on the next save, which
   * always happens (a session with no messages yet still saves on its first
   * turn) and never rewrites a name an explicit `save({ name })` set later.
   */
  setSessionName(sessionId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.pendingNames.set(sessionId, trimmed);
  }

  /**
   * Link a session to a pull request so a later `--from-pr <same>` resumes it.
   * Only ever called for a session the user named a PR for, never inferred
   * from the current branch — see from-pr.ts for why the automatic
   * branch→PR linkage official gets from its GitHub integration is not
   * reproduced here.
   */
  setSessionPullRequest(
    sessionId: string,
    ref: { number: number; url?: string; repository?: string },
  ): void {
    this.pendingPullRequests.set(sessionId, {
      prNumber: ref.number,
      prUrl: ref.url,
      prRepository: ref.repository,
    });
  }

  async save(
    sessionId: string,
    messages: Message[],
    options?: {
      completed?: boolean;
      taskState?: TaskState;
      lastTerminalReason?: string;
      name?: string;
      /**
       * Final-save marker (review fix "退出时最后一次保存被静默跳过"):
       * wait out a competing process's lock instead of skipping — there is
       * no "next save" after an exit. On unrecoverable lock failure the save
       * rejects so the exit path reports it.
       */
      waitForLock?: boolean;
    },
  ): Promise<void> {
    // Snapshot semantics, for real this time (Top10 follow-up C1): capture a
    // SHALLOW COPY at enqueue time. The comment always claimed "each link
    // captures its own messages snapshot", but the queued closure held the
    // LIVE array reference — a save waiting behind a slow lock serialized
    // whatever the array had become by then (post-truncation /post-rewind
    // state stamped with the wrong taskState), not the moment it was asked.
    const snapshot = [...messages];
    // Chain onto the tail of any in-flight save.
    const next = this.saveChain.then(() => this.saveSerialized(sessionId, snapshot, options));
    // Swallow rejection on the chain itself so a failing save doesn't poison
    // subsequent ones; the caller still sees the rejection via `next`.
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  private async saveSerialized(
    sessionId: string,
    messages: Message[],
    options:
      | {
          completed?: boolean;
          taskState?: TaskState;
          lastTerminalReason?: string;
          name?: string;
          waitForLock?: boolean;
        }
      | undefined,
  ): Promise<void> {
    this.ensureDir();

    const filePath = this.sessionPath(sessionId);
    const now = new Date().toISOString();

    let data: SessionData;
    let release: (() => Promise<void>) | undefined;
    try {
      // Cross-process lock (Top10 #9): saveChain only serializes saves WITHIN
      // this process — two terminals resuming the same session used to
      // full-rewrite the same file with the later writer silently clobbering
      // the earlier one's messages. Same lockfile pattern/parameters as the
      // catalog lock (battle-tested). Lock order is always session → catalog:
      // the catalog update below runs AFTER this lock is released and
      // updateCatalog takes its own lock, and no path takes them reversed.
      try {
        // lockfile needs the file to exist. "wx" (exclusive create) so the
        // placeholder can NEVER truncate a complete session another process
        // renamed into place between an exists-check and the write (review
        // follow-up M2). "{}" loads as null and load() never quarantines it.
        await fsPromises.writeFile(filePath, "{}", { encoding: "utf-8", flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      try {
        release = await lockfile.lock(filePath, {
          retries: options?.waitForLock
            ? // Exit-path save (review fix "退出时最后一次保存被静默跳过"): a
              // competing process may hold the lock for a while — wait it out
              // instead of skipping, because there is no "next save" coming.
              { retries: 100, minTimeout: 50, maxTimeout: 500 }
            : { retries: 5, minTimeout: 50, maxTimeout: 200 },
          stale: 10000,
          // proper-lockfile's DEFAULT onCompromised throws synchronously from
          // a timer when another process steals a lock it deems stale — an
          // uncaughtException that would kill the CLI (review follow-up M3).
          // Degrade to a warning: our write may interleave, but the atomic
          // tmp+rename still guarantees readers never see a torn file.
          onCompromised: (err: Error) => {
            console.warn(
              `session-memory: cross-process lock for ${sessionId} was compromised: ${err.message}`,
            );
          },
        });
      } catch (lockError) {
        // Lock budget exhausted (another process holds it — the exact
        // dual-terminal case the lock exists for) or lockfile I/O failure.
        // SKIP this save instead of rejecting (review follow-up H1): callers
        // treat auto-saves as best-effort fire-and-forget, and a rejection
        // there surfaces as an unhandledRejection that tears down the whole
        // REPL. The next turn re-saves the same (in-memory) messages, so
        // skipping costs at most one save point. Warn once per session.
        // EXCEPTION (review fix): a waitForLock save is the FINAL save —
        // skipping it silently loses the tail of the conversation, so it
        // throws and the exit path reports the failure.
        if (options?.waitForLock) throw lockError;
        if (!this.warnedLockSkip.has(sessionId)) {
          this.warnedLockSkip.add(sessionId);
          console.warn(
            `session-memory: could not acquire the cross-process lock for session ${sessionId}; skipping this save (will retry on the next one): ${
              lockError instanceof Error ? lockError.message : String(lockError)
            }`,
          );
        }
        return;
      }

      // P2: prefer the in-memory last-written object over re-loading (and
      // re-parsing) the whole session file — but only when the on-disk mtime
      // still matches what we wrote (checked INSIDE the lock). A mismatch
      // means another process saved this session since; re-read the disk
      // state as the base (preserving the original createdAt) and surface the
      // divergence once instead of blindly clobbering it.
      const cached = this.lastSaved.get(sessionId);
      let existing: SessionData | null;
      // True when the on-disk state is NOT what this instance last wrote —
      // i.e. a foreign writer (another terminal) may have added messages.
      // Only then is a MERGE allowed; a same-writer save (including an
      // intentional truncation like /rewind) must overwrite.
      let foreignWrite = false;
      if (cached) {
        const diskMtime = await fsPromises.stat(filePath).then(
          (s) => s.mtimeMs,
          () => undefined,
        );
        if (diskMtime !== undefined && diskMtime === cached.mtimeMs) {
          existing = cached.data;
        } else {
          existing = await this.load(sessionId);
          foreignWrite = true;
          if (!this.warnedDivergence.has(sessionId)) {
            this.warnedDivergence.add(sessionId);
            console.warn(
              `session-memory: session ${sessionId} was modified by another process since this instance last saved it; merging both writers' messages (ours appended after the disk side). Avoid resuming the same session in two terminals.`,
            );
          }
        }
      } else {
        existing = await this.load(sessionId);
        // No cached write of ours: anything on disk came from somewhere else
        // (a resume's origin or another terminal) — treat as foreign so a
        // forked history is merged, while a plain resume (ours a superset)
        // degrades to the no-op overwrite.
        foreignWrite = existing !== null;
      }
      // Review fix ("双终端互相覆盖丢消息"): when the on-disk history is not
      // a prefix of ours (another terminal saved since our base), our
      // snapshot is a FORK, not a superset. Replace the old wholesale
      // `messages` overwrite with a common-prefix merge: the disk side's
      // newer messages survive, and ours continue after them. Same-writer
      // saves (incl. intentional truncations like /rewind) still overwrite.
      let messagesOut = messages;
      if (foreignWrite && existing && existing.messages.length > 0) {
        const theirs = existing.messages;
        let common = 0;
        while (
          common < messages.length &&
          common < theirs.length &&
          JSON.stringify(messages[common]) === JSON.stringify(theirs[common])
        )
          common++;
        if (theirs.length > common) {
          messagesOut = [...theirs, ...messages.slice(common)];
        }
      }

      const name = options?.name ?? this.pendingNames.get(sessionId) ?? undefined;
      const pullRequest = this.pendingPullRequests.get(sessionId);
      if (existing) {
        data = {
          ...existing,
          updatedAt: now,
          messages: messagesOut,
          messageCount: messagesOut.length,
          completed: options?.completed ?? existing.completed,
          taskState: options?.taskState ?? existing.taskState,
          lastTerminalReason: options?.lastTerminalReason ?? existing.lastTerminalReason,
          name: name ?? existing.name,
          prNumber: pullRequest?.prNumber ?? existing.prNumber,
          prUrl: pullRequest?.prUrl ?? existing.prUrl,
          prRepository: pullRequest?.prRepository ?? existing.prRepository,
        };
      } else {
        data = {
          version: SESSION_FORMAT_VERSION,
          sessionId,
          createdAt: now,
          updatedAt: now,
          workspaceRoot: path.dirname(this.sessionsDir),
          messages: messagesOut,
          messageCount: messagesOut.length,
          completed: options?.completed ?? false,
          taskState: options?.taskState ?? "paused",
          lastTerminalReason: options?.lastTerminalReason,
          name,
          prNumber: pullRequest?.prNumber,
          prUrl: pullRequest?.prUrl,
          prRepository: pullRequest?.prRepository,
        };
      }

      // No pretty-print: halves the serialized size of a message-heavy session.
      const json = JSON.stringify(data);

      // Atomic write: temp file + rename. A direct writeFile can leave a
      // truncated file if the process is killed (Ctrl+C / OOM) mid-write;
      // rename is atomic on the same filesystem, so readers always see either
      // the old or the new complete file, never a partial one.
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, json, "utf-8");
      await renameWithRetry(tmpPath, filePath);
      try {
        saveSessionRuntime(path.dirname(path.dirname(this.sessionsDir)), sessionId);
      } catch (error) {
        console.warn(`Session runtime save failed: ${String(error)}`);
      }
      // Record the mtime we just produced — the divergence check above
      // compares against it on the next save.
      const writtenMtime = await fsPromises.stat(filePath).then(
        (s) => s.mtimeMs,
        () => Date.now(),
      );
      // delete-then-set so Map insertion order tracks recency (LRU), then
      // bound the cache (Top10 follow-up C3): an unbounded Map pinned the
      // FULL message arrays of every session this process ever saved — a
      // long-running multi-resume process leaked the whole history set.
      this.lastSaved.delete(sessionId);
      this.lastSaved.set(sessionId, { data, mtimeMs: writtenMtime });
      while (this.lastSaved.size > LAST_SAVED_CACHE_MAX) {
        const oldest = this.lastSaved.keys().next().value;
        if (oldest === undefined) break;
        this.lastSaved.delete(oldest);
      }
    } finally {
      if (release) {
        await release().catch(() => {
          // Ignore unlock errors (file may have been deleted)
        });
      }
    }

    // Update catalog with preview for faster searchSessions — throttled to
    // saves whose preview CHANGED (the preview is the first user message; it
    // is stable for almost the whole session, so most saves skipped this I/O).
    // Runs OUTSIDE the session lock (updateCatalog has its own) to keep the
    // session critical section short, and the lock spans the catalog's whole
    // read-modify-write (review follow-up M3).
    try {
      const preview = firstUserPreview(messages);
      if (preview && this.lastPreviewWritten.get(sessionId) !== preview) {
        await this.updateCatalog((catalog) => {
          catalog[sessionId] = { ...(catalog[sessionId] ?? {}), preview };
          return true;
        });
        this.lastPreviewWritten.set(sessionId, preview);
      }
    } catch (error) {
      // Catalog update is best-effort; don't fail the save if it errors
      console.warn("session-memory: failed to update catalog preview:", error);
    }
  }

  /**
   * Migrate session data from older versions to current.
   * Applies migrations sequentially until the data is at the current version.
   */
  private migrate(data: unknown): SessionData {
    const raw = data as { version?: number };
    if (!raw.version || raw.version >= SESSION_FORMAT_VERSION) {
      return data as SessionData;
    }

    // Apply migrations sequentially
    let current = data;
    for (let v = raw.version; v < SESSION_FORMAT_VERSION; v++) {
      const migration = migrations[v];
      if (migration) {
        current = migration(current);
      } else {
        // No migration for this version — data is lost, start fresh
        throw new Error(`No migration found for session format v${v}`);
      }
    }
    return current as SessionData;
  }

  /**
   * Rename a corrupt session file aside instead of letting the next save
   * silently overwrite it (Top10 #9): the bytes are preserved for manual
   * recovery and the user is told BOTH file names. No-ops for the "{}"
   * lock placeholder and for files that are already .corrupt backups —
   * the anti-proliferation double-guard (listSessions skips backups too,
   * so nothing should ever load one, but a manual `load("<id>.corrupt-…")`
   * must not spawn a second backup either).
   */
  private async quarantineCorrupt(
    sessionId: string,
    filePath: string,
    why: string,
    raw?: string,
  ): Promise<void> {
    if (sessionId.includes(".corrupt-")) return;
    if (raw !== undefined && raw.trim() === "{}") return;
    // The sidecar catalog lives in the same directory and is NOT a session —
    // quarantining it would destroy pins/previews (listSessions also skips it
    // up front; this is the belt to that suspenders).
    if (path.basename(filePath) === "catalog.json") return;
    const backup = `${filePath.slice(0, -".json".length)}.corrupt-${Date.now()}.json`;
    try {
      await renameWithRetry(filePath, backup);
      console.warn(
        `session-memory: session file for ${sessionId} was corrupt (${why}); preserved as ${path.basename(backup)} and starting fresh.`,
      );
    } catch {
      console.warn(
        `session-memory: session file for ${sessionId} is corrupt (${why}) and could not be preserved; the next save will overwrite it.`,
      );
    }
  }

  /**
   * Load a session from disk (async).
   * Applies version migrations automatically if needed.
   */
  async load(sessionId: string): Promise<SessionData | null> {
    const filePath = this.sessionPath(sessionId);
    try {
      const raw = await fsPromises.readFile(filePath, "utf-8");
      const data = JSON.parse(raw);

      // Basic validation
      if (!data.version || !data.sessionId || !Array.isArray(data.messages)) {
        // Corrupt or non-session content (Top10 #9): quarantine instead of
        // silently returning null and letting the next save overwrite the
        // bytes. The "{}" lock placeholder is exempt inside quarantineCorrupt.
        await this.quarantineCorrupt(sessionId, filePath, "not a session object", raw);
        return null;
      }

      // Apply version migration if needed
      if (data.version < SESSION_FORMAT_VERSION) {
        try {
          return this.migrate(data);
        } catch (error) {
          // Migration failed — data is corrupt or missing migration
          console.warn(
            `session-memory: failed to migrate session ${sessionId} from v${data.version}:`,
            error,
          );
          await this.quarantineCorrupt(sessionId, filePath, "migration failed", raw);
          return null;
        }
      }

      return data as SessionData;
    } catch (error) {
      // Missing file is expected (first save / new session) — not an error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A corrupt or partially-written session file should not crash the
      // caller (e.g. a save that re-reads to preserve createdAt). Treat it as
      // "no existing session" so a fresh one is written — but FIRST preserve
      // the corrupt bytes under a .corrupt-<ts> sibling (Top10 #9: they used
      // to vanish without a trace when the next save renamed over them).
      if (error instanceof SyntaxError) {
        await this.quarantineCorrupt(sessionId, filePath, "JSON parse error");
        return null;
      }
      throw error;
    }
  }

  /**
   * List all available sessions with metadata
   */
  async listSessions(): Promise<SessionMeta[]> {
    this.ensureDir();

    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      const sessions: SessionMeta[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        // The sidecar catalog shares the directory but is not a session —
        // loading it as one would fail validation and (with the Top10 #9
        // quarantine) rename it away, destroying pins/previews.
        if (entry.name === "catalog.json") continue;
        // Quarantined corrupt backups are NOT sessions (Top10 #9
        // anti-proliferation guard: loading one would parse-fail and spawn
        // yet another backup, and the warn would fire on every listing).
        if (entry.name.includes(".corrupt-")) continue;

        const sessionId = entry.name.replace(/\.json$/, "");
        const data = await this.load(sessionId);
        if (!data) continue;

        sessions.push({
          sessionId: data.sessionId,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messageCount: data.messageCount,
          completed: data.completed,
          taskState: data.taskState,
          lastTerminalReason: data.lastTerminalReason,
          name: data.name,
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prRepository: data.prRepository,
        });
      }

      // Sort by most recently updated first
      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      return sessions;
    } catch (error) {
      // Directory missing or unreadable: surface as a warning so it isn't
      // silently lost, but still return [] so callers (e.g. --resume listing)
      // degrade gracefully instead of crashing.
      console.warn("session-memory: failed to list sessions:", error);
      return [];
    }
  }

  /**
   * Get the sessions directory path
   */
  get directory(): string {
    return this.sessionsDir;
  }
}
