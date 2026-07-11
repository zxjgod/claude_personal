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
// ============================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Message } from "./types.js";

// --- Format Version ---

/** Current session format version. Increment when the schema changes. */
export const SESSION_FORMAT_VERSION = 2;

/** Version migration map: old version → migration function */
type MigrationFn = (data: unknown) => SessionData;

const migrations: Record<number, MigrationFn> = {
  // v1 → v2: Add workspaceRoot, messageCount, completed fields
  1: (data: unknown) => {
    const d = data as {
      version: number;
      sessionId: string;
      createdAt: string;
      updatedAt: string;
      messages: Message[];
    };
    return {
      version: SESSION_FORMAT_VERSION,
      sessionId: d.sessionId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      workspaceRoot: "",
      messages: d.messages,
      messageCount: d.messages.length,
      completed: false,
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
}

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  completed: boolean;
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
    this.sessionsDir = path.join(workspaceRoot, ".claude", "sessions");
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
    options?: { completed?: boolean },
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
    options: { completed?: boolean } | undefined,
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
    } catch (error: any) {
      // Missing file is expected (first save / new session) — not an error.
      if (error.code === "ENOENT") return null;
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
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const filePath = this.sessionPath(sessionId);
    try {
      fs.unlinkSync(filePath);
    } catch (error: any) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }

  /**
   * Get the sessions directory path
   */
  get directory(): string {
    return this.sessionsDir;
  }
}
