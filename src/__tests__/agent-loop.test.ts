// ============================================================
// Tests: Agent Loop
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentLoop } from "../agent-loop.js";
import { createJob, settleJob } from "../tools/job-store.js";
import { drainNotifications, resetNotifications } from "../tools/notifications.js";
import { buildTool } from "../tools/registry.js";
import { SPILL_DIR } from "../tools/truncation.js";
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
  it("does not apply an implicit turn limit to a main task", async () => {
    let callCount = 0;
    const readTool: Tool = {
      name: "read",
      description: "Read",
      promptDescription: "Read",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "ok" }),
      formatResult: (result) => result.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    const caller: ModelCaller = async function* () {
      callCount++;
      if (callCount <= 51) {
        yield { type: "tool_use", id: `read-${callCount}`, name: "read", input: {} };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
        return;
      }
      yield { type: "text_delta", delta: "Task completed after 51 tool turns." };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };

    const events = await drain(
      agentLoop(messages("finish the long task"), [readTool], caller, testConfig, {
        systemPrompt: "s",
        speculation: false,
      }),
    );

    expect(callCount).toBe(52);
    expect(events.terminal.reason).toBe("completed");
    expect(events.events.some((event: any) => event.type === "aborted")).toBe(false);
  });

  it("returns a watchdog timeout to the agent and continues the parent task", async () => {
    const savedTimeout = process.env.CLAUDE_CODE_TOOL_TIMEOUT_MS;
    process.env.CLAUDE_CODE_TOOL_TIMEOUT_MS = "10";
    let toolSawAbort = false;
    let sawTimeoutResult = false;
    const slowTool: Tool = {
      name: "slow_tool",
      description: "Slow tool",
      promptDescription: "Runs a slow operation",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (_input, context) =>
        new Promise((resolve) => {
          context.abortSignal?.addEventListener(
            "abort",
            () => {
              toolSawAbort = true;
              resolve({ content: "stopped" });
            },
            { once: true },
          );
        }),
      formatResult: (result) => result.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    const caller: ModelCaller = async function* (messages) {
      sawTimeoutResult = messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.includes("Tool call timed out"),
      );
      if (!sawTimeoutResult) {
        yield { type: "tool_use", id: "slow-1", name: "slow_tool", input: {} };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
        return;
      }
      yield { type: "text_delta", delta: "Recovered after checking the tool timeout." };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };

    try {
      const events = await drain(
        agentLoop(messages("run the task"), [slowTool], caller, testConfig, {
          systemPrompt: "s",
          maxTurns: 4,
          speculation: false,
        }),
      );
      expect(toolSawAbort).toBe(true);
      expect(sawTimeoutResult).toBe(true);
      expect(events.terminal.reason).toBe("completed");
      expect(events.events.some((event: any) => event.type === "aborted")).toBe(false);
    } finally {
      if (savedTimeout === undefined) delete process.env.CLAUDE_CODE_TOOL_TIMEOUT_MS;
      else process.env.CLAUDE_CODE_TOOL_TIMEOUT_MS = savedTimeout;
    }
  });

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

  it("recovers from truncation and continues until the model finishes naturally", async () => {
    // finish_reason "length" = the provider cut the output off; the loop must
    // nudge and continue rather than treat the half answer as complete. A task
    // truncated TWICE must still finish — there is no artificial cap on the
    // number of continuations.
    const caller = makeMockCaller([
      [
        { type: "text_delta", delta: "Part 1 — " },
        { type: "done", usage: { input_tokens: 10, output_tokens: 4 }, finish_reason: "length" },
      ],
      [
        { type: "text_delta", delta: "Part 2 — " },
        { type: "done", usage: { input_tokens: 10, output_tokens: 4 }, finish_reason: "length" },
      ],
      [
        { type: "text_delta", delta: "Part 3 (done)." },
        { type: "done", usage: { input_tokens: 10, output_tokens: 3 }, finish_reason: "stop" },
      ],
    ]);

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Write three parts" }] },
    ];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 10,
      speculation: false,
    })) {
      events.push(event);
    }

    // Two truncations → two continuations → three model calls total.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(3);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.finishReason).toBe("end_turn");
  });

  it("a provider that never stops truncating hits maxTurns, never reports completed", async () => {
    // Every call is truncated. The loop must keep recovering but still exit at
    // maxTurns (the hard backstop) — and it must report "max_turns", NOT
    // "completed"/"end_turn", so a half answer is never silently accepted.
    const truncated: StreamEvent[] = [
      { type: "text_delta", delta: "more output… " },
      { type: "done", usage: { input_tokens: 10, output_tokens: 4 }, finish_reason: "length" },
    ];
    const caller = makeMockCaller([truncated, truncated, truncated, truncated, truncated]);

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Run forever" }] },
    ];

    const events: any[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
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

    // The loop surfaces the abort as an `aborted` event (verified: it fires).
    const aborted = events.find((e) => e.type === "aborted");
    expect(aborted).toBeDefined();
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

  it("stores full tool result in message history; truncation is in adapters (P0-1 fix)", async () => {
    // This test verifies the P0-1 fix: the agent loop stores the FULL tool output
    // in message history. The spill-to-disk / truncation now happens at API-call
    // time in llm-adapter / anthropic-adapter — so a session snapshot (session-memory)
    // always preserves complete tool results for resume.
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

      // P0-1 Fix: message history stores the FULL huge result (no truncation in loop).
      // The adapters (llm-adapter / anthropic-adapter) truncate at API-call time.
      const toolMsg = msgs.find((m) => m.role === "tool") as any;
      expect(toolMsg.content.length).toBeGreaterThan(huge.length);

      // The UI-facing result is also the full output.
      const tr = events.find((e) => e.type === "tool_results");
      expect(tr.results[0].formatted).toContain(huge);
      expect(tr.results[0].modelContent).toBeUndefined();

      // No spill file should be created by the agent loop.
      const dir = path.join(workspaceRoot, SPILL_DIR);
      expect(fs.existsSync(dir)).toBe(false);
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

// ============================================================
// M41: background completion notifications
// ============================================================

describe("agentLoop — background notifications (M41)", () => {
  it("delivers background completion notifications into the next model call instead of ending the turn", async () => {
    const seenCalls: string[][] = [];
    const caller: ModelCaller = async function* (msgs) {
      seenCalls.push(
        msgs.flatMap((m) => {
          if (m.role === "user")
            return m.content.filter((b) => b.type === "text").map((b) => b.text);
          if (m.role === "assistant") return [m.content ?? ""];
          return [];
        }),
      );
      yield { type: "text_delta", delta: "ok" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    const msgs = messages("start");
    let drained = false;
    const { events, terminal } = await drain(
      agentLoop(msgs, [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
        // One pending notification, then empty (drained).
        drainNotifications: () => {
          if (drained) return [];
          drained = true;
          return ["<task_notification>\n<task_id>job-1</task_id>\n</task_notification>"];
        },
      }),
    );
    // Call 2 exists (the notification extended the turn) and carries the XML block.
    expect(seenCalls.length).toBe(2);
    expect(seenCalls[1]?.some((t) => t.includes("<task_notification>"))).toBe(true);
    // The notification landed in history as a user message.
    const injected = msgs.find(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("<task_id>job-1</task_id>"),
    );
    expect(injected).toBeDefined();
    expect(terminal.reason).toBe("completed");
    expect(events.find((e) => e.type === "done").finishReason).toBe("end_turn");
  });

  it("caps notification continuations at MAX_NOTIFICATION_CONTINUATIONS and leaves the rest queued", async () => {
    let callCount = 0;
    const caller: ModelCaller = async function* () {
      callCount++;
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    // A real queue, drained one notification at a time: 11 pending completions.
    const queue = Array.from(
      { length: 11 },
      (_, i) => `<task_notification>n${i}</task_notification>`,
    );
    const { terminal } = await drain(
      agentLoop(messages("start"), [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 30,
        speculation: false,
        drainNotifications: () => queue.splice(0, 1),
      }),
    );
    // 1 initial call + 10 capped notification continuations, then the loop ends.
    expect(callCount).toBe(11);
    expect(terminal.reason).toBe("completed");
    // The 11th notification was NOT drained at the final end_turn — the budget
    // check runs before draining, so it stays queued for the next user turn.
    expect(queue).toHaveLength(1);
  });

  it("injects notifications at the tool-results boundary without consuming the continuation budget", async () => {
    const echo: Tool = {
      name: "echo",
      description: "Echo",
      promptDescription: "Echo",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "echoed" }),
      formatResult: (r) => r.content,
      checkPermissions: async () => ({ allowed: true }),
    };
    let callCount = 0;
    const caller: ModelCaller = async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: "tool_use", id: "c1", name: "echo", input: {} };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
        return;
      }
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    // n0 lands while the tool runs (drained at the tool-results boundary);
    // n1..n10 arrive one per subsequent end_turn.
    const queue = Array.from(
      { length: 11 },
      (_, i) => `<task_notification>n${i}</task_notification>`,
    );
    const msgs = messages("start");
    const { terminal } = await drain(
      agentLoop(msgs, [echo], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 30,
        speculation: false,
        drainNotifications: () => queue.splice(0, 1),
      }),
    );
    // 1 tool turn + 1 post-tool turn + 10 end_turn notification continuations.
    // If the tool-boundary injection had consumed budget, only 9 end_turn
    // continuations would fit → 11 calls instead of 12.
    expect(callCount).toBe(12);
    expect(queue).toHaveLength(0);
    expect(terminal.reason).toBe("completed");
    // n0 rode into history right alongside the tool results.
    expect(
      msgs.some(
        (m) =>
          m.role === "user" &&
          JSON.stringify(m.content).includes("<task_notification>n0</task_notification>"),
      ),
    ).toBe(true);
  });

  it("resets the notification continuation budget when real queued user input is injected", async () => {
    let callCount = 0;
    const caller: ModelCaller = async function* () {
      callCount++;
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    const notifications = Array.from(
      { length: 5 },
      (_, i) => `<task_notification>batch1-${i}</task_notification>`,
    );
    const userQueue = ["real follow-up"];
    const msgs = messages("start");
    const { terminal } = await drain(
      agentLoop(msgs, [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 40,
        speculation: false,
        drainNotifications: () => notifications.splice(0, 1),
        drainQueuedInput: () => {
          const queued = userQueue.splice(0, userQueue.length);
          if (queued.length > 0) {
            // Ten more background jobs settle while the loop works on the
            // user's follow-up.
            for (let i = 0; i < 10; i++)
              notifications.push(`<task_notification>batch2-${i}</task_notification>`);
          }
          return queued;
        },
      }),
    );
    // 1 initial + 5 notification continuations + 1 user-input turn + 10 more
    // notification continuations (the real user input reset the budget).
    // Without the reset the second batch would stop after 5 → 12 calls.
    expect(callCount).toBe(17);
    expect(terminal.reason).toBe("completed");
    expect(notifications).toHaveLength(0);
    expect(
      msgs.some((m) => m.role === "user" && JSON.stringify(m.content).includes("real follow-up")),
    ).toBe(true);
  });
});

describe("job-store — completion notifications (M41)", () => {
  beforeEach(() => resetNotifications());

  it("createJob threads sessionId and kind through to the job", () => {
    const job = createJob("m41-sess-a", {
      kind: "agent",
      command: "summarize the repo",
      description: "Repo summary",
    });
    expect(job.sessionId).toBe("m41-sess-a");
    expect(job.kind).toBe("agent");
    expect(job.status).toBe("running");
  });

  it("settleJob pushes a <task_notification> drainable by the owning session", () => {
    const job = createJob("m41-sess-b", {
      kind: "bash",
      command: "npm test",
      description: "run tests",
    });
    job.stdout = "all green";
    settleJob(job, "done", 0);
    const drained = drainNotifications("m41-sess-b");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("<task_notification>");
    expect(drained[0]).toContain(`<task_id>${job.id}</task_id>`);
    expect(drained[0]).toContain("<kind>bash</kind>");
    expect(drained[0]).toContain("<status>done</status>");
    expect(drained[0]).toContain("<summary>run tests</summary>");
    expect(drained[0]).toContain("all green");
    // Draining consumed the queue; other sessions never saw it.
    expect(drainNotifications("m41-sess-b")).toEqual([]);
    expect(drainNotifications("m41-sess-a")).toEqual([]);
  });

  it("caps the notification output tail at 500 chars and settles idempotently", () => {
    const job = createJob("m41-sess-c", { kind: "bash", command: "noisy" });
    job.stdout = "x".repeat(1000);
    job.stderr = "E".repeat(100);
    settleJob(job, "done", 0);
    // Already terminal — a second settle is a no-op and must NOT re-notify.
    settleJob(job, "killed", null);
    const drained = drainNotifications("m41-sess-c");
    expect(drained).toHaveLength(1);
    const output = drained[0]?.match(/<output>\n([\s\S]*)\n<\/output>/)?.[1];
    expect(output).toBeDefined();
    // stdout+stderr joined, then cut to the last 500 characters.
    expect(output?.length).toBeLessThanOrEqual(500);
    expect(output).toContain("E".repeat(100));
  });
});
