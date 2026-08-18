// ============================================================
// Tests: CJK-aware token estimation
// ============================================================
// Regression: the natural-language ratio (~3.5 chars/token) underestimates
// Chinese/Japanese/Korean text ~3x, so a Chinese-heavy session blew the
// provider's context limit before auto-compaction ever triggered.
// ============================================================

import { describe, expect, it } from "vitest";
import { estimateTokens } from "../token-estimator.js";
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
