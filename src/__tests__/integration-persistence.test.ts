// ============================================================
// Integration tests: persistence + transcript + memory (M21.3)
// ============================================================
// The unit suites prove each store in isolation. This suite wires the three
// session subsystems together the way a real run does, and across a simulated
// process restart:
//   - SessionMemory: the resumable Message[] snapshot.
//   - SessionTranscript: the append-only event log (audit / recap).
//   - MemoryStore + extractMemoriesHeuristic: durable cross-session notes.
//
// Focus areas the unit tests don't cover:
//   - multi-session isolation within one workspace, and across workspaces;
//   - resume after "restart" (a fresh set of store instances over the same dir);
//   - the snapshot ↔ transcript ↔ memory files coexisting under .claude/;
//   - replaying a saved conversation back into TUI transcript items.
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileChange } from "../change-tracker.js";
import { extractMemoriesHeuristic, MemoryStore } from "../memory-extract.js";
import { SessionMemory } from "../session-memory.js";
import { messagesToTranscript } from "../tui/history-replay.js";
import { SessionTranscript } from "../tui/session-transcript.js";
import type { Message, ToolCall } from "../types.js";

let ws: string;

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(text: string, toolCalls?: ToolCall[]): Message {
  return { role: "assistant", content: text, tool_calls: toolCalls };
}
function change(p: string, kind: FileChange["kind"]): FileChange {
  return { path: p, kind, edits: 1, updatedAt: 0 };
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-int-persist-"));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

// ============================================================
// Multi-session isolation
// ============================================================

describe("Multi-session isolation", () => {
  it("keeps two sessions' messages independent in one workspace", async () => {
    const sm = new SessionMemory(ws);
    const a = sm.generateId();
    const b = sm.generateId();
    await sm.save(a, [userMsg("session A only")]);
    await sm.save(b, [userMsg("session B q1"), asstMsg("B a1"), userMsg("B q2")]);

    const la = await sm.load(a);
    const lb = await sm.load(b);
    expect(la!.messages).toHaveLength(1);
    expect(lb!.messages).toHaveLength(3);
    expect((la!.messages[0] as any).content[0].text).toBe("session A only");
    expect(la!.sessionId).not.toBe(lb!.sessionId);
  });

  it("lists every session, most-recently-updated first", async () => {
    const sm = new SessionMemory(ws);
    const first = sm.generateId();
    const second = sm.generateId();
    await sm.save(first, [userMsg("1")]);
    await new Promise((r) => setTimeout(r, 8));
    await sm.save(second, [userMsg("2")]);
    const list = await sm.listSessions();
    expect(list).toHaveLength(2);
    expect(list[0]!.sessionId).toBe(second); // newest first
  });

  it("deleting one session leaves the others intact", async () => {
    const sm = new SessionMemory(ws);
    const keep = sm.generateId();
    const drop = sm.generateId();
    await sm.save(keep, [userMsg("keep")]);
    await sm.save(drop, [userMsg("drop")]);
    await sm.deleteSession(drop);
    expect(await sm.load(drop)).toBeNull();
    expect(await sm.load(keep)).not.toBeNull();
    expect(await sm.listSessions()).toHaveLength(1);
  });

  it("two stores over the SAME workspace see each other's sessions", async () => {
    const writer = new SessionMemory(ws);
    const id = writer.generateId();
    await writer.save(id, [userMsg("shared")]);
    // A second store rooted at the same workspace reads the same dir.
    const reader = new SessionMemory(ws);
    expect((await reader.listSessions()).map((s) => s.sessionId)).toContain(id);
    expect(await reader.load(id)).not.toBeNull();
  });

  it("two stores over DIFFERENT workspaces are isolated", async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-int-persist2-"));
    try {
      const sm1 = new SessionMemory(ws);
      const sm2 = new SessionMemory(ws2);
      const id = sm1.generateId();
      await sm1.save(id, [userMsg("in ws1")]);
      expect(await sm2.load(id)).toBeNull();
      expect(await sm2.listSessions()).toHaveLength(0);
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Resume after a simulated restart
// ============================================================

describe("Resume across a simulated restart", () => {
  it("a fresh store instance reloads the saved snapshot and preserves createdAt", async () => {
    const before = new SessionMemory(ws);
    const id = before.generateId();
    await before.save(id, [userMsg("q1"), asstMsg("a1")]);
    const original = await before.load(id);

    // "Restart": brand-new instance over the same dir.
    const after = new SessionMemory(ws);
    const resumed = await after.load(id);
    expect(resumed).not.toBeNull();
    expect(resumed!.messages).toHaveLength(2);
    expect(resumed!.createdAt).toBe(original!.createdAt);

    // Continuing the session preserves createdAt while bumping updatedAt.
    await new Promise((r) => setTimeout(r, 6));
    await after.save(id, [userMsg("q1"), asstMsg("a1"), userMsg("q2")]);
    const continued = await after.load(id);
    expect(continued!.createdAt).toBe(original!.createdAt);
    expect(continued!.messageCount).toBe(3);
    expect(continued!.updatedAt).not.toBe(original!.updatedAt);
  });

  it("the completed flag survives a restart", async () => {
    const sm = new SessionMemory(ws);
    const id = sm.generateId();
    await sm.save(id, [userMsg("done")], { completed: true });
    const reopened = await new SessionMemory(ws).load(id);
    expect(reopened!.completed).toBe(true);
  });

  it("replays a resumed multi-turn conversation into transcript items", async () => {
    const sm = new SessionMemory(ws);
    const id = sm.generateId();
    const convo: Message[] = [
      userMsg("read the file"),
      asstMsg("Reading it now.", [
        {
          id: "tc1",
          type: "function",
          function: { name: "read", arguments: '{"filePath":"a.ts"}' },
        },
      ]),
      { role: "tool", tool_call_id: "tc1", content: "file contents here" },
      asstMsg("Here is what I found."),
    ];
    await sm.save(id, convo);

    // Resume: load snapshot, fold into the TUI transcript representation.
    const resumed = await new SessionMemory(ws).load(id);
    const items = messagesToTranscript(resumed!.messages);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "assistant", "tool", "assistant"]);
    // The tool result is inlined onto the tool_call (role:"tool" not re-emitted).
    const toolItem = items.find((i) => i.kind === "tool") as any;
    expect(toolItem.detail).toBe("a.ts");
    expect(toolItem.result.formatted).toBe("file contents here");
  });
});

// ============================================================
// Transcript event log alongside the snapshot
// ============================================================

describe("SessionTranscript event log", () => {
  it("records events in order with monotonic seq numbers", async () => {
    const t = new SessionTranscript(ws);
    const id = "sess-t1";
    await t.append(id, { type: "user_prompt", text: "hello" });
    await t.append(id, { type: "tool_use", id: "x1", name: "read", input: { filePath: "a" } });
    await t.append(id, { type: "tool_result", name: "read", preview: "ok", durationMs: 3 });
    await t.append(id, { type: "usage", input: 100, output: 20 });
    await t.append(id, { type: "done", finishReason: "stop", turns: 1 });

    const entries = t.read(id);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(entries.map((e) => e.type)).toEqual([
      "user_prompt",
      "tool_use",
      "tool_result",
      "usage",
      "done",
    ]);
  });

  it("folds the log into a recap summary", async () => {
    const t = new SessionTranscript(ws);
    const id = "sess-t2";
    await t.append(id, { type: "user_prompt", text: "p1" });
    await t.append(id, { type: "user_prompt", text: "p2" });
    await t.append(id, { type: "tool_use", id: "1", name: "edit", input: {} });
    await t.append(id, { type: "tool_use", id: "2", name: "edit", input: {} });
    await t.append(id, { type: "tool_use", id: "3", name: "bash", input: {} });
    await t.append(id, { type: "usage", input: 10, output: 5, cacheRead: 2 });
    await t.append(id, { type: "usage", input: 7, output: 3 });
    await t.append(id, { type: "done", finishReason: "stop", turns: 2 });

    const r = t.replay(id);
    expect(r.prompts).toBe(2);
    expect(r.toolCalls).toBe(3);
    expect(r.toolCounts).toEqual({ edit: 2, bash: 1 });
    expect(r.totalUsage.input).toBe(17);
    expect(r.totalUsage.output).toBe(8);
    expect(r.totalUsage.cacheRead).toBe(2);
    expect(r.turns).toBe(2);
  });

  it("tolerates a corrupt tail line written after a crash", async () => {
    const t = new SessionTranscript(ws);
    const id = "sess-t3";
    await t.append(id, { type: "user_prompt", text: "intact" });
    // Simulate a partial final line from a kill mid-write.
    const file = path.join(ws, ".claude", "sessions", `${id}.transcript.jsonl`);
    fs.appendFileSync(file, '{"seq":1,"type":"user_pro', "utf-8");
    const entries = t.read(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("user_prompt");
  });

  it("isolates transcripts per session", async () => {
    const t = new SessionTranscript(ws);
    await t.append("alpha", { type: "user_prompt", text: "A" });
    await t.append("beta", { type: "user_prompt", text: "B1" });
    await t.append("beta", { type: "user_prompt", text: "B2" });
    expect(t.read("alpha")).toHaveLength(1);
    expect(t.read("beta")).toHaveLength(2);
    // Each session's seq counter is independent.
    expect(t.read("beta").map((e) => e.seq)).toEqual([0, 1]);
  });

  it("snapshot and transcript coexist as distinct files under .claude/sessions", async () => {
    const id = "sess-coexist";
    await new SessionMemory(ws).save(id, [userMsg("x")]);
    await new SessionTranscript(ws).append(id, { type: "user_prompt", text: "x" });
    const dir = path.join(ws, ".claude", "sessions");
    const files = fs.readdirSync(dir).sort();
    expect(files).toContain(`${id}.json`);
    expect(files).toContain(`${id}.transcript.jsonl`);
  });

  it("returns an empty summary for a session with no transcript", () => {
    const r = new SessionTranscript(ws).replay("never-existed");
    expect(r).toEqual({
      prompts: 0,
      toolCalls: 0,
      turns: 0,
      totalUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      toolCounts: {},
    });
  });
});

// ============================================================
// Durable memory extraction + store
// ============================================================

describe("Memory extraction → store", () => {
  it("extracts durable-intent lines from a conversation and persists them deduped", () => {
    const messages: Message[] = [
      userMsg("Always run the linter before committing."),
      asstMsg("Understood."),
      userMsg("prefer tabs over spaces in this repo"),
      userMsg("just a normal question with no durable intent"),
    ];
    const extracted = extractMemoriesHeuristic(messages);
    expect(extracted.length).toBe(2);
    expect(extracted.every((m) => m.source === "heuristic")).toBe(true);

    const store = new MemoryStore(ws);
    const written = store.append(extracted);
    expect(written).toHaveLength(2);
    // A second append of the same memories is a no-op (dedupe by normalized text).
    expect(store.append(extracted)).toHaveLength(0);
    expect(store.list()).toHaveLength(2);
  });

  it("summarizes files changed this session into a memory", () => {
    const out = extractMemoriesHeuristic(
      [userMsg("hi")],
      [change("src/a.ts", "created"), change("src/b.ts", "modified")],
    );
    const changeNote = out.find((m) => m.tags?.includes("changes"));
    expect(changeNote).toBeDefined();
    expect(changeNote!.text).toContain("+src/a.ts");
    expect(changeNote!.text).toContain("~src/b.ts");
  });

  it("MemoryStore persists across instances and tolerates a corrupt line", () => {
    const id = "manual note worth keeping";
    new MemoryStore(ws).append([{ source: "manual", text: id }]);
    // Append a junk line directly, as a crash might.
    fs.appendFileSync(path.join(ws, ".claude", "memories.jsonl"), "{ not json\n", "utf-8");
    const reopened = new MemoryStore(ws);
    const all = reopened.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe(id);
  });

  it("the memory store lives next to sessions under .claude/", async () => {
    await new SessionMemory(ws).save("s", [userMsg("x")]);
    new MemoryStore(ws).append([{ source: "manual", text: "note" }]);
    expect(fs.existsSync(path.join(ws, ".claude", "memories.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude", "sessions"))).toBe(true);
  });
});

// ============================================================
// Concurrency across sessions
// ============================================================

describe("Concurrent saves", () => {
  it("interleaved saves to different sessions all land correctly", async () => {
    const sm = new SessionMemory(ws);
    const ids = [sm.generateId(), sm.generateId(), sm.generateId()];
    const saves: Promise<void>[] = [];
    for (let s = 0; s < ids.length; s++) {
      for (let n = 1; n <= 5; n++) {
        const msgs = Array.from({ length: n }, (_, k) => userMsg(`s${s}-m${k}`));
        saves.push(sm.save(ids[s]!, msgs));
      }
    }
    await Promise.all(saves);
    for (const id of ids) {
      const loaded = await sm.load(id);
      expect(loaded!.messageCount).toBe(5); // final (largest) snapshot wins per session
    }
    expect(await sm.listSessions()).toHaveLength(3);
  });

  it("ordered transcript appends survive a flurry in one tick", async () => {
    const t = new SessionTranscript(ws);
    const id = "burst";
    const appends: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      appends.push(t.append(id, { type: "user_prompt", text: `m${i}` }));
    }
    await Promise.all(appends);
    const entries = t.read(id);
    expect(entries).toHaveLength(10);
    // seq is strictly increasing 0..9 (append chain preserves order).
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
