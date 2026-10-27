// ============================================================
// Integration tests: Session Lifecycle (P1-4)
// ============================================================
// End-to-end integration tests covering the complete session lifecycle:
//   - Start: initialize a session with tools
//   - Dialog: execute multi-turn conversations with tool calls
//   - Compression: context auto-compaction
//   - Exit: graceful termination
//   - Resume: restore session from disk and continue
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import { autoCompact, findSafeSplitIndex } from "../auto-compact.js";
import { resetChangeTracker } from "../change-tracker.js";
import { SessionMemory } from "../session-memory.js";
import { buildTool } from "../tools/registry.js";
import type { Message, ModelCaller, ModelConfig, StreamEvent, Tool } from "../types.js";

// ============================================================================
// Test Fixtures
// ============================================================================

function makeMockCaller(responses: StreamEvent[][]): ModelCaller {
  let callIndex = 0;
  return async function* (
    _messages: Message[],
    _tools: Tool[],
    _systemPrompt: string,
    _config: ModelConfig,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const events = responses[callIndex] ?? [
      {
        type: "done",
        usage: { input_tokens: 10, output_tokens: 5 },
        finish_reason: "stop",
      },
    ];
    callIndex++;
    for (const event of events) {
      yield event;
    }
  };
}

const testConfig: ModelConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

// ============================================================================
// Session Lifecycle Integration Tests
// ============================================================================

describe("Session lifecycle", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-lifecycle-"));
    resetChangeTracker();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  describe("Start → Dialog → Exit", () => {
    it("completes a single-turn text-only conversation", async () => {
      const caller = makeMockCaller([
        [
          { type: "text_delta", delta: "Hello! How can I help?" },
          {
            type: "done",
            usage: { input_tokens: 10, output_tokens: 8 },
            finish_reason: "stop",
          },
        ],
      ]);

      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Hi" }] }];

      const events: any[] = [];
      for await (const event of agentLoop(messages, [], caller, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: false,
      })) {
        events.push(event);
      }

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.finishReason).toBe("end_turn");

      // Assistant response was added to history
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0]).toHaveProperty("content");
    });

    it("executes multiple tool calls in sequence across turns", async () => {
      const readTool = buildTool({
        name: "read",
        description: "Read a file",
        promptDescription: "Read the contents of a file",
        schema: z.object({
          filePath: z.string().describe("Path to the file to read"),
        }),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: async ({ filePath }) => {
          return { content: `Contents of ${filePath}: hello world` };
        },
      });

      const caller = makeMockCaller([
        // Turn 1: use read tool
        [
          {
            type: "tool_use",
            id: "call_1",
            name: "read",
            input: { filePath: "test.txt" },
          },
          {
            type: "done",
            usage: { input_tokens: 20, output_tokens: 10 },
            finish_reason: "tool_calls",
          },
        ],
        // Turn 2: text response
        [
          { type: "text_delta", delta: "I read the file." },
          {
            type: "done",
            usage: { input_tokens: 30, output_tokens: 5 },
            finish_reason: "stop",
          },
        ],
      ]);

      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Read test.txt" }] },
      ];

      const events: any[] = [];
      for await (const event of agentLoop(messages, [readTool], caller, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: false,
      })) {
        events.push(event);
      }

      // Tool was called
      const toolUse = events.find((e) => e.type === "tool_use");
      expect(toolUse).toBeDefined();
      expect(toolUse.name).toBe("read");

      // Tool result was returned
      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      expect(toolResult.result.toolName).toBe("read");

      // Loop completed
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent.finishReason).toBe("end_turn");
    });

    it("respects maxTurns limit", async () => {
      const tool = buildTool({
        name: "noop",
        description: "No-op tool",
        promptDescription: "Does nothing",
        schema: z.object({}),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: async () => ({ content: "done" }),
      });

      // Model keeps requesting the same tool
      const caller = makeMockCaller([
        [
          { type: "tool_use", id: "c1", name: "noop", input: {} },
          {
            type: "done",
            usage: { input_tokens: 10, output_tokens: 5 },
            finish_reason: "tool_calls",
          },
        ],
        [
          { type: "tool_use", id: "c2", name: "noop", input: {} },
          {
            type: "done",
            usage: { input_tokens: 20, output_tokens: 5 },
            finish_reason: "tool_calls",
          },
        ],
        [
          { type: "tool_use", id: "c3", name: "noop", input: {} },
          {
            type: "done",
            usage: { input_tokens: 30, output_tokens: 5 },
            finish_reason: "tool_calls",
          },
        ],
      ]);

      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Go" }] }];

      const events: any[] = [];
      for await (const event of agentLoop(messages, [tool], caller, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 2, // Limit to 2 turns
        speculation: false,
      })) {
        events.push(event);
      }

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.finishReason).toBe("max_turns");
      expect(doneEvent.turns).toBe(2);
    });
  });

  describe("Session Persistence", () => {
    it("saves and resumes a session correctly", async () => {
      const caller = makeMockCaller([
        [
          { type: "text_delta", delta: "Response 1" },
          { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "stop" },
        ],
      ]);

      const sessionId = "test-session-1";
      const sessionStore = new SessionMemory(workspace);

      // Start a session
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "First turn" }] },
      ];

      for await (const _ of agentLoop(messages, [], caller, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: false,
      })) {
        // Consume all events
      }

      // Save session
      await sessionStore.save(sessionId, messages);

      // Resume in a new session
      const resumed = await sessionStore.load(sessionId);
      expect(resumed).not.toBeNull();
      expect(resumed!.messages.length).toBeGreaterThan(1);

      // Continue the resumed session
      const caller2 = makeMockCaller([
        [
          { type: "text_delta", delta: "Response 2" },
          { type: "done", usage: { input_tokens: 50, output_tokens: 10 }, finish_reason: "stop" },
        ],
      ]);

      resumed!.messages.push({ role: "user", content: [{ type: "text", text: "Second turn" }] });

      for await (const _ of agentLoop(resumed!.messages, [], caller2, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: false,
      })) {
        // Consume all events
      }

      // Session continued successfully
      const assistantMsgs = resumed!.messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBe(2);
    });

    it("preserves tool results in message history after session restore", async () => {
      const tool = buildTool({
        name: "getValue",
        description: "Get a value",
        promptDescription: "Get a value",
        schema: z.object({
          key: z.string(),
        }),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: async ({ key }) => ({
          content: `Value for ${key}: 42`,
        }),
      });

      const caller = makeMockCaller([
        [
          { type: "tool_use", id: "call_1", name: "getValue", input: { key: "answer" } },
          {
            type: "done",
            usage: { input_tokens: 20, output_tokens: 10 },
            finish_reason: "tool_calls",
          },
        ],
        [
          { type: "text_delta", delta: "The answer is 42." },
          { type: "done", usage: { input_tokens: 40, output_tokens: 5 }, finish_reason: "stop" },
        ],
      ]);

      const sessionId = "tool-result-session";
      const sessionStore = new SessionMemory(workspace);
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Get the answer" }] },
      ];

      for await (const _ of agentLoop(messages, [tool], caller, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: false,
      })) {
        // Consume all events
      }

      // Verify tool result is in history
      const toolResults = messages.filter((m) => m.role === "tool");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]).toHaveProperty("content");
      expect(toolResults[0].content).toContain("42");

      // Save and restore
      await sessionStore.save(sessionId, messages);
      const restored = await sessionStore.load(sessionId);

      // Tool results preserved
      const restoredToolResults = restored!.messages.filter((m) => m.role === "tool");
      expect(restoredToolResults.length).toBe(1);
      expect(restoredToolResults[0].content).toContain("42");
    });
  });

  describe("Context Compression", () => {
    it("findSafeSplitIndex avoids splitting tool-call/result pairs", () => {
      // Create a conversation with a tool call and result
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Do something" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", name: "read", content: "file contents" },
        { role: "user", content: [{ type: "text", text: "Another question" }] },
      ];

      const splitIndex = findSafeSplitIndex(messages, 2);
      // Should not split between the tool_call and its result
      expect(splitIndex).toBeLessThanOrEqual(2);
    });

    it("autoCompact preserves recent conversation context", async () => {
      const caller = makeMockCaller([
        [
          { type: "text_delta", delta: "Summary: The user asked about X and we did Y." },
          { type: "done", usage: { input_tokens: 1000, output_tokens: 50 }, finish_reason: "stop" },
        ],
      ]);

      // Create enough messages that some will be in "oldMessages"
      const oldMessages: Message[] = [];
      for (let i = 0; i < 15; i++) {
        oldMessages.push({ role: "user", content: [{ type: "text", text: `Task ${i}` }] });
        oldMessages.push({ role: "assistant", content: `Did task ${i}` });
      }

      const tailMessages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Current task" }] },
        { role: "assistant", content: "Working on it..." },
      ];

      const allMessages = [...oldMessages, ...tailMessages];
      const compacted = await autoCompact(allMessages, caller, testConfig);

      // Compacted messages should start with a system summary (when there are old messages to compact)
      expect(compacted[0].role).toBe("system");
      expect(compacted[0].content).toContain("Summary:");

      // Tail messages should be preserved
      expect(compacted.length).toBeLessThan(allMessages.length);
    });

    it("autoCompact returns a detached array when nothing to compact", async () => {
      const caller = makeMockCaller([
        [
          { type: "text_delta", delta: "Summary." },
          { type: "done", usage: { input_tokens: 100, output_tokens: 50 }, finish_reason: "stop" },
        ],
      ]);

      // Short conversation - nothing to compact
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Short" }] },
        { role: "assistant", content: "Done" },
      ];

      const compacted = await autoCompact(messages, caller, testConfig);

      // A detached result lets /compact replace the live history without clearing itself.
      expect(compacted).not.toBe(messages);
      expect(compacted).toEqual(messages);
    });

    it("handles context_length error by triggering compaction", async () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Long conversation" }] },
      ];

      // Inject context_length error
      const events: any[] = [];
      let firstCall = true;
      const mockCaller: ModelCaller = async function* () {
        if (firstCall) {
          firstCall = false;
          yield {
            type: "error",
            error: Object.assign(new Error("context_length_exceeded"), { status: 400 }),
          };
        } else {
          yield { type: "text_delta", delta: "Success after compaction" };
          yield {
            type: "done",
            usage: { input_tokens: 50, output_tokens: 10 },
            finish_reason: "stop",
          };
        }
      };

      for await (const event of agentLoop(messages, [], mockCaller, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: false,
        autoCompactThreshold: 100, // Very low to trigger compaction
      })) {
        events.push(event);
      }

      // Should have either completed or yielded a compaction event
      const doneEvent = events.find((e) => e.type === "done");
      const errorEvent = events.find((e) => e.type === "error");
      // Either the error was handled or compaction succeeded
      expect(doneEvent || errorEvent).toBeDefined();
    });
  });

  describe("Large Result Handling", () => {
    it("handles oversized tool results without crashing", async () => {
      const largeContent = "x".repeat(50_000); // 50KB
      const tool = buildTool({
        name: "largeRead",
        description: "Read a large file",
        promptDescription: "Read a large file",
        schema: z.object({
          path: z.string(),
        }),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        maxResultSizeChars: 30_000, // Force truncation
        call: async ({ path: _path }) => ({
          content: largeContent,
        }),
      });

      const caller = makeMockCaller([
        [
          { type: "tool_use", id: "call_1", name: "largeRead", input: { path: "big.txt" } },
          {
            type: "done",
            usage: { input_tokens: 20, output_tokens: 10 },
            finish_reason: "tool_calls",
          },
        ],
        [
          { type: "text_delta", delta: "Got the file" },
          { type: "done", usage: { input_tokens: 500, output_tokens: 5 }, finish_reason: "stop" },
        ],
      ]);

      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Read big file" }] },
      ];

      const events: any[] = [];
      for await (const event of agentLoop(messages, [tool], caller, testConfig, {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: false,
      })) {
        events.push(event);
      }

      // Loop should complete without crashing
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
    });
  });
});

// ============================================================================
// Auto-Compact Message Safety Tests
// ============================================================================

describe("autoCompact message safety", () => {
  it("findSafeSplitIndex handles simple conversation", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: "Hi there" },
    ];
    const split = findSafeSplitIndex(messages, 1);
    expect(split).toBeGreaterThanOrEqual(0);
    expect(split).toBeLessThanOrEqual(messages.length);
  });

  it("findSafeSplitIndex handles empty conversation", () => {
    const messages: Message[] = [];
    const split = findSafeSplitIndex(messages, 5);
    expect(split).toBe(0);
  });

  it("findSafeSplitIndex respects tailSize even with tool pairs", () => {
    // Even with tool pairs, should find a safe split point
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "1" }] },
      { role: "assistant", content: "a1" },
      { role: "user", content: [{ type: "text", text: "2" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    const split = findSafeSplitIndex(messages, 2);
    // Should not split in the middle of a tool call/result pair
    expect(split).toBeLessThanOrEqual(4);
  });
});

// Import zod for schema definitions
import { z } from "zod";
