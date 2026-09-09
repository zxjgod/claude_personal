// Regression: a fork whose inherited context exceeds the compaction threshold
// shrinks its message array mid-run. Output extraction must follow message
// identity, not the pre-compaction boundary index — otherwise a completed fork
// reports "no final report" and its worktree would be cleaned up as a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCoreToolsForSubagents } from "../subagents.js";
import { createTool } from "../tools/registry.js";
import type { Message, ModelCaller, ToolContext } from "../types.js";

const fake = vi.hoisted(() => ({ caller: vi.fn() }));
vi.mock("../llm-adapter.js", () => ({ createModelCaller: () => fake.caller }));
vi.mock("../audit-log.js", () => ({
  logToolExecution: async () => {},
  logBashOperation: async () => {},
  logFileOperation: async () => {},
}));

import { AgentTool } from "../tools/extended/agent.js";
import { TaskTool } from "../tools/extended/task.js";

const inspect = createTool({
  name: "inspect",
  description: "read fixture",
  promptDescription: "read fixture",
  inputSchema: { type: "object", properties: {}, required: [] },
  isReadOnly: true,
  call: async () => ({ content: "fixture evidence" }),
});

// 25 parent messages; the first is large enough (~60k estimated tokens) to
// push the fork past the sub-agent's 50k auto-compaction threshold on turn 1.
function buildParentMessages(): Message[] {
  const parents: Message[] = [
    { role: "user", content: [{ type: "text", text: "x".repeat(220_000) }] },
  ];
  for (let i = 1; i < 25; i++) {
    parents.push(
      i % 2 === 1
        ? { role: "assistant", content: `Parent note ${i}` }
        : { role: "user", content: [{ type: "text", text: `Parent request ${i}` }] },
    );
  }
  return parents;
}

let parents: Message[];
let ctx: ToolContext;

beforeEach(() => {
  fake.caller.mockReset();
  setCoreToolsForSubagents([inspect]);
  parents = buildParentMessages();
  ctx = {
    workspaceRoot: process.cwd(),
    sessionId: "fork-compaction",
    permissionMode: "default",
    modelConfig: { provider: "openai", model: "test", apiKey: "fake" },
    getParentMessages: () => parents,
    parentSystemPrompt: "parent system prompt",
  } as ToolContext;
  const caller: ModelCaller = async function* (_messages, tools) {
    // The main loop call carries tools; the compaction summary call does not.
    if (tools.length === 0) {
      yield { type: "text_delta", delta: "Summary of earlier work." };
    } else {
      yield { type: "text_delta", delta: "Final report: all files checked." };
    }
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
  };
  fake.caller.mockImplementation(caller);
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([TaskTool, AgentTool])("$name fork output after compaction", (tool) => {
  it("returns the fork's own final report once compaction shrinks the history", async () => {
    const result = await tool.call(
      { description: "review", prompt: "review the fixture" },
      ctx,
    );
    // Compaction must actually have fired (the summary call carries no tools),
    // otherwise this test does not exercise the index-drift scenario.
    expect(fake.caller.mock.calls.some(([, tools]) => tools.length === 0)).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Final report: all files checked.");
  });
});
