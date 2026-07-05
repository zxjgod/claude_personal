// ============================================================
// Tests: Usage Baseline Optimization
// ============================================================

import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";

describe("Usage Baseline", () => {
  // Helper to create mock messages
  const createMessage = (role: "user" | "assistant" | "tool", content: string): Message => {
    if (role === "user") {
      return { role: "user", content: [{ type: "text", text: content }] };
    }
    if (role === "assistant") {
      return { role: "assistant", content, tool_calls: [] };
    }
    return { role: "tool", tool_call_id: "call_1", content };
  };

  it("should extract input_tokens from usage as promptTokens", () => {
    // Mock usage from provider
    const usage = {
      input_tokens: 5000,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 500,
      output_tokens: 200,
    };

    // Calculate promptTokens (same logic as agent-loop)
    const promptTokens =
      usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);

    expect(promptTokens).toBe(6500); // 5000 + 1000 + 500
  });

  it("should create baseline with correct structure", () => {
    const usage = { input_tokens: 5000, output_tokens: 100 };
    const windowAtCall = 10;

    const promptTokens = usage.input_tokens;
    const baseline = { promptTokens, messageCount: windowAtCall };

    expect(baseline).toEqual({
      promptTokens: 5000,
      messageCount: 10,
    });
  });

  describe("estimateContextTokens", () => {
    // Simulate estimateContextTokens function behavior
    function estimateTokens(messages: Message[]): number {
      // Simple estimation: ~4 chars per token
      const totalChars = messages.reduce((sum, msg) => {
        if (msg.role === "user") {
          const firstBlock = msg.content[0];
          return sum + (firstBlock && firstBlock.type === "text" ? firstBlock.text.length : 0);
        }
        if (msg.role === "assistant") {
          return sum + (msg.content?.length || 0);
        }
        if (msg.role === "tool") {
          return sum + (msg.content?.length || 0);
        }
        return sum;
      }, 0);
      return Math.ceil(totalChars / 4);
    }

    function estimateContextTokens(
      messages: Message[],
      baseline?: { promptTokens: number; messageCount: number },
    ): number {
      if (baseline && messages.length >= baseline.messageCount) {
        const appended = messages.slice(baseline.messageCount);
        return baseline.promptTokens + estimateTokens(appended);
      }
      return estimateTokens(messages);
    }

    it("should estimate incrementally with valid baseline", () => {
      const messages: Message[] = [
        createMessage("user", "x".repeat(400)), // ~100 tokens
        createMessage("assistant", "y".repeat(400)), // ~100 tokens
        createMessage("user", "z".repeat(400)), // ~100 tokens (new)
      ];

      const baseline = { promptTokens: 5000, messageCount: 2 };

      const estimate = estimateContextTokens(messages, baseline);

      // Should be 5000 + ~100 (new message)
      expect(estimate).toBeGreaterThan(5000);
      expect(estimate).toBeLessThan(5200);
    });

    it("should fallback to full estimation without baseline", () => {
      const messages: Message[] = [
        createMessage("user", "x".repeat(400)),
        createMessage("assistant", "y".repeat(400)),
      ];

      const estimate = estimateContextTokens(messages);

      // Should be ~200 tokens total
      expect(estimate).toBeGreaterThan(150);
      expect(estimate).toBeLessThan(250);
    });

    it("should fallback if messageCount decreased (compaction)", () => {
      const messages: Message[] = [createMessage("user", "x".repeat(400))];

      // Baseline from before compaction (more messages)
      const baseline = { promptTokens: 10000, messageCount: 20 };

      const estimate = estimateContextTokens(messages, baseline);

      // Should fallback to full estimation (messages.length < baseline.messageCount)
      expect(estimate).toBeLessThan(200); // Only 1 message now
    });

    it("should use incremental estimation for long conversations", () => {
      // Simulate 50 messages
      const messages: Message[] = Array.from({ length: 50 }, (_, i) =>
        createMessage("user", `message ${i}`.repeat(10)),
      );

      const baseline = { promptTokens: 20000, messageCount: 48 };

      const estimate = estimateContextTokens(messages, baseline);

      // Should be 20000 + ~tokens for 2 new messages
      expect(estimate).toBeGreaterThan(20000);
      expect(estimate).toBeLessThan(21000);
    });
  });

  describe("baseline rebuild after compaction", () => {
    it("should rebuild baseline after autoCompact", () => {
      // Before compaction: 20 messages
      const messagesBeforeCompact: Message[] = Array.from({ length: 20 }, (_, i) =>
        createMessage("user", `message ${i}`.repeat(100)),
      );

      // After compaction: compressed to 5 messages
      const messagesAfterCompact: Message[] = [
        { role: "system", content: "[CONVERSATION SUMMARY]\nSummary of previous messages" },
        ...Array.from({ length: 4 }, (_, i) => createMessage("user", `recent ${i}`.repeat(100))),
      ];

      // Simulate baseline rebuild
      function estimateTokens(messages: Message[]): number {
        const totalChars = messages.reduce((sum, msg) => {
          let content = "";
          if (msg.role === "system") {
            content = msg.content;
          } else if (msg.role === "user") {
            const firstBlock = msg.content[0];
            content = firstBlock && firstBlock.type === "text" ? firstBlock.text : "";
          } else if (msg.role === "assistant") {
            content = msg.content || "";
          } else if (msg.role === "tool") {
            content = msg.content || "";
          }
          return sum + content.length;
        }, 0);
        return Math.ceil(totalChars / 4);
      }

      const newPromptTokens = estimateTokens(messagesAfterCompact);
      const newBaseline = {
        promptTokens: newPromptTokens,
        messageCount: messagesAfterCompact.length,
      };

      expect(newBaseline.messageCount).toBe(5);
      expect(newBaseline.promptTokens).toBeGreaterThan(0);
      expect(newBaseline.promptTokens).toBeLessThan(10000); // Compressed
    });
  });
});
