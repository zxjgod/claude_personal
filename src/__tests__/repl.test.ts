// ============================================================
// Tests: REPL tool (persistent node/python evaluation)
// ============================================================

import { afterAll, describe, expect, it } from "vitest";
import { disposeAllReplSessions, ReplTool } from "../tools/extended/repl.js";
import type { ToolContext } from "../types.js";

const ctx: ToolContext = {
  workspaceRoot: process.cwd(),
  sessionId: "repl-test",
  permissionMode: "default",
};

afterAll(() => {
  disposeAllReplSessions();
});

describe("ReplTool", () => {
  it("evaluates a node expression and returns its value", async () => {
    const r = await ReplTool.call({ expression: "1 + 1" }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("2");
  });

  it("persists state across calls in the same session", async () => {
    await ReplTool.call({ expression: "let acc = 40 + 2", restart: true }, ctx);
    const r = await ReplTool.call({ expression: "acc" }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("42");
  });

  it("captures console.log output", async () => {
    const r = await ReplTool.call(
      { expression: "console.log('hello from repl')", restart: true },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("hello from repl");
  });

  it("surfaces evaluation errors", async () => {
    const r = await ReplTool.call({ expression: "throw new Error('boom')", restart: true }, ctx);
    expect(r.error).toContain("boom");
  });
});
