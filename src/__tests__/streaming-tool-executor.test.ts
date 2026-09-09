// ============================================================
// Tests: Streaming Tool Executor (M36, kernel §9)
// ============================================================

import { describe, expect, it } from "vitest";
import { StreamingToolExecutor } from "../streaming-tool-executor.js";
import type { Tool, ToolExecutionResult } from "../types.js";

function tool(name: string, readOnly: boolean, concurrencySafe: boolean): Tool {
  return {
    name,
    description: name,
    promptDescription: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => concurrencySafe,
    call: async () => ({ content: "" }),
    formatResult: (r) => r.content,
    checkPermissions: async () => ({ allowed: true }),
  };
}

function ok(name: string): ToolExecutionResult {
  return { toolName: name, formatted: `${name} ok`, isError: false };
}

const readTool = tool("read", true, true);
const writeTool = tool("write", false, false);

describe("StreamingToolExecutor", () => {
  it("early-starts a read-only + concurrency-safe call and serves it via take", async () => {
    let ran = 0;
    const ex = new StreamingToolExecutor(true, [readTool], async (n) => {
      ran++;
      return ok(n);
    });
    ex.add("c1", "read", { filePath: "a.ts" });
    expect(ex.started).toBe(1);
    const result = await ex.take("c1");
    expect(ran).toBe(1); // ran in the background, awaited via take
    expect(result?.formatted).toBe("read ok");
    expect(ex.hits).toBe(1);
  });

  it("does NOT early-start a write (not read-only/concurrency-safe)", async () => {
    let ran = 0;
    const ex = new StreamingToolExecutor(true, [writeTool], async (n) => {
      ran++;
      return ok(n);
    });
    ex.add("c1", "write", { filePath: "a.ts", content: "x" });
    expect(ex.started).toBe(0);
    expect(ran).toBe(0);
    expect(await ex.take("c1")).toBeNull(); // miss → STEP 5 runs it normally
  });

  it("is a no-op when disabled", async () => {
    const ex = new StreamingToolExecutor(false, [readTool], async (n) => ok(n));
    ex.add("c1", "read", { filePath: "a.ts" });
    expect(ex.started).toBe(0);
    expect(await ex.take("c1")).toBeNull();
  });

  it("returns null on an unknown id (a call that was never early-started)", async () => {
    const ex = new StreamingToolExecutor(true, [readTool], async (n) => ok(n));
    expect(await ex.take("nope")).toBeNull();
  });

  it("ignores a duplicate add for the same id", async () => {
    let ran = 0;
    const ex = new StreamingToolExecutor(true, [readTool], async (n) => {
      ran++;
      return ok(n);
    });
    ex.add("c1", "read", { filePath: "a.ts" });
    ex.add("c1", "read", { filePath: "a.ts" });
    expect(ex.started).toBe(1);
    await ex.take("c1");
    expect(ran).toBe(1);
  });

  it("serves each id at most once", async () => {
    const ex = new StreamingToolExecutor(true, [readTool], async (n) => ok(n));
    ex.add("c1", "read", { filePath: "a.ts" });
    expect(await ex.take("c1")).not.toBeNull();
    expect(await ex.take("c1")).toBeNull(); // already consumed
  });

  it("captures a thrown runner error as an error result", async () => {
    const ex = new StreamingToolExecutor(true, [readTool], async () => {
      throw new Error("boom");
    });
    ex.add("c1", "read", { filePath: "a.ts" });
    const result = await ex.take("c1");
    expect(result?.isError).toBe(true);
    expect(result?.error).toContain("boom");
  });

  it("cancels and removes discarded early calls", async () => {
    let cancelled = false;
    const ex = new StreamingToolExecutor(true, [readTool], async (_n, _i, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        );
      });
      return ok("read");
    });
    ex.add("discarded", "read", { filePath: "a.ts" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ex.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
    expect(ex.pending).toBe(0);
  });
});
