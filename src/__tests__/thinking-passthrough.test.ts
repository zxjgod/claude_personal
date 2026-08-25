// ============================================================
// Tests: thinking-block passthrough (ported from mini-agent invariants)
// ============================================================
// Three layers, one invariant each:
//   1. adapter conversion — signed thinking blocks lead the assistant content,
//      passed back byte-for-byte (interleaved thinking API requirement)
//   2. agent loop — thinking deltas stream to the UI AND the signed blocks
//      land on the assistant message in history (both exit paths)
//   3. persistence — the field survives a session save/load round-trip
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import { convertMessagesToAnthropic } from "../anthropic-adapter.js";
import { PersistenceManager } from "../persistence.js";
import type {
  AssistantMessage,
  Message,
  ModelCaller,
  ModelConfig,
  StreamEvent,
  Tool,
} from "../types.js";

const testConfig: ModelConfig = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKey: "test-key",
};

const THINKING = [
  { type: "thinking", thinking: "let me reason about this…", signature: "sig-αβγ-==/" },
] as const;

function makeMockCaller(responses: StreamEvent[][]): ModelCaller {
  let callIndex = 0;
  return async function* (): AsyncGenerator<StreamEvent> {
    const events = responses[callIndex] ?? [
      { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "stop" },
    ];
    callIndex++;
    for (const event of events) yield event;
  };
}

function userMessages(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

async function drain(gen: ReturnType<typeof agentLoop>) {
  const events: any[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, terminal: res.value };
}

const readTool: Tool = {
  name: "read",
  description: "Read",
  promptDescription: "Read",
  inputSchema: { type: "object", properties: {}, required: [] },
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async () => ({ content: "file contents" }),
  formatResult: (result) => result.content,
  checkPermissions: async () => ({ allowed: true }),
};

// --- 1. Adapter conversion ------------------------------------------------

describe("convertMessagesToAnthropic — thinking passback", () => {
  it("prepends thinking blocks (signature verbatim) before text and tool_use", () => {
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
        thinking: [...THINKING],
      },
    ];

    const [msg] = convertMessagesToAnthropic(messages) as any[];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toHaveLength(3);
    expect(msg.content[0]).toEqual({
      type: "thinking",
      thinking: "let me reason about this…",
      signature: "sig-αβγ-==/", // byte-for-byte
    });
    expect(msg.content[1]).toEqual({ type: "text", text: "I'll read it." });
    expect(msg.content[2].type).toBe("tool_use");
  });

  it("passes redacted_thinking through verbatim", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "ok",
        thinking: [{ type: "redacted_thinking", data: "encrypted-payload" }],
      },
    ];

    const [msg] = convertMessagesToAnthropic(messages) as any[];
    expect(msg.content[0]).toEqual({ type: "redacted_thinking", data: "encrypted-payload" });
  });

  it("leaves messages without thinking blocks byte-identical (back-compat)", () => {
    const messages: Message[] = [{ role: "assistant", content: "plain answer" }];
    expect(convertMessagesToAnthropic(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "plain answer" }] },
    ]);
  });
});

// --- 2. Agent loop ---------------------------------------------------------

describe("agentLoop — thinking flow", () => {
  it("streams thinking_delta events and stores signed blocks (no-tool path)", async () => {
    const caller = makeMockCaller([
      [
        { type: "thinking", delta: "reasoning…" },
        { type: "text_delta", delta: "answer" },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "stop",
          thinking: [...THINKING],
        },
      ],
    ]);
    const history = userMessages("hi");

    const { events, terminal } = await drain(
      agentLoop(history, [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 3,
        speculation: false,
      }),
    );

    expect(terminal.reason).toBe("completed");
    expect(events.filter((e) => e.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", delta: "reasoning…" },
    ]);
    const assistant = history.find((m) => m.role === "assistant") as AssistantMessage;
    expect(assistant.thinking).toEqual(THINKING);
    expect(assistant.content).toBe("answer");
  });

  it("attaches thinking blocks on the tool-calls path and passes them back next turn", async () => {
    const caller = makeMockCaller([
      [
        { type: "thinking", delta: "need a file" },
        { type: "tool_use", id: "t1", name: "read", input: {} },
        {
          type: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
          finish_reason: "tool_calls",
          thinking: [...THINKING],
        },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "done", usage: { input_tokens: 20, output_tokens: 5 }, finish_reason: "stop" },
      ],
    ]);
    const history = userMessages("read it");

    const { terminal } = await drain(
      agentLoop(history, [readTool], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 5,
        speculation: false,
      }),
    );

    expect(terminal.reason).toBe("completed");
    const toolTurn = history.find((m) => m.role === "assistant" && m.tool_calls?.length) as
      | AssistantMessage
      | undefined;
    expect(toolTurn?.thinking).toEqual(THINKING);
    // And the next API call would send them back first (adapter handles order).
    const converted = convertMessagesToAnthropic(history, [readTool]) as any[];
    const assistantMsg = converted.find((m) => m.role === "assistant");
    expect(assistantMsg.content[0].type).toBe("thinking");
    expect(assistantMsg.content[0].signature).toBe("sig-αβγ-==/");
  });

  it("keeps history shape unchanged when the model produces no thinking", async () => {
    const caller = makeMockCaller([
      [
        { type: "text_delta", delta: "plain" },
        { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" },
      ],
    ]);
    const history = userMessages("hi");

    await drain(
      agentLoop(history, [], caller, testConfig, {
        systemPrompt: "s",
        maxTurns: 3,
        speculation: false,
      }),
    );

    const assistant = history.find((m) => m.role === "assistant") as AssistantMessage;
    expect("thinking" in assistant).toBe(false);
  });
});

// --- 3. Persistence round-trip --------------------------------------------

describe("persistence — thinking field round-trip", () => {
  let tmpDir: string;
  let pm: PersistenceManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-thinking-"));
    pm = new PersistenceManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("survives save/load verbatim", async () => {
    const sessionId = pm.generateId();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "answer", thinking: [...THINKING] },
    ];

    await pm.save(sessionId, messages);
    const loaded = await pm.load(sessionId);

    expect(loaded).not.toBeNull();
    expect(loaded!.messages[1]).toEqual(messages[1]);
  });
});
