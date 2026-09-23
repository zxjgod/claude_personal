// ============================================================
// Tests: Time-Based Micro-Compact
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLEARED_MESSAGE, microCompactByTime } from "../services/time-micro-compact.js";
import type { Message } from "../types.js";

describe("microCompactByTime", () => {
  // Save and restore env vars
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      CCR_MICROCOMPACT_ENABLED: process.env.CCR_MICROCOMPACT_ENABLED,
      CCR_MICROCOMPACT_GAP_MINUTES: process.env.CCR_MICROCOMPACT_GAP_MINUTES,
      CCR_MICROCOMPACT_KEEP_RECENT: process.env.CCR_MICROCOMPACT_KEEP_RECENT,
    };
    // Reset to defaults
    delete process.env.CCR_MICROCOMPACT_ENABLED;
    delete process.env.CCR_MICROCOMPACT_GAP_MINUTES;
    delete process.env.CCR_MICROCOMPACT_KEEP_RECENT;
  });

  afterEach(() => {
    process.env.CCR_MICROCOMPACT_ENABLED = originalEnv.CCR_MICROCOMPACT_ENABLED;
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = originalEnv.CCR_MICROCOMPACT_GAP_MINUTES;
    process.env.CCR_MICROCOMPACT_KEEP_RECENT = originalEnv.CCR_MICROCOMPACT_KEEP_RECENT;
  });

  const createAssistant = (
    minutesAgo: number,
    toolCalls: { id: string; name: string }[] = [],
  ): Message =>
    ({
      role: "assistant",
      content: "test assistant message",
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: "{}" },
      })),
      timestamp: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    }) as Message;

  const createTool = (id: string, content: string): Message => ({
    role: "tool",
    tool_call_id: id,
    name: "read",
    content,
  });

  it("should not trigger when gap < threshold (default 60min)", () => {
    const messages: Message[] = [
      createAssistant(30), // 30 min ago, under default 60min threshold
    ];
    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(0);
    expect(result.messages).toBe(messages); // Same reference = no change
  });

  it("should not trigger when no assistant message has timestamp", () => {
    const messages: Message[] = [{ role: "assistant", content: "no timestamp" } as Message];
    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(0);
  });

  it("should clear old tool results when gap exceeds threshold", () => {
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = "60";
    process.env.CCR_MICROCOMPACT_KEEP_RECENT = "2";

    const messages: Message[] = [
      createAssistant(90, [
        { id: "call_1", name: "read" },
        { id: "call_2", name: "bash" },
        { id: "call_3", name: "grep" },
      ]),
      createTool("call_1", "x".repeat(10000)), // old, should be cleared
      createTool("call_2", "y".repeat(8000)), // recent, kept (keepRecent=2)
      createTool("call_3", "z".repeat(5000)), // recent, kept
    ];

    const result = microCompactByTime(messages);

    expect(result.cleared).toBe(1); // call_1 cleared
    expect(result.tokensSaved).toBeGreaterThan(2000); // ~10000/4 = 2500 tokens
    expect(result.messages[1].content).toBe(CLEARED_MESSAGE);
    expect(result.messages[2].content).toBe("y".repeat(8000)); // Kept
    expect(result.messages[3].content).toBe("z".repeat(5000)); // Kept
  });

  it("should be idempotent (not re-clear already cleared)", () => {
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = "60";

    const messages: Message[] = [
      createAssistant(90, [{ id: "call_1", name: "read" }]),
      createTool("call_1", CLEARED_MESSAGE), // Already cleared
    ];

    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(0); // No additional clearing
    expect(result.tokensSaved).toBe(0);
  });

  it("should respect CCR_MICROCOMPACT_ENABLED=0", () => {
    process.env.CCR_MICROCOMPACT_ENABLED = "0";
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = "60";

    const messages: Message[] = [
      createAssistant(90, [{ id: "call_1", name: "read" }]),
      createTool("call_1", "content to clear"),
    ];

    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(0); // Disabled
  });

  it("should only clear compactable tools (read/bash/grep/etc)", () => {
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = "60";
    process.env.CCR_MICROCOMPACT_KEEP_RECENT = "1"; // Keep 1 recent (keepRecent floored at 1)

    const messages: Message[] = [
      createAssistant(90, [
        { id: "call_1", name: "read" }, // compactable, will be cleared
        { id: "call_2", name: "task" }, // NOT compactable, always kept
        { id: "call_3", name: "bash" }, // compactable, kept (most recent)
      ]),
      createTool("call_1", "should clear"),
      createTool("call_2", "should keep"),
      createTool("call_3", "should keep as recent"),
    ];

    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(1); // Only call_1 cleared (call_3 is kept as recent)
    expect(result.messages[1].content).toBe(CLEARED_MESSAGE);
    expect(result.messages[2].content).toBe("should keep"); // task not compactable
    expect(result.messages[3].content).toBe("should keep as recent"); // kept as recent
  });

  it("should always keep at least 1 result (floor keepRecent at 1)", () => {
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = "60";
    process.env.CCR_MICROCOMPACT_KEEP_RECENT = "0"; // Try to clear all, but floored at 1

    const messages: Message[] = [
      createAssistant(90, [
        { id: "call_1", name: "read" },
        { id: "call_2", name: "bash" },
      ]),
      createTool("call_1", "old"),
      createTool("call_2", "recent"),
    ];

    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(1); // Only call_1 cleared, call_2 kept (floor at 1)
    expect(result.messages[1].content).toBe(CLEARED_MESSAGE);
    expect(result.messages[2].content).toBe("recent");
  });

  it("should handle empty messages gracefully", () => {
    const result = microCompactByTime([]);
    expect(result.cleared).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("should handle messages with no tool calls", () => {
    const messages: Message[] = [
      createAssistant(90), // No tool calls
    ];
    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(0);
  });

  it("should respect custom gap threshold from env var", () => {
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = "30"; // Custom 30min threshold
    process.env.CCR_MICROCOMPACT_KEEP_RECENT = "0"; // Try to clear all (will floor to 1)

    const messages: Message[] = [
      createAssistant(45, [
        { id: "call_1", name: "read" },
        { id: "call_2", name: "bash" },
      ]), // 45min > 30min threshold
      createTool("call_1", "old result"),
      createTool("call_2", "recent result"),
    ];

    const result = microCompactByTime(messages);
    expect(result.cleared).toBe(1); // call_1 cleared, call_2 kept (floor at 1)
    expect(result.messages[1].content).toBe(CLEARED_MESSAGE);
    expect(result.messages[2].content).toBe("recent result");
  });

  it("drives the trigger from an explicit lastActivityMs (session updatedAt)", () => {
    process.env.CCR_MICROCOMPACT_KEEP_RECENT = "1";
    // No message timestamps at all — the wiring at session load passes the
    // session's updatedAt, which must be enough to fire.
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      createTool("call_1", "stale dump"),
      createTool("call_2", "recent dump"),
    ];
    // 90 minutes idle — over the default 60min threshold.
    const idle = microCompactByTime(messages, Date.now() - 90 * 60 * 1000);
    expect(idle.cleared).toBe(1);
    expect(idle.messages[1].content).toBe(CLEARED_MESSAGE);

    // 5 minutes idle — under threshold, same reference back.
    const fresh = microCompactByTime(messages, Date.now() - 5 * 60 * 1000);
    expect(fresh.cleared).toBe(0);
    expect(fresh.messages).toBe(messages);
  });

  it("explicit lastActivityMs overrides stale message timestamps", () => {
    // Message says 90min ago (would fire), but the session was actually
    // saved 5 minutes ago — the explicit value wins and nothing clears.
    const messages: Message[] = [
      createAssistant(90, [{ id: "call_1", name: "read" }]),
      createTool("call_1", "keep me"),
    ];
    const result = microCompactByTime(messages, Date.now() - 5 * 60 * 1000);
    expect(result.cleared).toBe(0);
  });
});
