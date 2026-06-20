// ============================================================
// Persistence — Save and restore conversation sessions
// ============================================================
// Stores conversation history as JSON files under
// <workspace>/.claude/sessions/<sessionId>.json
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
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

// --- Persistence Manager ---

export class PersistenceManager {
  private sessionsDir: string;

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
   * Save a session to disk
   */
  async save(
    sessionId: string,
    messages: Message[],
    options?: { completed?: boolean },
  ): Promise<void> {
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
    fs.writeFileSync(filePath, json, "utf-8");
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
      if (error.code === "ENOENT") return null;
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
      sessions.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );

      return sessions;
    } catch {
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
