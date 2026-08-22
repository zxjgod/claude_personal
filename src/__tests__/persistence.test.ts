// ============================================================
// Tests: Persistence Manager
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceManager } from "../persistence.js";
import { SESSION_FORMAT_VERSION } from "../session-memory.js";
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
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];

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
    await pm.save(sessionId, [{ role: "user", content: [{ type: "text", text: "Test" }] }]);

    const loaded = await pm.load(sessionId);
    expect(loaded!.version).toBe(SESSION_FORMAT_VERSION);
    expect(loaded!.sessionId).toBe(sessionId);
    expect(loaded!.createdAt).toBeTruthy();
    expect(loaded!.updatedAt).toBeTruthy();
    expect(loaded!.messageCount).toBe(1);
    expect(loaded!.completed).toBe(false);
  });

  it("should mark session as completed", async () => {
    const sessionId = pm.generateId();
    await pm.save(sessionId, [{ role: "user", content: [{ type: "text", text: "Test" }] }], {
      completed: true,
    });

    const loaded = await pm.load(sessionId);
    expect(loaded!.completed).toBe(true);
  });

  it("persists runtime state without claiming business completion", async () => {
    const sessionId = pm.generateId();
    await pm.save(
      sessionId,
      [{ role: "user", content: [{ type: "text", text: "Continue work" }] }],
      { taskState: "waiting_for_tool" },
    );

    const loaded = await pm.load(sessionId);
    expect(loaded!.taskState).toBe("waiting_for_tool");
    expect(loaded!.completed).toBe(false);
  });

  it("migrates legacy v2 sessions to a resumable paused state", async () => {
    const sessionId = pm.generateId();
    const sessionsDir = path.join(tmpDir, ".claude", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        version: 2,
        sessionId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        workspaceRoot: tmpDir,
        messages: [{ role: "user", content: [{ type: "text", text: "Resume me" }] }],
        messageCount: 1,
        completed: true,
      }),
      "utf-8",
    );

    const loaded = await pm.load(sessionId);
    expect(loaded!.version).toBe(SESSION_FORMAT_VERSION);
    expect(loaded!.taskState).toBe("paused");
    expect(loaded!.completed).toBe(true);
  });

  it("should update existing session on re-save", async () => {
    const sessionId = pm.generateId();

    await pm.save(sessionId, [{ role: "user", content: [{ type: "text", text: "First" }] }]);

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

    await pm.save(id1, [{ role: "user", content: [{ type: "text", text: "A" }] }]);
    await pm.save(id2, [{ role: "user", content: [{ type: "text", text: "B" }] }], {
      completed: true,
    });

    const sessions = await pm.listSessions();
    expect(sessions).toHaveLength(2);

    const completed = sessions.filter((s) => s.completed);
    expect(completed).toHaveLength(1);
    expect(completed[0].sessionId).toBe(id2);
  });

  it("should delete a session", async () => {
    const sessionId = pm.generateId();
    await pm.save(sessionId, [{ role: "user", content: [{ type: "text", text: "Delete me" }] }]);

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

  // ------------------------------------------------------------------
  // Stability hardening: atomic write + concurrent save serialization
  // ------------------------------------------------------------------

  it("serializes concurrent saves so the final state is the latest (no clobber)", async () => {
    const sessionId = pm.generateId();

    // Fire many concurrent saves against the same session, each with a
    // different message count. The saveChain must serialize the
    // read-modify-write so the final on-disk messageCount equals the largest,
    // not whatever happened to win the race.
    const saves: Promise<void>[] = [];
    for (let i = 1; i <= 20; i++) {
      const msgs: Message[] = Array.from(
        { length: i },
        (_, k) => ({ role: "user", content: [{ type: "text", text: `m${k}` }] }) as Message,
      );
      saves.push(pm.save(sessionId, msgs));
    }
    await Promise.all(saves);

    const loaded = await pm.load(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messageCount).toBe(20);
  });

  it("recovers from a corrupt session file (no crash, returns null)", async () => {
    const sessionId = pm.generateId();
    await pm.save(sessionId, [{ role: "user", content: [{ type: "text", text: "good" }] }]);

    // Corrupt the file on disk to simulate a truncated/partial write.
    const filePath = path.join(tmpDir, ".claude", "sessions", `${sessionId}.json`);
    fs.writeFileSync(filePath, "{ this is not valid json", "utf-8");

    // loadSync (via load) must NOT throw on a SyntaxError — it degrades to null.
    const loaded = await pm.load(sessionId);
    expect(loaded).toBeNull();

    // And a subsequent save must succeed (treats corrupt file as "no existing
    // session" and writes a fresh one), preserving the original sessionId.
    await pm.save(sessionId, [{ role: "user", content: [{ type: "text", text: "recovered" }] }]);
    const recovered = await pm.load(sessionId);
    expect(recovered).not.toBeNull();
    expect(recovered!.messageCount).toBe(1);
  });

  it("leaves no temp file behind after a successful save (atomic rename)", async () => {
    const sessionId = pm.generateId();
    await pm.save(sessionId, [{ role: "user", content: [{ type: "text", text: "atomic" }] }]);

    const dirPath = path.join(tmpDir, ".claude", "sessions");
    const leftovers = fs.readdirSync(dirPath).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
