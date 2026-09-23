// ============================================================
// Tests: Anthropic adapter early tool_use emission (P1)
// ============================================================
// tool_use blocks must be yielded at their content_block_stop boundary
// (arguments complete) so the agent loop's StreamingToolExecutor can start
// safe tools while the model still streams — not only after finalMessage().
// Blocks re-emitted from finalMessage() would double-fire the executor, so
// the adapter dedupes by tool_use id.
// ============================================================

import { describe, expect, it, vi } from "vitest";

// The fake SDK stream: an async-iterable of raw Anthropic stream events plus
// the handful of methods anthropicCaller touches (on/controller/finalMessage).
type FakeEvent = Record<string, unknown> & { type: string };

function makeFakeStream(events: FakeEvent[], finalContent: unknown[]) {
  return {
    on: (_name: string, _cb: (t: string) => void) => {},
    controller: { abort: () => {} },
    finalMessage: async () => ({
      content: finalContent,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

let nextStream: ReturnType<typeof makeFakeStream> | null = null;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class FakeAnthropic {
      messages = {
        stream: () => {
          if (!nextStream) throw new Error("test bug: no fake stream configured");
          return nextStream;
        },
      };
    },
  };
});

// Mock the cache-break diagnostics so the adapter's prompt-state recording
// doesn't reach for a real DEBUG env surface.
vi.mock("../prompt-cache.js", () => ({
  recordPromptState: () => {},
  checkResponseForCacheBreak: () => undefined,
}));

import { createModelCaller } from "../llm-adapter.js";
import type { Message, ModelConfig, StreamEvent } from "../types.js";

const anthropicConfig: ModelConfig = {
  provider: "anthropic",
  model: "claude-test",
  apiKey: "test-key",
};

async function collect(
  caller: (m: Message[], t: never[], s: string, c: ModelConfig) => AsyncGenerator<StreamEvent>,
) {
  const out: StreamEvent[] = [];
  for await (const event of caller([], [], "", anthropicConfig)) {
    out.push(event);
  }
  return out;
}

const events = (...es: FakeEvent[]): FakeEvent[] => es;

describe("anthropicCaller early tool_use emission (P1)", () => {
  it("emits tool_use at the content_block_stop boundary, before done", async () => {
    nextStream = makeFakeStream(
      events(
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Let me check " },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu_1", name: "read" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"filePa' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: 'th":"a.ts"}' },
        },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "text" } },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "…meanwhile" },
        },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      ),
      [
        { type: "text", text: "Let me check …meanwhile" },
        { type: "tool_use", id: "tu_1", name: "read", input: { filePath: "a.ts" } },
      ],
    );
    const out = await collect(createModelCaller(anthropicConfig) as never);
    const toolIdx = out.findIndex((e) => e.type === "tool_use");
    const trailingTextIdx = out.findIndex(
      (e) => e.type === "text_delta" && e.delta === "…meanwhile",
    );
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    // The early emission must precede text the model streams AFTER the block.
    expect(toolIdx).toBeLessThan(trailingTextIdx);
    const toolEvent = out[toolIdx];
    if (toolEvent.type === "tool_use") {
      expect(toolEvent.id).toBe("tu_1");
      expect(toolEvent.name).toBe("read");
      expect(toolEvent.input).toEqual({ filePath: "a.ts" });
    } else {
      throw new Error("expected tool_use event");
    }
    // Exactly one emission for tu_1 (finalMessage dedupe).
    expect(out.filter((e) => e.type === "tool_use")).toHaveLength(1);
  });

  it("handles two interleaved tool blocks by stream index", async () => {
    nextStream = makeFakeStream(
      events(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_a", name: "glob" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"pattern":"*.ts"}' },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu_b", name: "grep" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"pattern":"foo"}' },
        },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_stop", index: 0 },
      ),
      [],
    );
    const out = await collect(createModelCaller(anthropicConfig) as never);
    const toolUses = out.filter((e) => e.type === "tool_use");
    expect(toolUses).toHaveLength(2);
    // Emission order follows block completion, not start.
    if (toolUses[0]?.type === "tool_use" && toolUses[1]?.type === "tool_use") {
      expect(toolUses[0].id).toBe("tu_b");
      expect(toolUses[1].id).toBe("tu_a");
    }
  });

  it("falls back to finalMessage when boundary JSON is malformed", async () => {
    nextStream = makeFakeStream(
      events(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_bad", name: "bash" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"broken' },
        },
        { type: "content_block_stop", index: 0 },
      ),
      [{ type: "tool_use", id: "tu_bad", name: "bash", input: { command: "ls" } }],
    );
    const out = await collect(createModelCaller(anthropicConfig) as never);
    const toolUses = out.filter((e) => e.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    if (toolUses[0]?.type === "tool_use") {
      expect(toolUses[0].id).toBe("tu_bad");
      expect(toolUses[0].input).toEqual({ command: "ls" });
    }
  });

  it("emits an empty-input tool_use when the block carries no deltas", async () => {
    nextStream = makeFakeStream(
      events(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_empty", name: "todo" },
        },
        { type: "content_block_stop", index: 0 },
      ),
      [{ type: "tool_use", id: "tu_empty", name: "todo", input: {} }],
    );
    const out = await collect(createModelCaller(anthropicConfig) as never);
    const toolUses = out.filter((e) => e.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    if (toolUses[0]?.type === "tool_use") {
      expect(toolUses[0].input).toEqual({});
    }
  });

  it("uses the start block's complete input when a relay sends no deltas", async () => {
    // Buffered Anthropic-compatible relays may emit the FULL arguments in
    // content_block_start and skip input_json_delta entirely. The boundary
    // emission must fall back to that input instead of parsing an empty
    // buffer into {} — and the finalMessage dedupe must not be needed.
    nextStream = makeFakeStream(
      events(
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tu_relay",
            name: "bash",
            input: { command: "ls -la" },
          },
        },
        { type: "content_block_stop", index: 0 },
      ),
      [{ type: "tool_use", id: "tu_relay", name: "bash", input: { command: "ls -la" } }],
    );
    const out = await collect(createModelCaller(anthropicConfig) as never);
    const toolUses = out.filter((e) => e.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    if (toolUses[0]?.type === "tool_use") {
      expect(toolUses[0].id).toBe("tu_relay");
      expect(toolUses[0].input).toEqual({ command: "ls -la" });
    }
  });
});
