// ============================================================
// Tests: SessionMemory (M19.1)
// ============================================================
// Mirrors the persistence behavior on the relocated class to ensure the
// message+metadata store keeps its byte-for-byte contract.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearCheckpointMemoryForTests,
  beginUserTurn,
  shadowBeforeWrite,
} from "../checkpoint.js";
import { PersistenceManager } from "../persistence.js";
import { SessionMemory } from "../session-memory.js";
import { createRun, saveRun } from "../subagent-store.js";
import type { Message } from "../types.js";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantMsg(text: string): Message {
  return { role: "assistant", content: text };
}
function sessionsDirOf(root: string): string {
  return path.join(root, ".claude", "sessions");
}

let tmpDir: string;
let sm: SessionMemory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sessmem-"));
  sm = new SessionMemory(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionMemory", () => {
  it("saves and loads messages round-trip", async () => {
    const id = sm.generateId();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: "Hi" },
    ];
    await sm.save(id, messages);
    const loaded = await sm.load(id);
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messageCount).toBe(2);
  });

  it("preserves createdAt across re-saves", async () => {
    const id = sm.generateId();
    await sm.save(id, [{ role: "user", content: [{ type: "text", text: "a" }] }]);
    const first = await sm.load(id);
    await new Promise((r) => setTimeout(r, 5));
    await sm.save(id, [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: "b" },
    ]);
    const second = await sm.load(id);
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.messageCount).toBe(2);
  });

  it("lists and deletes sessions", async () => {
    const id = sm.generateId();
    await sm.save(id, [{ role: "user", content: [{ type: "text", text: "x" }] }]);
    expect((await sm.listSessions()).length).toBe(1);
    await sm.deleteSession(id);
    expect(await sm.load(id)).toBeNull();
  });

  // 拍板 #19: sub-agent run records are full transcripts under
  // sessions/subagents-<id>/. deleteRuns() had no caller at all, so they
  // outlived every deleted session and grew without bound.
  it("deleting a session also removes its sub-agent run records", async () => {
    const id = sm.generateId();
    await sm.save(id, [{ role: "user", content: [{ type: "text", text: "x" }] }]);
    const run = createRun(tmpDir, id, "general", "d", "p");
    saveRun(tmpDir, run);
    const runsDir = path.join(sessionsDirOf(tmpDir), `subagents-${id}`);
    expect(fs.existsSync(runsDir)).toBe(true);
    await sm.deleteSession(id);
    expect(fs.existsSync(runsDir)).toBe(false);
  });

  // Top10 #9: a corrupt file used to load as null WITHOUT a trace, and the
  // next save silently renamed a fresh session over the bytes. Now the corrupt
  // file is quarantined to <id>.corrupt-<ts>.json with a warning, and the
  // backup never re-enters the session lifecycle.
  it("quarantines a corrupt file instead of silently overwriting it", async () => {
    const id = sm.generateId();
    await sm.save(id, [userMsg("ok")]);
    const dir = sessionsDirOf(tmpDir);
    const filePath = path.join(dir, `${id}.json`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fs.writeFileSync(filePath, "{ not json", "utf-8");
      expect(await sm.load(id)).toBeNull();
      // Bytes preserved under a .corrupt-<ts> sibling; original name freed.
      const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(new RegExp(`^${id}\\.corrupt-\\d+\\.json$`));
      expect(fs.readFileSync(path.join(dir, backups[0]!), "utf-8")).toBe("{ not json");
      expect(fs.existsSync(filePath)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();

      // The backup is not a session: listSessions skips it, and a second
      // load neither proliferates backups nor warns again about it.
      const listed = await sm.listSessions();
      expect(listed.some((s) => s.sessionId.includes(".corrupt-"))).toBe(false);
      expect(await sm.load(id)).toBeNull();
      expect(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toHaveLength(1);

      // The next save starts fresh; the backup is left alone.
      await sm.save(id, [userMsg("fresh")]);
      const loaded = await sm.load(id);
      expect(loaded!.messageCount).toBe(1);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the {} lock placeholder loads as null and is never quarantined", async () => {
    const id = sm.generateId();
    const dir = sessionsDirOf(tmpDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), "{}", "utf-8");
    expect(await sm.load(id)).toBeNull();
    expect(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
    // The placeholder file itself stays put for the lockfile machinery.
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(true);
  });

  it("loading an existing .corrupt backup never spawns a second backup", async () => {
    const id = sm.generateId();
    const dir = sessionsDirOf(tmpDir);
    fs.mkdirSync(dir, { recursive: true });
    const backupId = `${id}.corrupt-123`;
    fs.writeFileSync(path.join(dir, `${backupId}.json`), "{ broken", "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sm.load(backupId)).toBeNull();
      expect(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("two instances saving the same session concurrently leave an intact file", async () => {
    const id = sm.generateId();
    const a = new SessionMemory(tmpDir);
    const b = new SessionMemory(tmpDir);
    // Interleaved saves from two "processes" (two instances, one file):
    // the cross-process lock must serialize them — no torn JSON, no lost
    // final state, no lock/tmp residue.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? a.save(id, [userMsg(`a${i}`)])
          : b.save(id, [userMsg(`b${i}`)], { taskState: "paused" }),
      ),
    );
    const loaded = await new SessionMemory(tmpDir).load(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(id);
    expect(loaded!.messageCount).toBe(1);
    // The final state is ONE intact write from either chain — never a torn or
    // mixed file. (Which write wins is not deterministic: saves serialize on
    // the lock, and under exhaustion a save SKIPS with a warning rather than
    // rejecting — review follow-up H1 — so the winner may be an earlier one.)
    const finalText = (loaded!.messages[0] as { content: Array<{ text?: string }> }).content[0]
      ?.text;
    expect(finalText).toMatch(/^[ab](\d|1\d)$/);
    const dir = sessionsDirOf(tmpDir);
    expect(fs.existsSync(path.join(dir, `${id}.json.lock`))).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 30_000);

  it("detects cross-process divergence instead of trusting its stale cache", async () => {
    const id = sm.generateId();
    const other = new SessionMemory(tmpDir); // stands in for a second process
    await sm.save(id, [userMsg("a")]);
    const createdAt = (await sm.load(id))!.createdAt;
    // The other instance writes behind our back → our lastSaved cache is stale.
    await other.save(id, [userMsg("a"), assistantMsg("b")]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sm.save(id, [userMsg("a"), assistantMsg("b"), userMsg("c")]);
      // Divergence surfaced once...
      const warned = warnSpy.mock.calls.some((c) => String(c[0]).includes("another process"));
      expect(warned).toBe(true);
      // ...and this save's messages won, with the ORIGINAL createdAt
      // preserved (base re-read from disk, not from the stale cache).
      const loaded = await sm.load(id);
      expect(loaded!.messageCount).toBe(3);
      expect(loaded!.createdAt).toBe(createdAt);
      // A subsequent in-line save does not re-warn (once per session).
      warnSpy.mockClear();
      await sm.save(id, [userMsg("a"), assistantMsg("b"), userMsg("c"), assistantMsg("d")]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("another process"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("tracks pinned sessions in a sidecar catalog", async () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    await sm.save(first, [{ role: "user", content: [{ type: "text", text: "old task" }] }]);
    await new Promise((r) => setTimeout(r, 8));
    await sm.save(second, [{ role: "user", content: [{ type: "text", text: "new needle task" }] }]);

    await sm.setPinned(first, true);
    const all = await sm.searchSessions("");
    expect(all[0]!.sessionId).toBe(first);
    expect(all[0]!.pinned).toBe(true);
    expect(all[0]!.preview).toBe("old task");

    const found = await sm.searchSessions("needle");
    expect(found.map((s) => s.sessionId)).toEqual([second]);

    await sm.deleteSession(first);
    expect(await sm.isPinned(first)).toBe(false);
  });
  it("PersistenceManager is a SessionMemory (backward-compatible)", async () => {
    const pm = new PersistenceManager(tmpDir);
    expect(pm).toBeInstanceOf(SessionMemory);
    const id = pm.generateId();
    await pm.save(id, [{ role: "user", content: [{ type: "text", text: "compat" }] }]);
    const loaded = await pm.load(id);
    expect(loaded!.messageCount).toBe(1);
  });

  // Review follow-up H1: a save that cannot get the cross-process lock must
  // SKIP with a warning, never reject — the REPL's fire-and-forget save sites
  // would turn a rejection into an unhandledRejection → process.exit(1),
  // i.e. losing lock contention would KILL the second terminal.
  it("skips the save with a warning instead of rejecting when the lock is held elsewhere", async () => {
    const id = sm.generateId();
    await sm.save(id, [userMsg("v1")]);
    const filePath = path.join(sessionsDirOf(tmpDir), `${id}.json`);
    // Simulate another process holding the lock longer than the retry budget.
    const release = await lockfile.lock(filePath, { stale: 10_000 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(sm.save(id, [userMsg("v1"), assistantMsg("v2")])).resolves.toBeUndefined();
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("cross-process lock"))).toBe(
        true,
      );
      // The file still holds the PREVIOUS content — the save was skipped,
      // not half-applied.
      const loaded = await new SessionMemory(tmpDir).load(id);
      expect(loaded!.messageCount).toBe(1);
    } finally {
      warnSpy.mockRestore();
      await release();
    }
    // Once the external lock is gone, saving works again.
    await sm.save(id, [userMsg("v1"), assistantMsg("v2")]);
    const after = await new SessionMemory(tmpDir).load(id);
    expect(after!.messageCount).toBe(2);
  }, 30_000);

  it("quarantines a session whose version migration fails", async () => {
    const id = sm.generateId();
    const dir = sessionsDirOf(tmpDir);
    fs.mkdirSync(dir, { recursive: true });
    // Parseable JSON, a v2 session shape, but messageCount is invalid → the
    // v2→v3 migration throws. The bytes must be preserved, not overwritten.
    const nowIso = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        version: 2,
        sessionId: id,
        createdAt: nowIso,
        updatedAt: nowIso,
        messages: [],
        messageCount: "not-a-number",
      }),
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sm.load(id)).toBeNull();
      const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
      expect(backups).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Review follow-up M3: the catalog read-modify-write used to hold the lock
  // only around the WRITE — two concurrent pin operations both read the old
  // state and the later writer silently dropped the earlier one's pin.
  it("concurrent pins from two instances both survive (catalog RMW under lock)", async () => {
    const idA = sm.generateId();
    const idB = sm.generateId();
    await sm.save(idA, [userMsg("a")]);
    await sm.save(idB, [userMsg("b")]);
    const other = new SessionMemory(tmpDir);
    await Promise.all([sm.setPinned(idA, true), other.setPinned(idB, true)]);
    expect(await sm.isPinned(idA)).toBe(true);
    expect(await sm.isPinned(idB)).toBe(true);
  }, 30_000);

  // Review follow-up M4: deleteSession used to unlink immediately, outside
  // the save chain — a save already queued behind it would rename the file
  // back into existence AFTER the delete, resurrecting an orphan session
  // (catalog entry already cleaned).
  it("a save queued before deleteSession cannot resurrect the session", async () => {
    const id = sm.generateId();
    await sm.save(id, [userMsg("a")]);
    const pending = sm.save(id, [userMsg("a"), assistantMsg("b")]); // queued on the chain
    const del = sm.deleteSession(id); // chained AFTER the pending save
    await Promise.all([pending, del]);
    expect(fs.existsSync(path.join(sessionsDirOf(tmpDir), `${id}.json`))).toBe(false);
    expect(await new SessionMemory(tmpDir).load(id)).toBeNull();
  }, 30_000);

  // Fourth-round review: the session's checkpoint bucket (.claude/checkpoints/
  // <bucket>/ with every shadowed-file blob) used to survive deletion forever —
  // the 64MB cap only bounds RAM and gcBlobs only fires on rewind.
  it("deleteSession removes the session's checkpoint bucket too", async () => {
    vi.stubEnv("WORKSPACE_ROOT", tmpDir); // checkpoint root resolves like production
    try {
      const file = path.join(tmpDir, "c.txt");
      fs.writeFileSync(file, "x");
      beginUserTurn("ckpt-del");
      shadowBeforeWrite("ckpt-del", file); // creates the bucket + a blob
      const bucket = path.join(tmpDir, ".claude", "checkpoints", "ckpt-del");
      expect(fs.existsSync(bucket)).toBe(true);
      await sm.save("ckpt-del", [userMsg("hi")]);
      await sm.deleteSession("ckpt-del");
      expect(fs.existsSync(bucket)).toBe(false);
    } finally {
      __clearCheckpointMemoryForTests();
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
