import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { permissionRuleMatches, policyDecision } from "../permission-policy.js";
import { runForkSkill } from "../skills/forkSkill.js";
import { registerSubagentType, setCoreToolsForSubagents } from "../subagents.js";
import { createAgents, resetTeams, runAgentTurn } from "../team.js";
import { AgentTool } from "../tools/extended/agent.js";
import { TaskTool } from "../tools/extended/task.js";
import { buildTool } from "../tools/registry.js";
import type { Message, ToolContext } from "../types.js";
import { runWorkerAgent } from "../workflow.js";

vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () =>
    async function* (messages: Message[]) {
      if (!messages.some((m) => m.role === "tool")) {
        yield { type: "tool_use", id: "read-1", name: "read", input: {} };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
      } else {
        yield { type: "text_delta", delta: "Finished" };
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
      }
    },
}));

const read = vi.fn(async () => ({ content: "read executed" }));
const context = () => ({
  workspaceRoot: process.cwd(),
  sessionId: "delegated-policy",
  permissionMode: "default" as const,
  modelConfig: { provider: "custom" as const, model: "review", apiKey: "unused" },
  askUser: vi.fn(async () => false),
});

beforeEach(() => {
  read.mockClear();
  resetTeams();
  registerSubagentType({
    name: "policy-reader",
    description: "Test reader",
    systemPrompt: "Read once",
    toolNames: ["read"],
    maxTurns: 2,
  });
  setCoreToolsForSubagents([
    buildTool({
      name: "read",
      description: "Read",
      promptDescription: "Read",
      schema: z.strictObject({}),
      isReadOnly: true,
      isConcurrencySafe: true,
      call: read,
    }),
  ]);
});

const runners: Array<
  [string, (ctx: ReturnType<typeof context> & ToolContext) => Promise<unknown>]
> = [
  [
    "Task",
    (ctx) =>
      TaskTool.call({ description: "Read", prompt: "read", subagent_name: "policy-reader" }, ctx),
  ],
  [
    "Agent",
    (ctx) =>
      AgentTool.call({ description: "Read", prompt: "read", subagent_type: "policy-reader" }, ctx),
  ],
  [
    "Team",
    (ctx) => {
      createAgents(ctx.sessionId, [{ role: "policy-reader", name: "reader" }]);
      return runAgentTurn(ctx, "reader", "read");
    },
  ],
  ["Workflow", (ctx) => runWorkerAgent("read", ctx)],
  [
    "Fork Skill",
    (ctx) =>
      runForkSkill(
        {
          name: "policy-skill",
          description: "Read",
          context: "fork",
          agent: "policy-reader",
          getPromptForCommand: async () => "read",
        },
        "read",
        ctx,
      ),
  ],
];

describe("delegated execution constraints", () => {
  it("runs Agent post-tool and stop hooks on successful execution", async () => {
    const runPost = vi.fn(async () => ({}));
    const runStop = vi.fn(async () => ({}));
    const ctx = { ...context(), hooks: { runPre: async () => ({}), runPost, runStop } };
    await AgentTool.call(
      { description: "Read", prompt: "read", subagent_type: "policy-reader" },
      ctx,
    );
    expect(read).toHaveBeenCalledOnce();
    expect(runPost).toHaveBeenCalledOnce();
    expect(runStop).toHaveBeenCalledOnce();
  });
  it.each(runners)("%s preserves a parent's Read deny rule", async (_name, run) => {
    const ctx = { ...context(), permissionPolicy: { allow: [], deny: ["Read"], ask: [] } };
    await run(ctx);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(runners)("%s asks the parent when a read matches an ask rule", async (_name, run) => {
    const ctx = { ...context(), permissionPolicy: { allow: [], deny: [], ask: ["Read"] } };
    await run(ctx);
    expect(ctx.askUser).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(runners)("%s honors a parent's blocking tool hook", async (_name, run) => {
    const runPre = vi.fn(async () => ({ block: true, reason: "blocked by parent" }));
    const ctx = { ...context(), hooks: { runPre, runPost: vi.fn(async () => ({})) } };
    await run(ctx);
    expect(runPre).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("subagent-type deny rules (official: Disable specific subagents)", () => {
  it("matches subagent_name (task) and subagent_type (Agent) case-insensitively", () => {
    expect(
      permissionRuleMatches("Task(code-explorer)", "task", { subagent_name: "code-explorer" }),
    ).toBe(true);
    expect(
      permissionRuleMatches("Agent(Code-Explorer)", "Agent", { subagent_type: "code-explorer" }),
    ).toBe(true);
    expect(permissionRuleMatches("Task(general)", "task", { subagent_name: "code-explorer" })).toBe(
      false,
    );
  });

  it("Task(*) covers forks too (no type field in the input)", () => {
    expect(permissionRuleMatches("Task(*)", "task", { description: "d", prompt: "p" })).toBe(true);
  });

  it("does not leak type rules into other tools' matching", () => {
    expect(permissionRuleMatches("Task(code-explorer)", "bash", { command: "code-explorer" })).toBe(
      false,
    );
  });

  it("policyDecision denies a typed spawn through the generic gate", () => {
    expect(
      policyDecision({ allow: [], deny: ["Task(code-explorer)"], ask: [] }, "task", {
        description: "d",
        prompt: "p",
        subagent_name: "code-explorer",
      }),
    ).toBe("deny");
  });

  it("Task rejects a denied type before any model call", async () => {
    const ctx = {
      ...context(),
      permissionPolicy: { allow: [], deny: ["Task(policy-reader)"], ask: [] },
    };
    const r = await TaskTool.call(
      { description: "Read", prompt: "read", subagent_name: "policy-reader" },
      ctx,
    );
    expect(r.error).toContain("denied by permissions.deny");
    expect(read).not.toHaveBeenCalled();
  });

  it("Agent rejects a denied type case-insensitively", async () => {
    const ctx = {
      ...context(),
      permissionPolicy: { allow: [], deny: ["Agent(Policy-Reader)"], ask: [] },
    };
    const r = await AgentTool.call(
      { description: "Read", prompt: "read", subagent_type: "policy-reader" },
      ctx,
    );
    expect(r.error).toContain("denied by permissions.deny");
    expect(read).not.toHaveBeenCalled();
  });

  it("denying one type leaves the others spawnable", async () => {
    const ctx = {
      ...context(),
      permissionPolicy: { allow: [], deny: ["Task(code-explorer)"], ask: [] },
    };
    const r = await TaskTool.call(
      { description: "Read", prompt: "read", subagent_name: "policy-reader" },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(read).toHaveBeenCalled();
  });

  it("the unknown-type error hides denied types from the suggestion list", async () => {
    const ctx = {
      ...context(),
      permissionPolicy: { allow: [], deny: ["Task(code-explorer)"], ask: [] },
    };
    const r = await TaskTool.call({ description: "d", prompt: "p", subagent_name: "nope" }, ctx);
    expect(r.error).toContain("Unknown subagent type");
    expect(r.error).not.toContain("code-explorer");
    expect(r.error).toContain("policy-reader");
  });
});
