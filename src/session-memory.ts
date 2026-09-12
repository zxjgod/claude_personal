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
import { firstUserPreview } from "./tui/history-replay.js";
import type { Message } from "./types.js";
import { ccrPath } from "./workspace-config.js";

// --- Format Version ---

/** Current session format version. Increment when the schema changes. */
export const SESSION_FORMAT_VERSION = 3;

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
}

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  completed: boolean;
  taskState: TaskState;
  lastTerminalReason?: string;
}

export interface SessionCatalogEntry extends SessionMeta {
  pinned: boolean;
  preview: string;
}

// --- Session memory store ---

export class SessionMemory {
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

  constructor(workspaceRoot: string) {
    this.sessionsDir = ccrPath(workspaceRoot, "sessions");
  }

  /**
   * Ensure the sessions directory exists
   */
  private ensureDir(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  /**
   * Get the file path for a session
   */
  private sessionPath(sessionId: string): string {
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

  private async writeCatalog(
    catalog: Record<string, { pinned?: boolean; preview?: string }>,
  ): Promise<void> {
    this.ensureDir();
    const filePath = this.catalogPath();
    const tmpPath = `${filePath}.tmp`;

    // Use file lock to prevent concurrent writes
    let release: (() => Promise<void>) | undefined;
    try {
      // Create catalog file if it doesn't exist (lockfile needs the file to exist)
      if (!fs.existsSync(filePath)) {
        await fsPromises.writeFile(filePath, "{}", "utf-8");
      }

      release = await lockfile.lock(filePath, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
        stale: 10000, // 10 seconds
      });

      await fsPromises.writeFile(tmpPath, JSON.stringify(catalog, null, 2), "utf-8");
      await fsPromises.rename(tmpPath, filePath);
    } finally {
      if (release) {
        await release().catch(() => {
          // Ignore unlock errors (file may have been deleted)
        });
      }
    }
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const catalog = await this.readCatalog();
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
    await this.writeCatalog(catalog);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const filePath = this.sessionPath(sessionId);
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const catalog = await this.readCatalog();
    if (catalog[sessionId]) {
      delete catalog[sessionId];
      await this.writeCatalog(catalog);
    }
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
  async save(
    sessionId: string,
    messages: Message[],
    options?: { completed?: boolean; taskState?: TaskState; lastTerminalReason?: string },
  ): Promise<void> {
    // Chain onto the tail of any in-flight save. Each link captures its own
    // sessionId/messages snapshot, so the serialized writes stay independent.
    const next = this.saveChain.then(() => this.saveSerialized(sessionId, messages, options));
    // Swallow rejection on the chain itself so a failing save doesn't poison
    // subsequent ones; the caller still sees the rejection via `next`.
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  private async saveSerialized(
    sessionId: string,
    messages: Message[],
    options:
      | { completed?: boolean; taskState?: TaskState; lastTerminalReason?: string }
      | undefined,
  ): Promise<void> {
    this.ensureDir();

    const filePath = this.sessionPath(sessionId);
    const now = new Date().toISOString();

    let data: SessionData;

    // Try to load existing session to preserve createdAt
    const existing = await this.load(sessionId);
    if (existing) {
      data = {
        ...existing,
        updatedAt: now,
        messages,
        messageCount: messages.length,
        completed: options?.completed ?? existing.completed,
        taskState: options?.taskState ?? existing.taskState,
        lastTerminalReason: options?.lastTerminalReason ?? existing.lastTerminalReason,
      };
    } else {
      data = {
        version: SESSION_FORMAT_VERSION,
        sessionId,
        createdAt: now,
        updatedAt: now,
        workspaceRoot: path.dirname(this.sessionsDir),
        messages,
        messageCount: messages.length,
        completed: options?.completed ?? false,
        taskState: options?.taskState ?? "paused",
        lastTerminalReason: options?.lastTerminalReason,
      };
    }

    const json = JSON.stringify(data, null, 2);

    // Atomic write: temp file + rename. A direct writeFile can leave a
    // truncated file if the process is killed (Ctrl+C / OOM) mid-write;
    // rename is atomic on the same filesystem, so readers always see either
    // the old or the new complete file, never a partial one.
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, json, "utf-8");
    await fsPromises.rename(tmpPath, filePath);

    // Update catalog with preview for faster searchSessions
    try {
      const preview = firstUserPreview(messages);
      if (preview) {
        const catalog = await this.readCatalog();
        catalog[sessionId] = { ...(catalog[sessionId] ?? {}), preview };
        await this.writeCatalog(catalog);
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
          return null;
        }
      }

      return data as SessionData;
    } catch (error) {
      // Missing file is expected (first save / new session) — not an error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A corrupt or partially-written session file should not crash the
      // caller (e.g. a save that re-reads to preserve createdAt). Treat it as
      // "no existing session" so a fresh one is written instead of throwing.
      if (error instanceof SyntaxError) return null;
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
