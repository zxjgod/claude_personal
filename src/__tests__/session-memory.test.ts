// ============================================================
// Tests: SessionMemory (M19.1)
// ============================================================
// Mirrors the persistence behavior on the relocated class to ensure the
// message+metadata store keeps its byte-for-byte contract.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceManager } from "../persistence.js";
import { SessionMemory } from "../session-memory.js";
import type { Message } from "../types.js";

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

  it("degrades to null on a corrupt file", async () => {
    const id = sm.generateId();
    await sm.save(id, [{ role: "user", content: [{ type: "text", text: "ok" }] }]);
    const filePath = path.join(tmpDir, ".claude", "sessions", `${id}.json`);
    fs.writeFileSync(filePath, "{ not json", "utf-8");
    expect(await sm.load(id)).toBeNull();
  });

  it("PersistenceManager is a SessionMemory (backward-compatible)", async () => {
    const pm = new PersistenceManager(tmpDir);
    expect(pm).toBeInstanceOf(SessionMemory);
    const id = pm.generateId();
    await pm.save(id, [{ role: "user", content: [{ type: "text", text: "compat" }] }]);
    const loaded = await pm.load(id);
    expect(loaded!.messageCount).toBe(1);
  });
});
