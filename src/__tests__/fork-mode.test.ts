// ============================================================
// Tests: Fork mode — Agent tool with no subagent_type forks the agent (M35)
// ============================================================
// Kernel §6 mechanism A: omitting subagent_name forks the CURRENT agent — it
// inherits the parent's message history, reuses the parent's system prompt
// verbatim (shared prompt cache, no model swap), and returns ONLY its own final
// text (the seeded parent history is sliced off before extraction).
//
// We mock the model caller to capture what (messages, systemPrompt) the forked
// sub-loop is invoked with, and to emit a canned final answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the args the sub-loop's model caller sees, across calls.
const captured: { messages: any[]; systemPrompt?: string }[] = [];

vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () =>
    async function* (messages: any[], _tools: any, systemPrompt?: string) {
      captured.push({ messages: messages.map((m) => ({ ...m })), systemPrompt });
      yield { type: "text_delta", delta: "fork final answer" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    },
}));

import { TaskTool } from "../task-tool.js";
import type { Message, ModelConfig, ToolContext } from "../types.js";

const modelConfig: ModelConfig = { provider: "deepseek", model: "deepseek-chat", apiKey: "k" };

const PARENT_HISTORY: Message[] = [
  { role: "user", content: [{ type: "text", text: "earlier user turn" }] },
  { role: "assistant", content: "earlier assistant answer" },
];

function forkCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "fork-sess",
    permissionMode: "default",
    modelConfig,
    getParentMessages: () => PARENT_HISTORY.map((m) => ({ ...m })),
    parentSystemPrompt: "PARENT-SYSTEM-PROMPT",
    ...overrides,
  };
}

beforeEach(() => {
  captured.length = 0;
});

describe("TaskTool — fork mode (no subagent_name)", () => {
  it("inherits the parent's message history and appends the fork task", async () => {
    await TaskTool.call({ description: "f", prompt: "the fork task" }, forkCtx());
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const seen = captured[0]!.messages;
    // Parent turns are seeded first…
    expect(seen[0].content[0].text).toBe("earlier user turn");
    expect(seen[1].content).toBe("earlier assistant answer");
    // …then the fork task is appended as the latest user turn.
    const last = seen[seen.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0].text).toBe("the fork task");
  });

  it("reuses the parent system prompt verbatim (shared prompt cache)", async () => {
    await TaskTool.call({ description: "f", prompt: "task" }, forkCtx());
    expect(captured[0]!.systemPrompt).toBe("PARENT-SYSTEM-PROMPT");
  });

  it("returns only the fork's final text under a Fork header (no parent leak)", async () => {
    const r = await TaskTool.call({ description: "f", prompt: "task" }, forkCtx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("[Fork of current agent completed]");
    expect(r.content).toContain("fork final answer");
    // The seeded parent's assistant text must NOT be echoed back.
    expect(r.content).not.toContain("earlier assistant answer");
  });

  it("falls back to a typed sub-agent when fork context is absent", async () => {
    // No getParentMessages/parentSystemPrompt → can't fork → code-explorer.
    const r = await TaskTool.call(
      { description: "f", prompt: "task" },
      { workspaceRoot: process.cwd(), sessionId: "s", permissionMode: "default", modelConfig },
    );
    expect(r.error).toBeUndefined();
    expect(r.content).toContain('[Sub-agent "code-explorer" completed]');
    expect(r.content).not.toContain("Fork of current agent");
    // A typed sub-agent does NOT seed the parent history.
    expect(captured[0]!.messages[0].content[0].text).toBe("task");
  });

  it("a named subagent_type still takes the typed path even when fork is available", async () => {
    const r = await TaskTool.call(
      { description: "f", prompt: "task", subagent_name: "general" },
      forkCtx(),
    );
    expect(r.content).toContain('[Sub-agent "general" completed]');
    // Typed path uses its own sub-agent prompt, not the parent's.
    expect(captured[0]!.systemPrompt).not.toBe("PARENT-SYSTEM-PROMPT");
    // …and starts clean (no seeded parent history).
    expect(captured[0]!.messages[0].content[0].text).toBe("task");
  });
});
