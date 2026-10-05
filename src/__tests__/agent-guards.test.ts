// ============================================================
// Tests: Agent tool guards (F4) — fork depth cap
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCoreToolsForSubagents } from "../subagents.js";
import { getJob } from "../tools/job-store.js";
import type { Message, ModelCaller, ToolContext } from "../types.js";

const fake = vi.hoisted(() => ({ caller: vi.fn() }));
vi.mock("../llm-adapter.js", () => ({ createModelCaller: () => fake.caller }));
vi.mock("../audit-log.js", () => ({
  logToolExecution: async () => {},
  logBashOperation: async () => {},
  logFileOperation: async () => {},
}));

import { AgentTool } from "../tools/extended/agent.js";

const parentMessages: Message[] = [{ role: "user", content: [{ type: "text", text: "parent" }] }];

function forkContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "guards-test",
    permissionMode: "default",
    modelConfig: { provider: "openai", model: "test", apiKey: "fake" },
    getParentMessages: () => parentMessages.slice(),
    parentSystemPrompt: "parent prompt",
    ...overrides,
  };
}

beforeEach(() => {
  fake.caller.mockReset();
  setCoreToolsForSubagents([]);
});

describe("AgentTool background mode (F3)", () => {
  const caller: ModelCaller = async function* () {
    yield { type: "text_delta", delta: "background report done" };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
  };

  it("returns immediately with a job handle and settles done with the report", async () => {
    fake.caller.mockImplementation(caller);
    const sessionId = "bg-agent-test-1";
    const result = await AgentTool.call(
      { prompt: "long task", subagent_type: "general", run_in_background: true },
      forkContext({ sessionId }),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Background agent started");
    expect(result.metadata?.jobId).toMatch(/^job-\d+$/);
    // The background run settles asynchronously — await the job's settled promise.
    const jobId = result.metadata?.jobId as string;
    const job = getJob(sessionId, jobId);
    expect(job).toBeTruthy();
    expect(job?.kind).toBe("agent");
    await job?.settled;
    expect(job?.status).toBe("done");
    expect(job?.stdout).toContain("background report done");
  });

  it("routes a failing background agent to error status with the reason", async () => {
    fake.caller.mockImplementation(async function* () {
      yield { type: "error", error: new Error("model exploded") };
    });
    const sessionId = "bg-agent-test-2";
    const result = await AgentTool.call(
      { prompt: "doomed task", subagent_type: "general", run_in_background: true },
      forkContext({ sessionId }),
    );
    const job = getJob(sessionId, result.metadata?.jobId as string);
    await job?.settled;
    expect(job?.status).toBe("error");
    expect(job?.stderr).toContain("model exploded");
  });

  it("kill aborts the background run and settles killed", async () => {
    const controller = new AbortController();
    fake.caller.mockImplementation(async function* () {
      await new Promise((r) => setTimeout(r, 50));
      yield { type: "text_delta", delta: "never finished" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    } as ModelCaller);
    const sessionId = "bg-agent-test-3";
    const result = await AgentTool.call(
      { prompt: "interruptible", subagent_type: "general", run_in_background: true },
      forkContext({ sessionId, abortSignal: controller.signal }),
    );
    const job = getJob(sessionId, result.metadata?.jobId as string);
    job?.kill?.();
    await job?.settled;
    expect(job?.status).toBe("killed");
  });
});

describe("AgentTool fork depth guard", () => {
  it("rejects a fork-of-a-fork (depth 1) — officially a fork can't spawn forks", async () => {
    const result = await AgentTool.call(
      { prompt: "fork again", subagent_type: "fork" },
      forkContext({ subagentDepth: 1 }),
    );
    expect(result.error).toContain("Fork nesting limit reached");
    expect(fake.caller).not.toHaveBeenCalled();
  });

  it("rejects a fork at the nesting limit before any model call", async () => {
    const result = await AgentTool.call(
      { prompt: "do nested work", subagent_type: "fork" },
      forkContext({ subagentDepth: 2 }),
    );
    expect(result.error).toContain("Fork nesting limit reached");
    expect(result.error).toContain("subagent_type");
    expect(fake.caller).not.toHaveBeenCalled();
  });

  it("rejects even deeper nesting — the total depth cap fires first", async () => {
    // Official 2.1.202 checks the overall nesting cap (depth >= 5) before the
    // fork-specific rule, so a fork at depth 5 gets the general message.
    const result = await AgentTool.call(
      { prompt: "deep", description: "deep" },
      forkContext({ subagentDepth: 5 }),
    );
    expect(result.error).toContain("Subagent nesting limit reached (depth 5 of 5)");
    expect(fake.caller).not.toHaveBeenCalled();
  });

  it("rejects a TYPED sub-agent at the total nesting cap (official S8t=5)", async () => {
    const result = await AgentTool.call(
      { prompt: "typed too deep", subagent_type: "general" },
      forkContext({ subagentDepth: 5 }),
    );
    expect(result.error).toContain("Subagent nesting limit reached (depth 5 of 5)");
    expect(fake.caller).not.toHaveBeenCalled();
  });

  it('explicit subagent_type "fork" (any case) takes the fork path — official 2.1.202', async () => {
    // Discriminator: at depth 1 only a FORK hits the fork-nesting cap; a
    // mistyped typed agent would run normally.
    const deep = await AgentTool.call(
      { prompt: "explicit fork", subagent_type: "Fork" },
      forkContext({ subagentDepth: 1 }),
    );
    expect(deep.error).toContain("Fork nesting limit reached");
    expect(fake.caller).not.toHaveBeenCalled();

    // At depth 0 it runs as a fork and completes.
    fake.caller.mockImplementation(async function* () {
      yield { type: "text_delta", delta: "fork report" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    });
    const result = await AgentTool.call(
      { prompt: "explicit fork", subagent_type: "fork" },
      forkContext(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("fork report");
  });

  it('explicit subagent_type "fork" without parent context errors instead of mistyping', async () => {
    const ctx = forkContext();
    delete ctx.getParentMessages;
    delete ctx.parentSystemPrompt;
    const result = await AgentTool.call({ prompt: "no ctx", subagent_type: "fork" }, ctx);
    expect(result.error).toContain("requires a parent session context");
    expect(fake.caller).not.toHaveBeenCalled();
  });

  it("permissions.deny Agent(fork) blocks an explicit fork but not the default agent", async () => {
    const denied = forkContext({
      permissionPolicy: { allow: [], deny: ["Agent(fork)"], ask: [] },
    });
    const explicit = await AgentTool.call({ prompt: "p", subagent_type: "fork" }, denied);
    expect(explicit.error).toContain("'fork' has been denied");
    expect(fake.caller).not.toHaveBeenCalled();
    // 拍板 a: omitting the type is the DEFAULT typed agent (general), not a
    // fork, so Agent(fork) must NOT block it.
    fake.caller.mockImplementation(async function* () {
      yield { type: "text_delta", delta: "general report" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    });
    const omitted = await AgentTool.call({ prompt: "general default" }, denied);
    expect(omitted.error).toBeUndefined();
    expect(omitted.content).toContain("general report");
  });

  it("normalized type names resolve (official bTt): case variants match", async () => {
    fake.caller.mockImplementation(async function* () {
      yield { type: "text_delta", delta: "typed report" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    });
    const result = await AgentTool.call(
      { prompt: "normalized", subagent_type: "General" },
      forkContext(),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("typed report");
  });

  it("does not apply the fork limit to typed sub-agents", async () => {
    // A typed sub-agent at depth 2 is a legitimate delegation (the limit
    // exists to stop CONTEXT-inheriting recursion, not typed fan-out). It
    // must pass the guard and actually start its loop — proved by the model
    // caller being invoked.
    const caller: ModelCaller = async function* () {
      yield { type: "text_delta", delta: "typed agent done" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    fake.caller.mockImplementation(caller);
    const result = await AgentTool.call(
      { prompt: "typed work", subagent_type: "general" },
      forkContext({ subagentDepth: 2 }),
    );
    expect(result.error).toBeUndefined();
    expect(fake.caller).toHaveBeenCalled();
    expect(result.content).toContain("typed agent done");
  });
});
