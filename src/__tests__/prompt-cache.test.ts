// ============================================================
// Tests: prompt cache refinement (12.3)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  formatToolsForAnthropic,
  withMessageCacheBreakpoint,
} from "../anthropic-adapter.js";
import { SessionStats } from "../session-stats.js";
import type { Tool } from "../types.js";

function fakeTool(name: string): Tool {
  return {
    name,
    description: "",
    promptDescription: `desc ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call() {
      return { content: "" };
    },
    formatResult: (r) => r.content,
    async checkPermissions() {
      return { allowed: true };
    },
  } as Tool;
}

describe("formatToolsForAnthropic cache_control", () => {
  it("marks only the last tool with a cache breakpoint", () => {
    const tools = formatToolsForAnthropic([fakeTool("a"), fakeTool("b"), fakeTool("c")]);
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toBeUndefined();
    expect((tools[2] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles an empty tool list", () => {
    expect(formatToolsForAnthropic([])).toEqual([]);
  });
});

describe("withMessageCacheBreakpoint", () => {
  it("adds a breakpoint to the last block of the last message", () => {
    const msgs = [
      { role: "user" as const, content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      },
    ];
    const out = withMessageCacheBreakpoint(msgs);
    const lastBlocks = out[1].content as any[];
    expect(lastBlocks[0].cache_control).toBeUndefined();
    expect(lastBlocks[1].cache_control).toEqual({ type: "ephemeral" });
    // input not mutated
    expect((msgs[1].content as any[])[1].cache_control).toBeUndefined();
  });

  it("promotes a string content message to a marked block", () => {
    const out = withMessageCacheBreakpoint([
      { role: "user" as const, content: "plain" },
    ]);
    const blocks = out[0].content as any[];
    expect(blocks[0]).toMatchObject({
      type: "text",
      text: "plain",
      cache_control: { type: "ephemeral" },
    });
  });

  it("returns empty input unchanged", () => {
    expect(withMessageCacheBreakpoint([])).toEqual([]);
  });
});

describe("SessionStats cache metrics", () => {
  it("accumulates cache read/creation and computes hit rate", () => {
    const s = new SessionStats();
    // input_tokens already includes cache read+creation (adapter sums them).
    s.addUsage(1000, 200, { read: 800, creation: 100 });
    expect(s.cacheReadTokens).toBe(800);
    expect(s.cacheCreationTokens).toBe(100);
    expect(s.cacheHitRate).toBeCloseTo(0.8, 5);
  });

  it("hit rate is null with no input tokens", () => {
    expect(new SessionStats().cacheHitRate).toBeNull();
  });

  it("addUsage without cache arg leaves cache counters at zero", () => {
    const s = new SessionStats();
    s.addUsage(100, 50);
    expect(s.cacheReadTokens).toBe(0);
    expect(s.cacheHitRate).toBe(0);
  });
});
