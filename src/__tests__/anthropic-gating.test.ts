// ============================================================
// Tests: Anthropic request-shape gating (Top10 follow-ups A4/A5/A6/#28)
// ============================================================
// Mocks the SDK to capture exactly what the adapter sends:
//   - output_config.effort only for models that support it (a documented
//     400 on Sonnet 4.5 / Haiku 4.5);
//   - adaptive thinking only for models that support it;
//   - the stale interleaved-thinking-2025-05-14 beta header is gone;
//   - maxRetries: 0 (the loop owns retry policy — no multiplicative retries);
//   - max_tokens clamped to the per-model output cap even when the user's
//     LLM_MAX_TOKENS override raises it.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const ctorSpy = vi.fn();
const streamSpy = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      constructor(opts: unknown) {
        ctorSpy(opts);
      }
      messages = { stream: streamSpy };
    },
  };
});

import { anthropicCaller } from "../anthropic-adapter.js";
import type { Message, ModelConfig, StreamEvent } from "../types.js";

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

/** A minimal stream mock: no events, an empty final message. */
function mockStream() {
  return {
    controller: { abort: vi.fn() },
    on: () => {},
    async *[Symbol.asyncIterator]() {
      /* no stream events */
    },
    finalMessage: async () => ({
      content: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      stop_reason: "end_turn",
    }),
  };
}

async function drain(config: ModelConfig): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of anthropicCaller(messages, [], "sys", config)) {
    events.push(e);
  }
  return events;
}

beforeEach(() => {
  ctorSpy.mockReset();
  streamSpy.mockReset();
  streamSpy.mockReturnValue(mockStream());
});

describe("anthropic request gating", () => {
  const base = { provider: "anthropic" as const, apiKey: "k" };

  it("sends effort + adaptive thinking for a supporting model (opus-4-8)", async () => {
    await drain({ ...base, model: "claude-opus-4-8" });
    const params = streamSpy.mock.calls[0][0];
    expect(params.output_config).toEqual({ effort: "high" }); // DEFAULT_EFFORT
    expect(params.thinking).toEqual({ type: "adaptive" });
    // The stale beta header is gone; no request-level headers at all.
    const opts = streamSpy.mock.calls[0][1];
    expect(opts?.headers).toBeUndefined();
  });

  it("omits effort AND thinking for Haiku 4.5 (both are documented 400s)", async () => {
    await drain({ ...base, model: "claude-haiku-4-5" });
    const params = streamSpy.mock.calls[0][0];
    expect(params.output_config).toBeUndefined();
    expect(params.thinking).toBeUndefined();
  });

  it("omits effort for Sonnet 4.5 (documented 400)", async () => {
    await drain({ ...base, model: "claude-sonnet-4-5" });
    const params = streamSpy.mock.calls[0][0];
    expect(params.output_config).toBeUndefined();
  });

  it("an explicit options.output_config still wins over the gate", async () => {
    // Caller's explicit decision — the adapter passes it through even where
    // the default would be suppressed.
    await drain({
      ...base,
      model: "claude-haiku-4-5",
      options: { output_config: { effort: "low" } },
    });
    const params = streamSpy.mock.calls[0][0];
    expect(params.output_config).toEqual({ effort: "low" });
  });

  it("constructs the SDK client with maxRetries: 0 (loop owns retries)", async () => {
    await drain({ ...base, model: "claude-opus-4-8" });
    expect(ctorSpy.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
  });

  it("clamps max_tokens to the per-model output cap (Haiku 4.5 = 64K)", async () => {
    await drain({ ...base, model: "claude-haiku-4-5", maxTokens: 131_072 });
    const params = streamSpy.mock.calls[0][0];
    expect(params.max_tokens).toBe(64_000);
  });

  it("honors a raised LLM_MAX_TOKENS override within the model cap", async () => {
    await drain({ ...base, model: "claude-opus-4-8", maxTokens: 64_000 });
    const params = streamSpy.mock.calls[0][0];
    expect(params.max_tokens).toBe(64_000);
  });
});
