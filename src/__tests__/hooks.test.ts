// ============================================================
// Tests: hooks (PreToolUse / PostToolUse)
// ============================================================

import { describe, expect, it } from "vitest";
import { HookRegistry } from "../hooks.js";
import type { ToolResult } from "../types.js";

describe("HookRegistry — PreToolUse", () => {
  it("passes input through unchanged when no hooks match", async () => {
    const reg = new HookRegistry();
    const out = await reg.runPre({ toolName: "read", input: { filePath: "a" } });
    expect(out.block).toBeUndefined();
    expect(out.input).toEqual({ filePath: "a" });
  });

  it("blocks a call and surfaces a reason", async () => {
    const reg = new HookRegistry();
    reg.register({
      matcher: "bash",
      pre: () => ({ block: true, reason: "no shell" }),
    });
    const out = await reg.runPre({ toolName: "bash", input: { command: "rm -rf /" } });
    expect(out.block).toBe(true);
    expect(out.reason).toBe("no shell");
  });

  it("rewrites input", async () => {
    const reg = new HookRegistry();
    reg.register({
      matcher: "*",
      pre: ({ input }) => ({ input: { ...input, injected: true } }),
    });
    const out = await reg.runPre({ toolName: "write", input: { filePath: "a" } });
    expect(out.input).toEqual({ filePath: "a", injected: true });
  });

  it("only runs hooks whose matcher matches the tool", async () => {
    const reg = new HookRegistry();
    reg.register({ matcher: "edit", pre: () => ({ block: true, reason: "x" }) });
    const out = await reg.runPre({ toolName: "read", input: {} });
    expect(out.block).toBeUndefined();
  });

  it("first blocking hook short-circuits", async () => {
    const reg = new HookRegistry();
    let secondRan = false;
    reg.register({ matcher: "*", pre: () => ({ block: true, reason: "stop" }) });
    reg.register({
      matcher: "*",
      pre: () => {
        secondRan = true;
        return;
      },
    });
    const out = await reg.runPre({ toolName: "read", input: {} });
    expect(out.block).toBe(true);
    expect(secondRan).toBe(false);
  });
});

describe("HookRegistry — PostToolUse", () => {
  it("returns the original result when no hooks match", async () => {
    const reg = new HookRegistry();
    const result: ToolResult = { content: "original" };
    const out = await reg.runPost({ toolName: "read", input: {}, result });
    expect(out.result).toBe(result);
  });

  it("rewrites the result and chains across hooks", async () => {
    const reg = new HookRegistry();
    reg.register({
      matcher: "*",
      post: ({ result }) => ({ result: { content: result.content + "-a" } }),
    });
    reg.register({
      matcher: "*",
      post: ({ result }) => ({ result: { content: result.content + "-b" } }),
    });
    const out = await reg.runPost({
      toolName: "read",
      input: {},
      result: { content: "x" },
    });
    expect(out.result!.content).toBe("x-a-b");
  });
});
