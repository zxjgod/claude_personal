// ============================================================
// Tests: RestoreContext tool (F2) — recover evicted tool results
// ============================================================

import { describe, expect, it } from "vitest";
import { CollapseStore, evictionStub } from "../context-pipeline.js";
import { RestoreContextTool } from "../tools/extended/restore-context.js";
import type { ToolContext } from "../types.js";

const ctx = (store?: CollapseStore): ToolContext => ({
  workspaceRoot: process.cwd(),
  sessionId: "restore-test",
  permissionMode: "default",
  ...(store ? { collapseStore: store } : {}),
});

describe("evictionStub", () => {
  it("embeds the tool_call_id so the model knows what to recover", () => {
    const stub = evictionStub("read", 8_000, "toolu_abc123");
    expect(stub).toContain("(id: toolu_abc123)");
    expect(stub).toContain("RestoreContext");
  });

  it("omits the id section when no id is given", () => {
    const stub = evictionStub("read", 8_000);
    expect(stub).not.toContain("(id:");
    expect(stub).toContain("[evicted: read result");
  });
});

describe("RestoreContextTool", () => {
  it("restores stashed content for a known id", async () => {
    const store = new CollapseStore();
    store.collapse("toolu_1", "original content\n".repeat(100));
    const result = await RestoreContextTool.call({ tool_call_id: "toolu_1" }, ctx(store));
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("original content");
    expect(result.content).toContain("toolu_1");
    expect(result.content).toContain("— 1700 chars]");
  });

  it("reports a clear error for an unknown id", async () => {
    const store = new CollapseStore();
    store.collapse("toolu_known", "x");
    const result = await RestoreContextTool.call({ tool_call_id: "toolu_missing" }, ctx(store));
    expect(result.error).toContain("toolu_missing");
    expect(result.error).toContain("1 item(s)");
  });

  it("errors when no store is present in the context", async () => {
    const result = await RestoreContextTool.call({ tool_call_id: "toolu_1" }, ctx());
    expect(result.error).toContain("No recoverable content store");
  });

  it("truncates huge restores and resumes via offset", async () => {
    const store = new CollapseStore();
    store.collapse("toolu_big", "x".repeat(120_000));
    const first = await RestoreContextTool.call({ tool_call_id: "toolu_big" }, ctx(store));
    expect(first.content).toContain("restored 50000 of 120000 chars");
    expect(first.content).toContain("offset 50000");
    // Resume: 50000 more, still 20000 to go.
    const second = await RestoreContextTool.call(
      { tool_call_id: "toolu_big", offset: 50_000 },
      ctx(store),
    );
    expect(second.content).toContain("restored 50000 of 120000 chars");
    expect(second.content).toContain("offset 100000");
    // Final chunk: exactly the rest — no continuation note at all.
    const third = await RestoreContextTool.call(
      { tool_call_id: "toolu_big", offset: 100_000 },
      ctx(store),
    );
    expect(third.content).not.toMatch(/restored \d+ of \d+/);
    expect(third.content).toContain("— 120000 chars]");
  });

  it("rejects an offset beyond the content length", async () => {
    const store = new CollapseStore();
    store.collapse("toolu_small", "tiny");
    const result = await RestoreContextTool.call(
      { tool_call_id: "toolu_small", offset: 100 },
      ctx(store),
    );
    expect(result.error).toContain("beyond the restored content length");
  });
});
