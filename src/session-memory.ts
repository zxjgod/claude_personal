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
// ============================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "./types.js";

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

  private saveSerialized(
    sessionId: string,
    messages: Message[],
    options: { completed?: boolean } | undefined,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ensureDir();

        const filePath = this.sessionPath(sessionId);
        const now = new Date().toISOString();

        let data: SessionData;

        // Try to load existing session to preserve createdAt
        const existing = this.loadSync(sessionId);
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
            version: 1,
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

        // Atomic write: temp file + rename. A direct writeFileSync can leave a
        // truncated file if the process is killed (Ctrl+C / OOM) mid-write;
        // rename is atomic on the same filesystem, so readers always see either
        // the old or the new complete file, never a partial one.
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, json, "utf-8");
        fs.renameSync(tmpPath, filePath);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Load a session from disk (async)
   */
  async load(sessionId: string): Promise<SessionData | null> {
    return this.loadSync(sessionId);
  }

  /**
   * Load a session synchronously
   */
  private loadSync(sessionId: string): SessionData | null {
    const filePath = this.sessionPath(sessionId);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data: SessionData = JSON.parse(raw);

      // Basic validation
      if (!data.version || !data.sessionId || !Array.isArray(data.messages)) {
        return null;
      }

      return data;
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
        const data = this.loadSync(sessionId);
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
