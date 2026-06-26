// ============================================================
// Tests: Agent Loop
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { agentLoop } from "../agent-loop.js";
import type { Message, ModelCaller, ModelConfig, Tool, StreamEvent } from "../types.js";

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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ];

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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Echo test" }] },
    ];

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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];

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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Loop" }] },
    ];

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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Test" }] },
    ];

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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "write" }] },
    ];

    const events: any[] = [];
    for await (const event of agentLoop(
      messages,
      [writeTool],
      caller,
      testConfig,
      {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        askUser: async () => false, // user denies
      },
    )) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults.results[0].formatted).toContain("权限被拒绝");
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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "write" }] },
    ];

    const events: any[] = [];
    for await (const event of agentLoop(
      messages,
      [writeTool],
      caller,
      testConfig,
      {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        toolContext: { permissionMode: "plan" },
        // askUser would allow, but plan mode must block before asking.
        askUser: async () => true,
      },
    )) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const toolResults = events.find((e) => e.type === "tool_results");
    expect(toolResults.results[0].formatted).toContain("权限被拒绝");
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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "rm" }] },
    ];
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
    expect(toolResults.results[0].formatted).toContain("权限被拒绝");
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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "probe" }] },
    ];

    const onSubAgentProgress = vi.fn();
    for await (const _event of agentLoop(
      messages,
      [probeTool],
      caller,
      testConfig,
      {
        systemPrompt: "You are helpful.",
        maxTurns: 5,
        toolContext: {
          workspaceRoot: "/custom/workspace",
          sessionId: "session-xyz",
          permissionMode: "default",
          onSubAgentProgress,
        },
      },
    )) {
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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "run" }] },
    ];

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

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read" }] },
    ];

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
      inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
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
        { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "tool_calls" },
      ],
      [
        { type: "tool_use", id: "r1", name: "read", input: { filePath: "src/a.ts" } },
        { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "done", usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop" },
      ],
    ]);

    const events: any[] = [];
    for await (const event of agentLoop(messages("search"), [readTool, grepTool], caller, testConfig, {
      systemPrompt: "You are helpful.",
      maxTurns: 5,
      speculation: true,
    })) {
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
    // Two parallel-safe tools. The slow one is in-flight when abort fires; the
    // loop must yield "Aborted" for it rather than waiting for it to finish.
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
});

function messages(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}
