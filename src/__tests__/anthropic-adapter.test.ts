// ============================================================
// Tests: Native Anthropic adapter
// ============================================================

import { describe, expect, it } from "vitest";
import {
  convertMessagesToAnthropic,
  formatSystemForAnthropic,
  formatToolsForAnthropic,
} from "../anthropic-adapter.js";
import { createModelCaller } from "../llm-adapter.js";
import { buildSystemPrompt, DYNAMIC_BOUNDARY } from "../system-prompt.js";
import type { Message, ModelConfig, Tool } from "../types.js";

const testTool: Tool = {
  name: "read",
  description: "Read",
  promptDescription: "Read a file",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path" },
    },
    required: ["filePath"],
  },
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async () => ({ content: "ok" }),
  checkPermissions: async () => ({ allowed: true }),
  formatResult: (r) => r.content,
};

const anthropicConfig: ModelConfig = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKey: "test-key",
};

const openaiConfig: ModelConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

describe("formatSystemForAnthropic", () => {
  it("splits stable and dynamic sections and caches only the stable prefix", () => {
    const prompt = `stable instructions\n\n${DYNAMIC_BOUNDARY}\nvolatile workspace`;
    const system = formatSystemForAnthropic(prompt) as any[];

    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({
      type: "text",
      text: "stable instructions",
      cache_control: { type: "ephemeral" },
    });
    expect(system[1]).toEqual({
      type: "text",
      text: `${DYNAMIC_BOUNDARY}\nvolatile workspace`,
    });
  });

  it("adds cache_control when no dynamic boundary exists", () => {
    const system = formatSystemForAnthropic("all stable") as any[];
    expect(system).toEqual([
      {
        type: "text",
        text: "all stable",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("works with the real system prompt builder", () => {
    const prompt = buildSystemPrompt({ workspaceRoot: "/tmp/project", tools: [] });
    const system = formatSystemForAnthropic(prompt) as any[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text).not.toContain(DYNAMIC_BOUNDARY);
    expect(system[1].text).toContain(DYNAMIC_BOUNDARY);
  });
});

describe("convertMessagesToAnthropic", () => {
  it("converts user text/image content", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc",
            },
          },
        ],
      },
    ];

    expect(convertMessagesToAnthropic(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "abc" },
          },
        ],
      },
    ]);
  });

  it("converts assistant tool_calls to tool_use blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "I'll read it.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"filePath":"a.txt"}' },
          },
        ],
      },
    ];

    expect(convertMessagesToAnthropic(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read it." },
          {
            type: "tool_use",
            id: "call_1",
            name: "read",
            input: { filePath: "a.txt" },
          },
        ],
      },
    ]);
  });

  it("degrades malformed tool-call arguments to an empty input instead of throwing", () => {
    // Regression: a truncated/garbled arguments string (rare but possible
    // mid-stream / after a provider hiccup) must not crash the adapter.
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "read", arguments: "{not valid json" },
          },
        ],
      },
    ];

    const converted = convertMessagesToAnthropic(messages) as any[];
    expect(converted).toHaveLength(1);
    const block = converted[0].content[0];
    expect(block.type).toBe("tool_use");
    expect(block.id).toBe("call_bad");
    expect(block.name).toBe("read");
    expect(block.input).toEqual({});
  });

  it("treats empty tool-call arguments as an empty input", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_empty",
            type: "function",
            function: { name: "read", arguments: "" },
          },
        ],
      },
    ];

    const converted = convertMessagesToAnthropic(messages) as any[];
    expect(converted[0].content[0].input).toEqual({});
  });

  it("converts tool results to user tool_result blocks", () => {
    const messages: Message[] = [
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read",
        content: "file contents",
      },
    ];

    expect(convertMessagesToAnthropic(messages)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "file contents",
          },
        ],
      },
    ]);
  });

  it("merges adjacent same-role messages for Anthropic", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "user", content: [{ type: "text", text: "two" }] },
    ];

    expect(convertMessagesToAnthropic(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    ]);
  });

  it("converts base64 PDFs to document blocks, images to image blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "application/pdf", data: "pdfdata" },
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "pngdata" },
          },
        ],
      },
    ];

    const [msg] = convertMessagesToAnthropic(messages) as any[];
    expect(msg.content[0].type).toBe("document");
    expect(msg.content[0].source.media_type).toBe("application/pdf");
    expect(msg.content[1].type).toBe("image");
    expect(msg.content[1].source.media_type).toBe("image/png");
  });
});

describe("formatToolsForAnthropic", () => {
  it("uses input_schema and prompt description", () => {
    expect(formatToolsForAnthropic([testTool])).toEqual([
      {
        name: "read",
        description: "Read a file",
        input_schema: testTool.inputSchema,
        // 12.3: the last (here only) tool carries a cache breakpoint.
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
});

describe("createModelCaller routing", () => {
  it("returns different callers for anthropic and openai-compatible providers", () => {
    expect(createModelCaller(anthropicConfig)).not.toBe(createModelCaller(openaiConfig));
  });
});
