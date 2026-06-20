// ============================================================
// Tests: Persistence Manager
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PersistenceManager } from "../persistence.js";
import type { Message } from "../types.js";

let tmpDir: string;
let pm: PersistenceManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-persist-"));
  pm = new PersistenceManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PersistenceManager", () => {
  it("should generate unique session IDs", () => {
    const id1 = pm.generateId();
    const id2 = pm.generateId();
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("should create sessions directory on save", async () => {
    const sessionId = pm.generateId();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    await pm.save(sessionId, messages);

    const dirPath = path.join(tmpDir, ".claude", "sessions");
    expect(fs.existsSync(dirPath)).toBe(true);

    const filePath = path.join(dirPath, `${sessionId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("should save and load messages", async () => {
    const sessionId = pm.generateId();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: "Hi there!" },
    ];

    await pm.save(sessionId, messages);
    const loaded = await pm.load(sessionId);

    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].role).toBe("user");
    expect(loaded!.messages[1].role).toBe("assistant");
    expect(loaded!.messages[1].content).toBe("Hi there!");
  });

  it("should return null for non-existent session", async () => {
    const loaded = await pm.load("nonexistent-id");
    expect(loaded).toBeNull();
  });

  it("should track session metadata", async () => {
    const sessionId = pm.generateId();
    await pm.save(sessionId, [
      { role: "user", content: [{ type: "text", text: "Test" }] },
    ]);

    const loaded = await pm.load(sessionId);
    expect(loaded!.version).toBe(1);
    expect(loaded!.sessionId).toBe(sessionId);
    expect(loaded!.createdAt).toBeTruthy();
    expect(loaded!.updatedAt).toBeTruthy();
    expect(loaded!.messageCount).toBe(1);
    expect(loaded!.completed).toBe(false);
  });

  it("should mark session as completed", async () => {
    const sessionId = pm.generateId();
    await pm.save(
      sessionId,
      [{ role: "user", content: [{ type: "text", text: "Test" }] }],
      { completed: true },
    );

    const loaded = await pm.load(sessionId);
    expect(loaded!.completed).toBe(true);
  });

  it("should update existing session on re-save", async () => {
    const sessionId = pm.generateId();

    await pm.save(sessionId, [
      { role: "user", content: [{ type: "text", text: "First" }] },
    ]);

    const first = await pm.load(sessionId);
    const firstUpdated = first!.updatedAt;

    // Wait to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));

    await pm.save(sessionId, [
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "assistant", content: "Response" },
    ]);

    const second = await pm.load(sessionId);
    expect(second!.messageCount).toBe(2);
    expect(second!.createdAt).toBe(first!.createdAt); // preserved
    expect(second!.updatedAt).not.toBe(firstUpdated); // updated
  });

  it("should list all sessions", async () => {
    const id1 = pm.generateId();
    const id2 = pm.generateId();

    await pm.save(id1, [
      { role: "user", content: [{ type: "text", text: "A" }] },
    ]);
    await pm.save(
      id2,
      [{ role: "user", content: [{ type: "text", text: "B" }] }],
      { completed: true },
    );

    const sessions = await pm.listSessions();
    expect(sessions).toHaveLength(2);

    const completed = sessions.filter((s) => s.completed);
    expect(completed).toHaveLength(1);
    expect(completed[0].sessionId).toBe(id2);
  });

  it("should delete a session", async () => {
    const sessionId = pm.generateId();
    await pm.save(sessionId, [
      { role: "user", content: [{ type: "text", text: "Delete me" }] },
    ]);

    expect(await pm.load(sessionId)).not.toBeNull();
    await pm.deleteSession(sessionId);
    expect(await pm.load(sessionId)).toBeNull();
  });

  it("should handle delete of non-existent session gracefully", async () => {
    await expect(pm.deleteSession("nonexistent")).resolves.not.toThrow();
  });

  it("should return empty list when no sessions exist", async () => {
    const sessions = await pm.listSessions();
    expect(sessions).toEqual([]);
  });

  it("should expose the sessions directory path", () => {
    expect(pm.directory).toBe(path.join(tmpDir, ".claude", "sessions"));
  });
});
