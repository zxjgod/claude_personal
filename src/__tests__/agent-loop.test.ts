// ============================================================
// Tests: Agent Loop
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentLoop } from "../agent-loop.js";
import { buildTool } from "../tools/registry.js";
import { SPILL_DIR } from "../tools/result-spill.js";
import type { Message, ModelCaller, ModelConfig, StreamEvent, Tool } from "../types.js";

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

describe("agentLoop", () => {
  it("should yield done event for simple text response", async () => {
    const caller = makeMockCaller([
      [
        { type: "text_delta", delta: "Hello" },
        { type: "text_delta", delta: " world" },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
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
  });

  it("should execute tool calls and continue", async () => {
    const tool: Tool = {
      name: "echo",
      description: "Echo",
      promptDescription: "Echo a message back",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message to echo" },
        },
        required: ["message"],
      },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (input) => {
        return { content: `Echo: ${input.message}` };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const caller = makeMockCaller([
      // First call: use the echo tool
      [
        {
          type: "tool_use",
          id: "call_1",
          name: "echo",
          input: { message: "test" },
        },
        {
          type: "done",
          usage: { input_tokens: 20, output_tokens: 10 },
          finish_reason: "tool_calls",
        },
      ],
      // Second call: text response after tool results
      [
        { type: "text_delta", delta: "Got echo" },
        {
          type: "done",
          usage: { input_tokens: 30, output_tokens: 5 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Echo test" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [tool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      speculation: false,
    })) {
      events.push(event);
    }

    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    const toolResultEvents = events.filter((e) => e.type === "tool_results");

    expect(toolUseEvents.length).toBeGreaterThan(0);
    expect(toolResultEvents.length).toBeGreaterThan(0);
  });

  it("streams a per-tool tool_result as each finishes, then a batch", async () => {
    // Two parallel-safe tools. The first resolves slowly, the second fast,
    // so the fast one's tool_result must arrive first (completion order),
    // while the batch tool_results stays in call order.
    const makeTool = (name: string, delay: number): Tool => ({
      name,
      description: name,
      promptDescription: name,
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => {
        await new Promise((r) => setTimeout(r, delay));
        return { content: `${name} done` };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    });

    const slow = makeTool("slow", 30);
    const fast = makeTool("fast", 1);

    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "call_slow", name: "slow", input: {} },
        { type: "tool_use", id: "call_fast", name: "fast", input: {} },
        {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "ok" },
        {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [slow, fast], caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
    })) {
      events.push(event);
    }

    const streamed = events.filter((e) => e.type === "tool_result");
    expect(streamed).toHaveLength(2);
    // Fast tool finishes first → its per-tool result is emitted first.
    expect(streamed[0].id).toBe("call_fast");
    expect(streamed[1].id).toBe("call_slow");

    // The batch event still arrives once, in original call order.
    const batch = events.find((e) => e.type === "tool_results");
    expect(batch.results.map((r: any) => r.toolName)).toEqual(["slow", "fast"]);
  });

  it("should stop at maxTurns", async () => {
    const tool: Tool = {
      name: "loop",
      description: "Loop",
      promptDescription: "Loops forever",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "looping" }),
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    // Always return a tool call
    const caller = makeMockCaller(
      Array.from({ length: 10 }, () => [
        {
          type: "tool_use",
          id: "call_1",
          name: "loop",
          input: {},
        },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ]),
    );

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Loop" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [tool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 3,
      speculation: false,
    })) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.finishReason).toBe("max_turns");
  });

  it("should handle unknown tool gracefully", async () => {
    const caller = makeMockCaller([
      [
        {
          type: "tool_use",
          id: "call_1",
          name: "nonexistent_tool",
          input: {},
        },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "Done" },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 2 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Test" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      speculation: false,
    })) {
      events.push(event);
    }

    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults).toBeDefined();
    expect(toolResults.results[0].error).toContain("Unknown tool");
  });

  it("should NOT execute a tool when permission is denied", async () => {
    let executed = false;
    const writeTool: Tool = {
      name: "write",
      description: "Write",
      promptDescription: "Write a file",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "path" },
        },
        required: ["filePath"],
      },
      isEnabled: () => true,
      isReadOnly: () => false, // destructive → goes through permission check
      isConcurrencySafe: () => false,
      call: async () => {
        executed = true;
        return { content: "written" };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const caller = makeMockCaller([
      [
        {
          type: "tool_use",
          id: "call_1",
          name: "write",
          input: { filePath: "a.txt" },
        },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "ok" },
        {
          type: "done",
          usage: { input_tokens: 5, output_tokens: 2 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "write" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [writeTool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      askUser: async () => false, // user denies
    })) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults.results[0].formatted).toContain("Permission denied");
  });

  it("should block destructive tools in plan mode", async () => {
    let executed = false;
    const writeTool: Tool = {
      name: "write",
      description: "Write",
      promptDescription: "Write a file",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string", description: "path" } },
        required: ["filePath"],
      },
      isEnabled: () => true,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      call: async () => {
        executed = true;
        return { content: "written" };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const caller = makeMockCaller([
      [
        {
          type: "tool_use",
          id: "call_1",
          name: "write",
          input: { filePath: "a.txt" },
        },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "ok" },
        {
          type: "done",
          usage: { input_tokens: 5, output_tokens: 2 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "write" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [writeTool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      toolContext: { permissionMode: "plan" },
      // askUser would allow, but plan mode must block before asking.
      askUser: async () => true,
    })) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults.results[0].formatted).toContain("Permission denied");
  });

  it("refuses a tool when its own checkPermissions denies (tool-level policy wins)", async () => {
    // Regression: tool.checkPermissions was previously dead code — executeSingleTool
    // only called the system-level checkPermission. Now both run, and a tool-level
    // denial must block execution WITHOUT invoking askUser (hard policy).
    let executed = false;
    const askUser = vi.fn().mockResolvedValue(true); // user would allow
    const bashTool: Tool = {
      name: "bash",
      description: "Bash",
      promptDescription: "Run a command",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      call: async () => {
        executed = true;
        return { content: "ran" };
      },
      formatResult: (r) => r.content,
      // Tool-level hard policy: refuse the dangerous command outright.
      checkPermissions: async () => ({
        allowed: false,
        reason: "rm -r refused by bash policy",
      }),
    };

    const caller = makeMockCaller([
      [
        {
          type: "tool_use",
          id: "call_1",
          name: "bash",
          input: { command: "rm -rf /tmp/x" },
        },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "ok" },
        {
          type: "done",
          usage: { input_tokens: 5, output_tokens: 2 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "rm" }] }];
    const events: any[] = [];
    for await (const event of agentLoop(messages, [bashTool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      askUser,
    })) {
      events.push(event);
    }

    // Tool-level policy blocked execution; system-level askUser never reached.
    expect(executed).toBe(false);
    expect(askUser).not.toHaveBeenCalled();
    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults.results[0].formatted).toContain("Permission denied");
  });

  it("should pass toolContext (sessionId/workspaceRoot) into tool.call", async () => {
    let received: any = null;
    const probeTool: Tool = {
      name: "probe",
      description: "Probe",
      promptDescription: "Reports its context",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (_input, context) => {
        received = context;
        return { content: "ok" };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "call_1", name: "probe", input: {} },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "done" },
        {
          type: "done",
          usage: { input_tokens: 5, output_tokens: 2 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "probe" }] }];

    const onSubAgentProgress = vi.fn();
    for await (const _event of agentLoop(messages, [probeTool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      toolContext: {
        workspaceRoot: "/custom/workspace",
        sessionId: "session-xyz",
        permissionMode: "default",
        onSubAgentProgress,
      },
    })) {
      // drain
    }

    expect(received).not.toBeNull();
    expect(received.workspaceRoot).toBe("/custom/workspace");
    expect(received.sessionId).toBe("session-xyz");
    expect(received.onSubAgentProgress).toBe(onSubAgentProgress);
  });

  it("PreToolUse hook can block a tool call before execution", async () => {
    let executed = false;
    const tool: Tool = {
      name: "bash",
      description: "Bash",
      promptDescription: "Run a command",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => {
        executed = true;
        return { content: "ran" };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "call_1", name: "bash", input: {} },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "ok" },
        {
          type: "done",
          usage: { input_tokens: 5, output_tokens: 2 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "run" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [tool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      hooks: {
        runPre: async () => ({ block: true, reason: "blocked in test" }),
        runPost: async ({ result }) => ({ result }),
      },
    })) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults.results[0].error).toContain("blocked in test");
  });

  it("PostToolUse hook can rewrite the tool result", async () => {
    const tool: Tool = {
      name: "read",
      description: "Read",
      promptDescription: "Read a file",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "original" }),
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "call_1", name: "read", input: {} },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "ok" },
        {
          type: "done",
          usage: { input_tokens: 5, output_tokens: 2 },
          finish_reason: "stop",
        },
      ],
    ]);

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "read" }] }];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [tool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      hooks: {
        runPre: async ({ input }) => ({ input }),
        runPost: async () => ({ result: { content: "redacted" } }),
      },
    })) {
      events.push(event);
    }

    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults.results[0].formatted).toBe("redacted");
  });

  // M15.2: speculation is on by default and the done event carries a stats
  // snapshot. The model issues a grep, the loop prefetches the predicted Read
  // in the background, the model then actually Reads that file → a spec hit.
  it("attaches speculation stats to done when enabled, with at least one hit", async () => {
    // A read tool whose result the loop will prefetch after the grep.
    const readTool: Tool = {
      name: "read",
      description: "Read",
      promptDescription: "Read a file",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (input) => ({ content: `body of ${input.filePath}` }),
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    const grepTool: Tool = {
      name: "grep",
      description: "Grep",
      promptDescription: "Search",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "src/a.ts:12:  const x" }),
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "g1", name: "grep", input: { pattern: "x" } },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "tool_use", id: "r1", name: "read", input: { filePath: "src/a.ts" } },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);

    const events: any[] = [];
    for await (const event of agentLoop(
      messages("search"),
      [readTool, grepTool],
      caller,
      testConfig,
      {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        speculation: true,
      },
    )) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent.speculation).toBeDefined();
    expect(doneEvent.speculation.prefetched).toBeGreaterThanOrEqual(1);
    expect(doneEvent.speculation.hits).toBeGreaterThanOrEqual(1);
    expect(doneEvent.speculation.hitRate).toBeGreaterThan(0);
  });

  it("does NOT attach speculation stats when speculation is off", async () => {
    const caller = makeMockCaller([
      [
        { type: "text_delta", delta: "hi" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);
    const events: any[] = [];
    for await (const event of agentLoop(messages("hi"), [], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      speculation: false,
    })) {
      events.push(event);
    }
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent.speculation).toBeUndefined();
  });

  // Default-on: omitting speculation must still produce a stats field (it will
  // be prefetched=0 since no search ran, but the field is present).
  it("defaults speculation on when the option is omitted", async () => {
    const caller = makeMockCaller([
      [
        { type: "text_delta", delta: "hi" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);
    const events: any[] = [];
    for await (const event of agentLoop(messages("hi"), [], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
    })) {
      events.push(event);
    }
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent.speculation).toBeDefined();
    expect(doneEvent.speculation.prefetched).toBe(0);
  });

  // ------------------------------------------------------------------
  // Stability hardening: abort propagation
  // ------------------------------------------------------------------

  it("yields an aborted event when the abort signal fires before the loop runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const caller = makeMockCaller([
      [
        { type: "text_delta", delta: "hi" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);

    const events: any[] = [];
    for await (const event of agentLoop(messages("hi"), [], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    const aborted = events.find((e) => e.type === "aborted");
    expect(aborted).toBeDefined();
    // The mock caller must never have been invoked.
    const done = events.find((e) => e.type === "done");
    expect(done).toBeUndefined();
  });

  it("short-circuits pending parallel tool calls when abort fires mid-batch", async () => {
    let slowStarted = false;
    let slowFinished = false;
    const slow: Tool = {
      name: "slow",
      description: "slow",
      promptDescription: "slow",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => {
        slowStarted = true;
        await new Promise((r) => setTimeout(r, 500));
        slowFinished = true;
        return { content: "slow done" };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    const fast: Tool = {
      name: "fast",
      description: "fast",
      promptDescription: "fast",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => {
        // Abort right after the fast tool starts, so the slow one is still pending.
        controller.abort();
        return { content: "fast done" };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };

    const controller = new AbortController();
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "call_slow", name: "slow", input: {} },
        { type: "tool_use", id: "call_fast", name: "fast", input: {} },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "tool_calls" },
      ],
    ]);

    const events: any[] = [];
    for await (const event of agentLoop(messages("go"), [slow, fast], caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    const aborted = events.find((e) => e.type === "aborted");
    // The slow tool's result should reflect the abort, not a real completion.
    const toolResults = events.find((e) => e.type === "tool_results");
    const slowResult = toolResults?.results?.find((r: any) => r.toolName === "slow");
    expect(slowResult).toBeDefined();
    expect(slowResult.error).toBe("Aborted");
    // The slow tool may have started, but must not have run to completion.
    expect(slowFinished).toBe(false);
  });

  // ------------------------------------------------------------------
  // M27: typed Terminal return (kernel §8) + tool_use↔tool_result invariant
  // ------------------------------------------------------------------

  it("returns a typed Terminal {reason:'completed'} for a plain text answer", async () => {
    const caller = makeMockCaller([
      [
        { type: "text_delta", delta: "hi" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);
    // Drive the loop via yield* so we can read the typed return value.
    async function* drive() {
      return yield* agentLoop(messages("hi"), [], caller, testConfig, {
        systemPrompt: "x",
        maxTurns: 5,
        speculation: false,
      });
    }
    const gen = drive();
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    expect(res.value).toEqual({ reason: "completed", turns: 0, error: undefined });
  });

  it("returns Terminal {reason:'max_turns'} when the turn ceiling is hit", async () => {
    const tool: Tool = {
      name: "loop",
      description: "Loop",
      promptDescription: "loops",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "looping" }),
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    const caller = makeMockCaller(
      Array.from({ length: 10 }, () => [
        { type: "tool_use", id: "call_1", name: "loop", input: {} },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "tool_calls" },
      ]),
    );
    const gen = agentLoop(messages("go"), [tool], caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 2,
      speculation: false,
    });
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    expect(res.value.reason).toBe("max_turns");
  });

  it("returns Terminal {reason:'model_error'} on an unrecoverable model error", async () => {
    const caller = makeMockCaller([
      [{ type: "error", error: { status: 401, message: "bad key" } as unknown as Error }],
    ]);
    const gen = agentLoop(messages("hi"), [], caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
      speculation: false,
    });
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    expect(res.value.reason).toBe("model_error");
  });

  it("backstops a missing tool_result so the history is never left unpaired", async () => {
    // A tool whose execution throws AFTER the assistant tool_calls message is
    // pushed. The loop's finally-block must still append a paired tool_result,
    // or the next API call would 400 (kernel §7).
    const boom: Tool = {
      name: "boom",
      description: "boom",
      promptDescription: "throws",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      call: async () => {
        throw new Error("kaboom");
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "call_boom", name: "boom", input: {} },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "recovered" },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
      ],
    ]);
    const msgs = messages("go");
    for await (const _e of agentLoop(msgs, [boom], caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
      speculation: false,
    })) {
      // drain
    }
    // Every assistant tool_call id must have a matching tool message.
    const toolCallIds = msgs
      .filter((m) => m.role === "assistant" && m.tool_calls)
      .flatMap((m: any) => m.tool_calls.map((tc: any) => tc.id));
    const toolResultIds = msgs.filter((m) => m.role === "tool").map((m: any) => m.tool_call_id);
    for (const id of toolCallIds) {
      expect(toolResultIds).toContain(id);
    }
  });

  it("wraps a tool error in <tool_use_error> at the model boundary (M28)", async () => {
    // A buildTool tool whose body returns {error}. The UI sees `formatted`
    // verbatim, but the model-facing tool message must carry the envelope.
    const failing = buildTool({
      name: "failing",
      description: "fails",
      promptDescription: "always fails",
      schema: z.strictObject({ x: z.string() }),
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "", error: "nope" }),
    });
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "call_fail", name: "failing", input: { x: "y" } },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "ok" },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
      ],
    ]);
    const msgs = messages("go");
    const events: any[] = [];
    for await (const e of agentLoop(msgs, [failing as Tool], caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
      speculation: false,
    })) {
      events.push(e);
    }
    const toolMsg = msgs.find((m) => m.role === "tool") as any;
    expect(toolMsg.content).toContain("<tool_use_error>");
    // The UI-facing result is NOT wrapped.
    const tr = events.find((e) => e.type === "tool_results");
    expect(tr.results[0].formatted).not.toContain("<tool_use_error>");
    expect(tr.results[0].isError).toBe(true);
  });

  it("rejects unknown-key injection via strict validation before side effects (M28)", async () => {
    let executed = false;
    const strict = buildTool({
      name: "strict",
      description: "strict",
      promptDescription: "strict tool",
      schema: z.strictObject({ x: z.string() }),
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => {
        executed = true;
        return { content: "ran" };
      },
    });
    const caller = makeMockCaller([
      [
        // model injects an unexpected internal-looking key
        { type: "tool_use", id: "call_x", name: "strict", input: { x: "ok", __proto__hack: 1 } },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "ok" },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
      ],
    ]);
    const msgs = messages("go");
    const events: any[] = [];
    for await (const e of agentLoop(msgs, [strict as Tool], caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
      speculation: false,
    })) {
      events.push(e);
    }
    expect(executed).toBe(false);
    const tr = events.find((e) => e.type === "tool_results");
    expect(tr.results[0].isError).toBe(true);
    expect(tr.results[0].formatted).toContain("Invalid arguments");
    const toolMsg = msgs.find((m) => m.role === "tool") as any;
    expect(toolMsg.content).toContain("<tool_use_error>");
  });

  it("preserves order across batches: read | write | read runs serially around the write (M29)", async () => {
    const order: string[] = [];
    const mkTool = (name: string, safe: boolean): Tool => ({
      name,
      description: name,
      promptDescription: name,
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => safe,
      isConcurrencySafe: () => safe,
      call: async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${name}:end`);
        return { content: name };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    });
    const tools = [mkTool("readA", true), mkTool("writeX", false), mkTool("readB", true)];
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "c1", name: "readA", input: {} },
        { type: "tool_use", id: "c2", name: "writeX", input: {} },
        { type: "tool_use", id: "c3", name: "readB", input: {} },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "ok" },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
      ],
    ]);
    const events: any[] = [];
    for await (const e of agentLoop(messages("go"), tools, caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
      speculation: false,
    })) {
      events.push(e);
    }
    // writeX must not start until readA finished, and readB must not start
    // until writeX finished — the write is a serial barrier between the reads.
    expect(order.indexOf("writeX:start")).toBeGreaterThan(order.indexOf("readA:end"));
    expect(order.indexOf("readB:start")).toBeGreaterThan(order.indexOf("writeX:end"));
    // Results still come back in call order (reassembled by index).
    const tr = events.find((e) => e.type === "tool_results");
    expect(tr.results.map((r: any) => r.toolName)).toEqual(["readA", "writeX", "readB"]);
  });

  it("runs a batch of concurrency-safe reads in parallel (M29)", async () => {
    let active = 0;
    let peak = 0;
    const mkRead = (name: string): Tool => ({
      name,
      description: name,
      promptDescription: name,
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { content: name };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    });
    const tools = [mkRead("r1"), mkRead("r2"), mkRead("r3")];
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "c1", name: "r1", input: {} },
        { type: "tool_use", id: "c2", name: "r2", input: {} },
        { type: "tool_use", id: "c3", name: "r3", input: {} },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "ok" },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
      ],
    ]);
    for await (const _e of agentLoop(messages("go"), tools, caller, testConfig, {
      systemPrompt: "x",
      maxTurns: 5,
      speculation: false,
    })) {
      // drain
    }
    expect(peak).toBeGreaterThan(1); // they actually overlapped
  });

  it("spills an oversized tool result: model history bounded, UI result full (M30)", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-loop-spill-"));
    try {
      const huge = "Z".repeat(50_000); // well over the 30k default cap
      const bigTool = buildTool({
        name: "bigout",
        description: "big",
        promptDescription: "produces large output",
        schema: z.strictObject({}),
        isReadOnly: true,
        isConcurrencySafe: true,
        call: async () => ({ content: huge }),
      });
      const caller = makeMockCaller([
        [
          { type: "tool_use", id: "c1", name: "bigout", input: {} },
          {
            type: "done",
            usage: { input_tokens: 1, output_tokens: 1 },
            finish_reason: "tool_calls",
          },
        ],
        [
          { type: "text_delta", delta: "done" },
          { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
        ],
      ]);
      const msgs = messages("go");
      const events: any[] = [];
      for await (const e of agentLoop(msgs, [bigTool as Tool], caller, testConfig, {
        systemPrompt: "x",
        maxTurns: 5,
        speculation: false,
        toolContext: { workspaceRoot, sessionId: "loopsess" },
      })) {
        events.push(e);
      }

      // The model history copy is bounded and points at the spill file.
      const toolMsg = msgs.find((m) => m.role === "tool") as any;
      expect(toolMsg.content.length).toBeLessThan(huge.length);
      expect(toolMsg.content).toContain("read tool");

      // The UI-facing result is still the full output.
      const tr = events.find((e) => e.type === "tool_results");
      expect(tr.results[0].formatted).toContain(huge);
      expect(tr.results[0].modelContent.length).toBeLessThan(huge.length);

      // The full result was written to disk and is recoverable.
      const dir = path.join(workspaceRoot, SPILL_DIR);
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, files[0]!), "utf-8")).toContain(huge);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function messages(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

// ============================================================
// M32: turn output budget + stop hooks
// ============================================================

/** Drain the loop, returning both the yielded events and the typed terminal. */
async function drain(gen: ReturnType<typeof agentLoop>) {
  const events: any[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, terminal: res.value };
}

describe("agentLoop — turn output budget (M32)", () => {
  it("does NOT auto-continue when the budget is disabled (default)", async () => {
    let calls = 0;
    const caller: ModelCaller = async function* () {
      calls++;
      yield { type: "text_delta", delta: "done" };
      yield { type: "done", usage: { input_tokens: 5, output_tokens: 10 }, finish_reason: "stop" };
    };
    const { terminal } = await drain(
      agentLoop(messages("hi"), [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
      }),
    );
    expect(calls).toBe(1);
    expect(terminal.reason).toBe("completed");
  });

  it("auto-continues with a nudge while under budget, then stops on diminishing returns", async () => {
    let calls = 0;
    // Every turn produces tiny output (< 500) → low-gain streak hits 3 and stops.
    const caller: ModelCaller = async function* () {
      calls++;
      yield { type: "text_delta", delta: "x" };
      yield { type: "done", usage: { input_tokens: 5, output_tokens: 50 }, finish_reason: "stop" };
    };
    const msgs = messages("work");
    const { terminal } = await drain(
      agentLoop(msgs, [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 50,
        speculation: false,
        turnOutputBudget: 100_000,
      }),
    );
    // First call ends the turn; continuations 1 and 2 nudge; the 3rd low-gain
    // decision stops. So 3 model calls total.
    expect(calls).toBe(3);
    expect(terminal.reason).toBe("completed");
    // The nudges were injected as user messages.
    const nudges = msgs.filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("Continue working"),
    );
    expect(nudges.length).toBe(2);
  });

  it("counts auto-continuations toward maxTurns", async () => {
    let calls = 0;
    const caller: ModelCaller = async function* () {
      calls++;
      yield { type: "text_delta", delta: "x" };
      yield { type: "done", usage: { input_tokens: 5, output_tokens: 50 }, finish_reason: "stop" };
    };
    const { terminal } = await drain(
      agentLoop(messages("work"), [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 2,
        speculation: false,
        turnOutputBudget: 100_000,
      }),
    );
    expect(terminal.reason).toBe("max_turns");
    expect(calls).toBe(2);
  });
});

describe("agentLoop — stop hooks (M32)", () => {
  const textCaller: ModelCaller = async function* () {
    yield { type: "text_delta", delta: "all done" };
    yield { type: "done", usage: { input_tokens: 5, output_tokens: 3 }, finish_reason: "stop" };
  };

  it("preventContinuation hard-stops with stop_hook_prevented", async () => {
    const { terminal } = await drain(
      agentLoop(messages("hi"), [], textCaller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        hooks: {
          runPre: async ({ input }) => ({ input }),
          runPost: async ({ result }) => ({ result }),
          runStop: async () => ({ preventContinuation: true, reason: "not allowed to stop" }),
        },
      }),
    );
    expect(terminal.reason).toBe("stop_hook_prevented");
  });

  it("blockingError injects a meta user message and continues — once", async () => {
    let stopCalls = 0;
    const msgs = messages("hi");
    const { terminal } = await drain(
      agentLoop(msgs, [], textCaller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        hooks: {
          runPre: async ({ input }) => ({ input }),
          runPost: async ({ result }) => ({ result }),
          // Always tries to block; the anti-loop guard must ignore it the 2nd time.
          runStop: async ({ stopHookActive }) => {
            stopCalls++;
            return stopHookActive ? {} : { blockingError: "keep going: finish the task" };
          },
        },
      }),
    );
    expect(terminal.reason).toBe("completed");
    // Hook ran twice: once injecting the block, once ignored (stopHookActive).
    expect(stopCalls).toBe(2);
    const injected = msgs.filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("keep going"),
    );
    expect(injected.length).toBe(1);
  });
});

// ============================================================
// M36: background prefetch injection + streaming tool execution
// ============================================================

describe("agentLoop — background prefetch (M36)", () => {
  it("injects the prefetch attachment as a system message before the first call", async () => {
    const seen: string[] = [];
    const caller: ModelCaller = async function* (msgs) {
      // Record the system messages the model saw on the first call.
      for (const m of msgs) if (m.role === "system") seen.push(m.content);
      yield { type: "text_delta", delta: "ok" };
      yield { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" };
    };
    const msgs = messages("review the security pipeline");
    await drain(
      agentLoop(msgs, [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 3,
        speculation: false,
        prefetch: async (q) => `<system-reminder>\nPREFETCH for: ${q}\n</system-reminder>`,
      }),
    );
    expect(seen.some((s) => s.includes("PREFETCH for: review the security pipeline"))).toBe(true);
  });

  it("injects nothing when the prefetch resolves null", async () => {
    let systemCount = 0;
    const caller: ModelCaller = async function* (msgs) {
      systemCount = msgs.filter((m) => m.role === "system").length;
      yield { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" };
    };
    await drain(
      agentLoop(messages("hi"), [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 3,
        speculation: false,
        prefetch: async () => null,
      }),
    );
    expect(systemCount).toBe(0);
  });
});

describe("agentLoop — streaming tool execution (M36)", () => {
  it("still produces a correct read result with the streaming executor on", async () => {
    let reads = 0;
    const readTool: Tool = {
      name: "read",
      description: "Read",
      promptDescription: "Read a file",
      inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => {
        reads++;
        return { content: "FILE BODY" };
      },
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "r1", name: "read", input: { filePath: "a.ts" } },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);
    const events: any[] = [];
    for await (const event of agentLoop(messages("read it"), [readTool], caller, testConfig, {
      systemPrompt: "s",
      maxTurns: 5,
      speculation: true, // streaming executor on
    })) {
      events.push(event);
    }
    const tr = events.find((e) => e.type === "tool_results");
    expect(tr.results[0].formatted).toBe("FILE BODY");
    // Early-started during the stream, then served from take() in STEP 5 — the
    // read body is produced exactly once, never twice.
    expect(reads).toBe(1);
  });
});

// ============================================================
// M36: queued input (type-ahead) + interrupt terminal
// ============================================================

describe("agentLoop — queued input injection (M36)", () => {
  it("drains queued input at turn end and continues instead of completing", async () => {
    const queue = ["follow-up question"];
    let calls = 0;
    const caller: ModelCaller = async function* () {
      calls++;
      yield { type: "text_delta", delta: `answer ${calls}` };
      yield { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" };
    };
    const msgs = messages("first question");
    const { terminal } = await drain(
      agentLoop(msgs, [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        // Returns the queued item once, then empty (drained).
        drainQueuedInput: () => queue.splice(0, queue.length),
      }),
    );
    // First turn would end → queued input injected → second model call.
    expect(calls).toBe(2);
    expect(terminal.reason).toBe("completed");
    // The queued text was injected as a user message.
    expect(
      msgs.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("follow-up question"),
      ),
    ).toBe(true);
  });

  it("does not continue when the queue is empty (normal completion)", async () => {
    let calls = 0;
    const caller: ModelCaller = async function* () {
      calls++;
      yield { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" };
    };
    const { terminal } = await drain(
      agentLoop(messages("hi"), [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        drainQueuedInput: () => [],
      }),
    );
    expect(calls).toBe(1);
    expect(terminal.reason).toBe("completed");
  });
});

describe("agentLoop — interrupt terminal (M36)", () => {
  it("returns aborted_interrupt for a soft interrupt (not aborted_streaming)", async () => {
    const { cancelReason } = await import("../utils/cancellation.js");
    const controller = new AbortController();
    controller.abort(cancelReason("interrupt", "user typed"));
    const caller: ModelCaller = async function* () {
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    const { terminal } = await drain(
      agentLoop(messages("hi"), [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        abortSignal: controller.signal,
      }),
    );
    expect(terminal.reason).toBe("aborted_interrupt");
  });

  it("returns aborted_streaming for a hard cancel", async () => {
    const controller = new AbortController();
    controller.abort("hard stop");
    const caller: ModelCaller = async function* () {
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    const { terminal } = await drain(
      agentLoop(messages("hi"), [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        abortSignal: controller.signal,
      }),
    );
    expect(terminal.reason).toBe("aborted_streaming");
  });
});

// ============================================================
// M36: fast-model tool-batch summary (kernel §9)
// ============================================================

describe("agentLoop — tool-batch summary (M36)", () => {
  const bigTool: Tool = {
    name: "grep",
    description: "Grep",
    promptDescription: "Search",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    // Output well above the 2000-byte summary gate.
    call: async () => ({ content: "MATCH ".repeat(500) }),
    formatResult: (r) => r.content,
    checkPermissions: async () => ({ allowed: true }),
  };

  it("summarizes a large tool batch and injects the digest as a system message", async () => {
    const summarize = vi.fn().mockResolvedValue("grep found 500 matches across the tree.");
    // A caller that yields a real async tick before its events, simulating the
    // 5–30s stream latency during which the (~1s) fast-model summary completes.
    // This lets the summary's microtask chain flush before the next STEP 2
    // injection check — exactly what real streaming gives for free.
    const scripts: StreamEvent[][] = [
      [
        { type: "tool_use", id: "g1", name: "grep", input: { q: "x" } },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "tool_use", id: "g2", name: "grep", input: { q: "y" } },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ];
    let idx = 0;
    const caller: ModelCaller = async function* () {
      const events = scripts[idx++] ?? [
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
      ];
      await new Promise((r) => setTimeout(r, 0)); // stream latency tick
      for (const e of events) yield e;
    };
    const msgs = messages("search the tree");
    await drain(
      agentLoop(msgs, [bigTool], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 6,
        speculation: false,
        summarizeToolBatch: summarize,
      }),
    );
    expect(summarize).toHaveBeenCalled();
    // The digest was injected as a system-reminder somewhere in the history.
    const injected = msgs.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("grep found 500 matches across the tree.") &&
        m.content.includes("<system-reminder>"),
    );
    expect(injected).toBe(true);
  });

  it("does not summarize a tiny tool batch (below the size gate)", async () => {
    const summarize = vi.fn().mockResolvedValue("should not run");
    const smallTool: Tool = { ...bigTool, call: async () => ({ content: "ok" }) };
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "s1", name: "grep", input: { q: "x" } },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);
    await drain(
      agentLoop(messages("go"), [smallTool], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        summarizeToolBatch: summarize,
      }),
    );
    expect(summarize).not.toHaveBeenCalled();
  });

  it("never breaks the loop when the summarizer throws", async () => {
    const summarize = vi.fn().mockRejectedValue(new Error("fast model down"));
    const caller = makeMockCaller([
      [
        { type: "tool_use", id: "g1", name: "grep", input: { q: "x" } },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
        },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);
    const { terminal } = await drain(
      agentLoop(messages("go"), [bigTool], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        summarizeToolBatch: summarize,
      }),
    );
    expect(terminal.reason).toBe("completed");
  });
});
