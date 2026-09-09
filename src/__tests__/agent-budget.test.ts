import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSubagentType, setCoreToolsForSubagents } from "../subagents.js";
import { executeSingleTool } from "../tool-executor.js";
import { createTool } from "../tools/registry.js";
import type { ModelCaller, ToolContext } from "../types.js";

const fake = vi.hoisted(() => ({ caller: vi.fn() }));
vi.mock("../llm-adapter.js", () => ({ createModelCaller: () => fake.caller }));
vi.mock("../audit-log.js", () => ({
  logToolExecution: async () => {},
  logBashOperation: async () => {},
  logFileOperation: async () => {},
}));

import { AgentTool } from "../tools/extended/agent.js";
import { TaskTool } from "../tools/extended/task.js";

const ctx: ToolContext = {
  workspaceRoot: process.cwd(),
  sessionId: "budget-test",
  permissionMode: "default",
  modelConfig: { provider: "openai", model: "test", apiKey: "fake" },
};
const inspect = createTool({
  name: "inspect",
  description: "read fixture",
  promptDescription: "read fixture",
  inputSchema: { type: "object", properties: {}, required: [] },
  isReadOnly: true,
  call: async () => ({ content: "fixture evidence" }),
});
beforeEach(() => {
  fake.caller.mockReset();
  setCoreToolsForSubagents([inspect]);
  registerSubagentType({
    name: "budget-review-test",
    description: "fixture",
    toolNames: ["inspect"],
    systemPrompt: "review evidence",
    maxTurns: 2,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each([TaskTool, AgentTool])("$name budget handling", (tool) => {
  it("returns a tool-free handoff after reaching the configured turn budget", async () => {
    const caller: ModelCaller = async function* (_messages, tools) {
      if (tools.length) {
        yield { type: "text_delta", delta: "Inspecting more files" };
        yield {
          type: "tool_use",
          id: `call-${fake.caller.mock.calls.length}`,
          name: "inspect",
          input: {},
        };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
      } else {
        yield { type: "text_delta", delta: "Partial findings: a.ts checked; b.ts not checked." };
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
      }
    };
    fake.caller.mockImplementation(caller);
    const result = await tool.call(
      {
        description: "review",
        prompt: "review fixture",
        subagent_name: "budget-review-test",
        subagent_type: "budget-review-test",
      },
      ctx,
    );
    expect(fake.caller).toHaveBeenCalledTimes(3);
    expect(result.metadata?.incomplete).toBe(true);
    expect(result.content).toContain("b.ts not checked");
    expect(result.content).not.toContain("Inspecting more files");
    expect(result.error).toBeUndefined();
  });

  it("uses the long watchdog while preserving parent cancellation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CLAUDE_CODE_TOOL_TIMEOUT_MS", "");
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const longTool = {
      ...tool,
      call: async (_input: unknown, context: ToolContext) => {
        childSignal = context.abortSignal;
        return new Promise<{ content: string }>((resolve) =>
          context.abortSignal?.addEventListener("abort", () => resolve({ content: "stopped" }), {
            once: true,
          }),
        );
      },
    };
    const args = { prompt: "review", description: "review" };
    const pending = executeSingleTool(
      { id: "1", type: "function", function: { name: tool.name, arguments: JSON.stringify(args) } },
      [longTool],
      ctx,
      async () => true,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(301_000);
    expect(settled).toBe(false);
    expect(childSignal?.aborted).toBe(false);
    controller.abort();
    expect((await pending).isError).toBe(true);
    expect(childSignal?.aborted).toBe(true);
  });

  it("honors an explicit configured timeout despite the longer default", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CLAUDE_CODE_TOOL_TIMEOUT_MS", "20");
    const pending = executeSingleTool(
      {
        id: "1",
        type: "function",
        function: {
          name: tool.name,
          arguments: JSON.stringify({ prompt: "review", description: "review" }),
        },
      },
      [{ ...tool, call: async () => new Promise(() => {}) }],
      ctx,
      async () => true,
    );
    await vi.advanceTimersByTimeAsync(25);
    expect((await pending).error).toContain("timed out");
  });
});
