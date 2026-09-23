// ============================================================
// Tests: memory-extract (M19.3)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileChange } from "../change-tracker.js";
import { extractMemoriesHeuristic, MemoryStore } from "../memory-extract.js";
import type { Message } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-memory-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("extractMemoriesHeuristic", () => {
  it("captures durable-intent lines from user messages", () => {
    const messages: Message[] = [
      userMsg("Always use tabs for indentation."),
      userMsg("Can you fix the bug?"),
      userMsg("Remember that the API base URL is in .env"),
    ];
    const out = extractMemoriesHeuristic(messages);
    const texts = out.map((m) => m.text);
    expect(texts).toContain("Always use tabs for indentation.");
    expect(texts).toContain("Remember that the API base URL is in .env");
    expect(texts).not.toContain("Can you fix the bug?");
    out.forEach((m) => {
      expect(m.source).toBe("heuristic");
    });
  });

  it("summarizes files changed this session", () => {
    const changes: FileChange[] = [
      { path: "src/a.ts", kind: "created", edits: 1, updatedAt: 2 },
      { path: "src/b.ts", kind: "modified", edits: 3, updatedAt: 1 },
    ];
    const out = extractMemoriesHeuristic([], changes);
    const changeMem = out.find((m) => m.tags?.includes("changes"));
    expect(changeMem).toBeTruthy();
    expect(changeMem!.text).toContain("+src/a.ts");
    expect(changeMem!.text).toContain("~src/b.ts");
  });

  it("dedupes repeated intent lines", () => {
    const messages: Message[] = [
      userMsg("Always run tests before committing."),
      userMsg("always run tests before committing."),
    ];
    const out = extractMemoriesHeuristic(messages);
    expect(out).toHaveLength(1);
  });

  it("captures Chinese durable-intent lines", () => {
    const messages: Message[] = [
      userMsg("记住这个项目始终用 pnpm 安装依赖"),
      userMsg("以后每次提交前都要跑测试"),
      userMsg("今天天气不错"),
    ];
    const out = extractMemoriesHeuristic(messages);
    const texts = out.map((m) => m.text);
    expect(texts).toContain("记住这个项目始终用 pnpm 安装依赖");
    expect(texts).toContain("以后每次提交前都要跑测试");
    expect(texts).not.toContain("今天天气不错");
  });
});

describe("MemoryStore", () => {
  it("appends and lists memories", () => {
    const store = new MemoryStore(tmpDir);
    expect(store.list()).toEqual([]);
    const written = store.append([
      { source: "manual", text: "Prefer pnpm over npm" },
      { source: "heuristic", text: "Files changed: src/x.ts" },
    ]);
    expect(written).toHaveLength(2);
    expect(store.list()).toHaveLength(2);
    expect(fs.existsSync(path.join(tmpDir, ".claude", "memories.jsonl"))).toBe(true);
  });

  it("dedupes against what is already stored", () => {
    const store = new MemoryStore(tmpDir);
    store.append([{ source: "manual", text: "Use 2-space indent" }]);
    const second = store.append([
      { source: "manual", text: "use 2-space indent" }, // same after normalize
      { source: "manual", text: "New fact" },
    ]);
    expect(second).toHaveLength(1);
    expect(second[0].text).toBe("New fact");
    expect(store.list()).toHaveLength(2);
  });

  it("tolerates a corrupt line in the store", () => {
    const store = new MemoryStore(tmpDir);
    store.append([{ source: "manual", text: "good" }]);
    fs.appendFileSync(store.path, "{ broken line\n", "utf-8");
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("good");
  });
});
