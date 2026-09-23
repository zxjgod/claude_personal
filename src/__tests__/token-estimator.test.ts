// ============================================================
// Tests: CJK-aware token estimation
// ============================================================
// Regression: the natural-language ratio (~3.5 chars/token) underestimates
// Chinese/Japanese/Korean text ~3x, so a Chinese-heavy session blew the
// provider's context limit before auto-compaction ever triggered.
// ============================================================

import { describe, expect, it } from "vitest";
import { estimateMessageTokens, estimateTokens } from "../token-estimator.js";
import type { Message } from "../types.js";

function userText(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

describe("estimateTokens CJK handling", () => {
  it("counts CJK text at ~1 token/char, not ~1 token per 3.5 chars", () => {
    // 100 Chinese characters — pure natural language, no code markers.
    const chinese = "这是一段中文文本。".repeat(10); // 100 chars
    const est = estimateTokens(userText(chinese));
    expect(est).toBeGreaterThanOrEqual(70);
    expect(est).toBeLessThanOrEqual(140);
  });

  it("blends CJK and ASCII in mixed text", () => {
    // 50 CJK + 50 ASCII: ~50 + 50/3.5 ≈ 64 tokens.
    const mixed = "中".repeat(50) + "a".repeat(50);
    const est = estimateTokens(userText(mixed));
    expect(est).toBeGreaterThanOrEqual(55);
    expect(est).toBeLessThanOrEqual(80);
  });

  it("counts CJK in tool_call arguments (Write content)", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({ filePath: "a.txt", content: "汉".repeat(100) }),
            },
          },
        ],
      },
    ];
    const est = estimateTokens(messages);
    // ~100 CJK chars must contribute ~100 tokens, not ~29 (100/3.5).
    expect(est).toBeGreaterThanOrEqual(90);
  });

  it("still estimates pure-ASCII prose at the natural-language ratio", () => {
    const english = "the quick brown fox jumps over the lazy dog. ".repeat(20); // 900 chars
    const est = estimateTokens(userText(english));
    // ~900/3.5 ≈ 257; allow slack for content-type detection.
    expect(est).toBeGreaterThanOrEqual(200);
    expect(est).toBeLessThanOrEqual(320);
  });
});

describe("per-message memoization (P3)", () => {
  it("estimateTokens equals the sum of per-message estimates", () => {
    const messages: Message[] = [
      ...userText("hello world"),
      {
        role: "assistant",
        content: "thinking out loud",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: '{"filePath":"a.ts"}' },
          },
        ],
      },
      { role: "tool", name: "read", tool_call_id: "c1", content: "const x = 1;\nconst y = 2;\n" },
      { role: "system", content: "system prompt text" },
    ];
    const total = estimateTokens(messages);
    const sum = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    expect(total).toBe(sum);
    expect(total).toBeGreaterThan(0);
  });

  it("repeated estimates of the same message objects return identical values", () => {
    // The WeakMap cache is keyed on message identity; the observable contract
    // is that repeated calls are stable (and share the cached entry).
    const msgs = userText("缓存一致性检查 some english words too");
    const first = estimateTokens(msgs);
    const second = estimateTokens(msgs);
    const third = estimateTokens(msgs);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("a message shared between two arrays is counted per array, identically", () => {
    const shared: Message = { role: "system", content: "shared system reminder".repeat(50) };
    const a: Message[] = [shared, ...userText("query a")];
    const b: Message[] = [shared, ...userText("query b")];
    const estA = estimateTokens(a);
    const estB = estimateTokens(b);
    // Same shared message contributes the same amount to both arrays.
    const sharedEst = estimateMessageTokens(shared);
    expect(estA - sharedEst).toBe(estimateTokens(userText("query a")));
    expect(estB - sharedEst).toBe(estimateTokens(userText("query b")));
  });
});
