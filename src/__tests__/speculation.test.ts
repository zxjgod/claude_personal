// ============================================================
// Tests: speculation — predictive tool prefetch (12.2)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  predictReads,
  specKey,
  SpeculationCache,
} from "../speculation.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const ctx: ToolContext = {
  workspaceRoot: "/ws",
  sessionId: "s",
  permissionMode: "default",
  modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "k" },
};

function fakeReadTool(calls: string[]): Tool {
  return {
    name: "read",
    description: "",
    promptDescription: "",
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      calls.push(String(input.filePath));
      return { content: `content of ${input.filePath}` };
    },
    formatResult: (r) => r.content,
    async checkPermissions() {
      return { allowed: true };
    },
  } as Tool;
}

describe("predictReads", () => {
  it("predicts Read calls from glob output (one path per line)", () => {
    const preds = predictReads("glob", { content: "src/a.ts\nsrc/b.ts" });
    expect(preds).toHaveLength(2);
    expect(preds[0]).toEqual({ toolName: "read", input: { filePath: "src/a.ts" } });
  });

  it("extracts paths from ripgrep-style grep output", () => {
    const preds = predictReads("grep", {
      content: "src/a.ts:12:  const x = 1\nsrc/a.ts:40:  return x\nsrc/b.ts:3:  foo",
    });
    // Dedupes a.ts → two distinct files.
    expect(preds.map((p) => p.input.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns nothing for non-search tools or errors", () => {
    expect(predictReads("write", { content: "x" })).toEqual([]);
    expect(predictReads("glob", { content: "", error: "boom" })).toEqual([]);
    expect(predictReads("glob", { content: "No files found matching pattern." })).toEqual([]);
  });

  it("caps the number of predictions", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join("\n");
    const preds = predictReads("glob", { content: many }, { maxPrefetch: 3 });
    expect(preds).toHaveLength(3);
  });
});

describe("specKey", () => {
  it("is stable regardless of key order", () => {
    expect(specKey("read", { a: 1, b: 2 })).toBe(specKey("read", { b: 2, a: 1 }));
  });
});

describe("SpeculationCache", () => {
  it("is a no-op when disabled", async () => {
    const calls: string[] = [];
    const cache = new SpeculationCache(false);
    cache.prefetch([{ toolName: "read", input: { filePath: "x" } }], [fakeReadTool(calls)], ctx);
    expect(calls).toHaveLength(0);
    expect(await cache.take("read", { filePath: "x" })).toBeNull();
  });

  it("prefetches read-only tools and serves a hit once", async () => {
    const calls: string[] = [];
    const tool = fakeReadTool(calls);
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: "a.ts" } }], [tool], ctx);
    // The prefetch ran the tool exactly once.
    const hit = await cache.take("read", { filePath: "a.ts" });
    expect(hit?.content).toBe("content of a.ts");
    expect(cache.hits).toBe(1);
    expect(calls).toEqual(["a.ts"]);
    // Second take for the same key misses (single-use).
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull();
    expect(cache.misses).toBe(1);
  });

  it("skips non-read-only tools", async () => {
    const calls: string[] = [];
    const writeTool = { ...fakeReadTool(calls), name: "write", isReadOnly: () => false } as Tool;
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "write", input: { filePath: "x" } }], [writeTool], ctx);
    expect(cache.prefetched).toBe(0);
    expect(await cache.take("write", { filePath: "x" })).toBeNull();
  });

  it("counts a miss for an unprefetched key", async () => {
    const cache = new SpeculationCache(true);
    expect(await cache.take("read", { filePath: "never" })).toBeNull();
    expect(cache.misses).toBe(1);
  });
});
