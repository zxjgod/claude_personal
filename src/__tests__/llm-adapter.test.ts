// ============================================================
// Tests: LLM Adapter stream parsing (usage timing)
// ============================================================
// Regression for two coupled bugs:
//  1. Streamed responses carried no token usage (stream_options.include_usage
//     was not requested) → usage stayed at 0.
//  2. The `done` event was emitted on the finish_reason chunk, BEFORE the
//     usage-only chunk (empty choices) arrives, so even real usage was lost.
// We mock the OpenAI client to reproduce the real chunk ordering.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the params passed to chat.completions.create so we can assert
// that include_usage was requested.
const createSpy = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: createSpy,
        },
      };
    },
  };
});

import { createModelCaller } from "../llm-adapter.js";
import type { Message, ModelConfig, StreamEvent } from "../types.js";
import { makePdf } from "./fixtures/pdf.js";

const config: ModelConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

/** Build an async-iterable stream mimicking OpenAI's chunk ordering: text
 * chunks, then a finish_reason chunk, then a final usage-only chunk whose
 * `choices` array is empty. */
function makeStream(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

beforeEach(() => {
  createSpy.mockReset();
});

describe("openAICompatibleCaller", () => {
  it("requests stream usage via stream_options.include_usage", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
      ]),
    );

    const caller = createModelCaller(config);
    for await (const _e of caller(messages, [], "sys", config)) {
      // drain
    }

    expect(createSpy).toHaveBeenCalledTimes(1);
    const params = createSpy.mock.calls[0][0];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it("captures usage from the final usage-only chunk after finish_reason", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        // Usage arrives AFTER finish_reason, with empty choices.
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 25 } },
      ]),
    );

    const caller = createModelCaller(config);
    const events: StreamEvent[] = [];
    for await (const e of caller(messages, [], "sys", config)) {
      events.push(e);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect((done as any).usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 25,
    });
    // No cache breakdown surfaced when the provider omits cached_tokens.
    expect((done as any).usage.cache_read_input_tokens ?? 0).toBe(0);
    // `done` must be the final event so usage is not lost.
    expect(events[events.length - 1].type).toBe("done");
  });

  it("changes request controls across effort tiers on chat models", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
    );

    for (const effort of ["low", "high", "max"] as const) {
      const cfg = { ...config, options: { effort } };
      for await (const _event of createModelCaller(cfg)(messages, [], "sys", cfg)) {
        // drain
      }
    }

    const requests = createSpy.mock.calls.map((call) => call[0]);
    expect(requests.map((request) => request.max_tokens)).toEqual([4096, 8192, 16384]);
    expect(requests.map((request) => request.temperature)).toEqual([0.2, 0.05, 0]);
  });

  it("surfaces cached_tokens as cache_read_input_tokens (16.5)", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 25,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
      ]),
    );

    const caller = createModelCaller(config);
    const events: StreamEvent[] = [];
    for await (const e of caller(messages, [], "sys", config)) {
      events.push(e);
    }

    const done = events.find((e) => e.type === "done");
    // prompt_tokens (100) already includes the 60 cached; we do NOT add
    // cache_read on top, matching the OpenAI billing model and staying
    // consistent with the Anthropic path's non-double-counting.
    expect((done as any).usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 60,
    });
  });

  it("emits tool_use before done and parses arguments", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "read", arguments: '{"filePath":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]),
    );

    const caller = createModelCaller(config);
    const events: StreamEvent[] = [];
    for await (const e of caller(messages, [], "sys", config)) {
      events.push(e);
    }

    const toolUse = events.find((e) => e.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as any).name).toBe("read");
    expect((toolUse as any).input).toEqual({ filePath: "a.txt" });

    const toolUseIdx = events.findIndex((e) => e.type === "tool_use");
    const doneIdx = events.findIndex((e) => e.type === "done");
    expect(toolUseIdx).toBeLessThan(doneIdx);
    // Tool call must be emitted exactly once.
    expect(events.filter((e) => e.type === "tool_use").length).toBe(1);
  });

  // ============================================================
  // Top10 follow-up A12: OpenAI reasoning-model request shape and
  // the previously-dropped reasoning_content stream.
  // ============================================================

  it("o-series on provider=openai sends max_completion_tokens, not max_tokens", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
    );
    const cfg: ModelConfig = { ...config, model: "o3-mini" };
    for await (const _e of createModelCaller(cfg)(messages, [], "sys", cfg)) {
      // drain
    }
    const params = createSpy.mock.calls[0][0];
    expect(params.max_completion_tokens).toBeGreaterThan(0);
    expect(params.max_tokens).toBeUndefined();
    // Reasoning models reject temperature — must be omitted.
    expect(params.temperature).toBeUndefined();
  });

  it("third-party reasoners keep max_tokens (the switch is OpenAI-official-only)", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
    );
    const cfg: ModelConfig = { provider: "deepseek", model: "deepseek-reasoner", apiKey: "k" };
    for await (const _e of createModelCaller(cfg)(messages, [], "sys", cfg)) {
      // drain
    }
    const params = createSpy.mock.calls[0][0];
    expect(params.max_tokens).toBeGreaterThan(0);
    expect(params.max_completion_tokens).toBeUndefined();
  });

  it("maps delta.reasoning_content onto thinking events (was: silently dropped)", async () => {
    createSpy.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { reasoning_content: "let me " }, finish_reason: null }] },
        { choices: [{ delta: { reasoning_content: "think..." }, finish_reason: null }] },
        { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ]),
    );
    const events: StreamEvent[] = [];
    for await (const e of createModelCaller(config)(messages, [], "sys", config)) {
      events.push(e);
    }
    const thinking = events.filter((e) => e.type === "thinking").map((e) => (e as any).delta);
    expect(thinking).toEqual(["let me ", "think..."]);
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as any).delta);
    expect(text).toEqual(["answer"]);
  });

  it("converts a legacy PDF to text and image_url PNGs before calling the provider", async () => {
    createSpy.mockResolvedValue(makeStream([]));
    const pdfMessages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: makePdf().toString("base64"),
            },
          } as any,
        ],
      },
    ];
    for await (const _e of createModelCaller(config)(pdfMessages, [], "sys", config)) {
      /* drain */
    }
    expect(createSpy).toHaveBeenCalledOnce();
    const request = JSON.stringify(createSpy.mock.calls[0][0].messages);
    expect(request).toContain("Page 1 content");
    expect(request).toContain("data:image/png;base64,");
    expect(request).not.toContain("application/pdf");
  });

  it("omits old image attachments on text-only models and still sends the follow-up", async () => {
    createSpy.mockResolvedValue(makeStream([]));
    const cfg: ModelConfig = { provider: "deepseek", model: "deepseek-chat", apiKey: "test" };
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      },
      ...messages,
    ];
    for await (const _e of createModelCaller(cfg)(history, [], "sys", cfg)) {
      /* drain */
    }
    const request = JSON.stringify(createSpy.mock.calls[0][0].messages);
    expect(request).not.toContain("image_url");
    expect(request).toContain("has not been inspected");
    expect(request).toContain("hi");
  });
});
