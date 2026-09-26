// ============================================================
// Tests: CJK-aware token estimation
// ============================================================
// Regression: the natural-language ratio (~3.5 chars/token) underestimates
// Chinese/Japanese/Korean text ~3x, so a Chinese-heavy session blew the
// provider's context limit before auto-compaction ever triggered.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  estimateContextUsed,
  estimateMessageTokens,
  estimateTokens,
  providerPromptTokens,
} from "../token-estimator.js";
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

// ============================================================
// Provider-aware usage semantics (Top10 #3) — the single source
// of truth shared by the loop baseline and the TUI gauge.
// ============================================================

describe("providerPromptTokens / estimateContextUsed", () => {
  const full = {
    input_tokens: 800,
    output_tokens: 200,
    cache_read_input_tokens: 90_000,
    cache_creation_input_tokens: 2_000,
  };

  it("anthropic: cache_read and cache_creation are in-context tokens", () => {
    expect(providerPromptTokens(full, "anthropic")).toBe(92_800);
  });

  it("openai-compatible: input_tokens already includes cached tokens", () => {
    for (const provider of ["openai", "deepseek", "qwen", "ollama"]) {
      expect(providerPromptTokens(full, provider), provider).toBe(800);
    }
  });

  it("baseline excludes the call's own output; gauge includes it", () => {
    expect(providerPromptTokens(full, "anthropic")).toBe(92_800);
    expect(estimateContextUsed(full, "anthropic")).toBe(93_000);
    expect(estimateContextUsed(full, "openai")).toBe(1_000);
  });

  it("the two dialects agree on the live-window figure for the same session", () => {
    // High cache-hit session: OpenAI reports the whole prompt in input_tokens,
    // Anthropic splits it across three fields. Both must yield the SAME
    // in-context number — under the old raw-input_tokens baseline the
    // Anthropic view under-counted by the entire cached prefix.
    const openAiView = { input_tokens: 92_800, output_tokens: 200 };
    expect(providerPromptTokens(openAiView, "openai")).toBe(
      providerPromptTokens(full, "anthropic"),
    );
  });
});

// ============================================================
// Top10 follow-up A8: pixel-based image estimation
// ============================================================

describe("image token estimation (pixel-based, A8)", () => {
  function pngBase64(w: number, h: number): string {
    const buf = Buffer.alloc(24);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    return buf.toString("base64");
  }

  it("estimates from real pixel dimensions, not base64 length", () => {
    // 1500×1500 → ceil(2_250_000/750) = 3000 tokens regardless of payload size.
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: pngBase64(1500, 1500) },
          } as any,
        ],
      },
    ];
    expect(estimateTokens(msgs)).toBe(3000);
  });

  it("keeps the 85-token floor for tiny images", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: pngBase64(1, 1) },
          } as any,
        ],
      },
    ];
    expect(estimateTokens(msgs)).toBe(85);
  });

  it("reads dimensions from a JPEG with 0xFF fill bytes (fourth round)", () => {
    // SOI + a run of 0xFF fill bytes (legal padding) + SOF0 segment. The old
    // scan treated the second 0xFF as a length-bearing marker, jumped off a
    // bogus segment size, and bailed to the base64-length heuristic.
    // Layout after SOI: FF FF FF | FF C0 len prec h w comps…
    const sof = Buffer.alloc(12);
    sof[0] = 0xff;
    sof[1] = 0xc0; // SOF0
    sof.writeUInt16BE(10, 2); // segment length
    sof[4] = 8; // precision
    sof.writeUInt16BE(1200, 5); // height
    sof.writeUInt16BE(1600, 7); // width
    sof[9] = 3; // components
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]), // SOI
      Buffer.from([0xff, 0xff]), // 0xFF fill bytes before the next marker
      sof,
    ]);
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: jpeg.toString("base64"),
            },
          } as any,
        ],
      },
    ];
    // 1600×1200 → 1,920,000 px → ceil(/750) = 2560 tokens from real pixels.
    expect(estimateTokens(msgs)).toBe(2560);
  });

  it("falls back to the size heuristic for unrecognized formats", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/webp", data: "AAAA".repeat(750) },
          } as any,
        ],
      },
    ];
    // 3000 base64 chars → 85 + ceil(3000*4/750) = 85 + 16 = 101
    expect(estimateTokens(msgs)).toBe(101);
  });
});
