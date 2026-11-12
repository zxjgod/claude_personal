import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { runForkSkill } from "../skills/forkSkill.js";
import { registerSubagentType, setCoreToolsForSubagents } from "../subagents.js";
import { createAgents, getAgent, resetTeams, runAgentTurn } from "../team.js";
import { SendMessageTool } from "../tools/breadth/team.js";
import { AgentTool } from "../tools/extended/agent.js";
import { TaskTool } from "../tools/extended/task.js";
import { drainNotifications, resetNotifications } from "../tools/notifications.js";
import { buildTool } from "../tools/registry.js";
import type { ModelConfig, ToolContext, ToolResult } from "../types.js";
import { runWorkerAgent, runWorkflow } from "../workflow.js";

const state = vi.hoisted(() => ({ mode: "success" }));
vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () => {
    let calls = 0;
    return async function* () {
      calls++;
      if (state.mode === "empty") {
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 0 }, finish_reason: "stop" };
        return;
      }
      if (state.mode === "fatal-empty" || (state.mode === "fatal" && calls > 1)) {
        const error = Object.assign(new Error("fixture authentication failed"), { status: 401 });
        yield { type: "error", error };
        return;
      }
      yield {
        type: "text_delta",
        delta: state.mode === "success" ? "verified findings" : "partial findings",
      };
      if (state.mode === "fatal" || state.mode === "budget") {
        yield { type: "tool_use", id: `read-${calls}`, name: "read", input: {} };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
      } else
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
  },
}));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-subagent-outcomes-"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
  state.mode = "success";
  resetTeams();
  resetNotifications();
  registerSubagentType({
    name: "outcome-reader",
    description: "Read evidence",
    systemPrompt: "Read evidence and report",
    toolNames: ["read"],
    maxTurns: 20,
    omitClaudeMd: true,
  });
  setCoreToolsForSubagents([
    buildTool({
      name: "read",
      description: "Read",
      promptDescription: "Read",
      schema: z.strictObject({}),
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "inspected evidence" }),
    }),
  ]);
});
afterEach(() => {
  resetTeams();
  resetNotifications();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
const context = (): ToolContext & { modelConfig: ModelConfig } => ({
  workspaceRoot: root,
  sessionId: "outcome-parent",
  permissionMode: "default",
  modelConfig: { provider: "custom", model: "fixture", apiKey: "unused" },
});
const runners: Array<[string, (ctx: ToolContext) => Promise<ToolResult>]> = [
  [
    "Task",
    (ctx) =>
      TaskTool.call(
        { description: "Read", prompt: "Read evidence", subagent_name: "outcome-reader" },
        ctx,
      ),
  ],
  [
    "Agent",
    (ctx) => AgentTool.call({ prompt: "Read evidence", subagent_type: "outcome-reader" }, ctx),
  ],
  [
    "Team",
    async (ctx) => {
      createAgents(ctx.sessionId, [{ role: "outcome-reader", name: "reader" }]);
      return SendMessageTool.call({ agent_id: "reader", message: "Read evidence" }, ctx);
    },
  ],
  [
    "Workflow",
    async (ctx) => {
      try {
        return { content: await runWorkerAgent("Read evidence", ctx) };
      } catch (error) {
        return { content: "", error: String(error) };
      }
    },
  ],
  [
    "Fork Skill",
    (ctx) =>
      runForkSkill(
        {
          name: "outcome-skill",
          description: "Read",
          context: "fork",
          agent: "outcome-reader",
          getPromptForCommand: async () => "Read evidence",
        },
        "Read evidence",
        ctx,
      ),
  ],
];

it.each(
  runners,
)("%s reports partial text followed by a fatal error as incomplete", async (_name, run) => {
  state.mode = "fatal";
  const result = await run(context());
  expect(result.error).toBeTruthy();
  expect(`${result.content} ${result.error}`).toContain("partial findings");
});

it.each(runners)("%s preserves a genuinely successful report", async (_name, run) => {
  const result = await run(context());
  expect(result.error).toBeUndefined();
  expect(result.content).toContain("verified findings");
});

it.each(
  runners,
)("%s requires a report before marking a normal exit complete", async (_name, run) => {
  state.mode = "empty";
  expect((await run(context())).error).toBeTruthy();
});

it.each(runners)("%s labels turn-budget handoffs as incomplete", async (_name, run) => {
  state.mode = "budget";
  registerSubagentType({
    name: "outcome-reader",
    description: "Read",
    systemPrompt: "Read",
    toolNames: ["read"],
    maxTurns: 1,
    omitClaudeMd: true,
  });
  const result = await run(context());
  expect(Boolean(result.error || result.metadata?.incomplete)).toBe(true);
});

it.each(runners)("%s treats the stop-hook continuation cap as incomplete", async (_name, run) => {
  state.mode = "hook-limit";
  const ctx = context();
  ctx.hooks = {
    runPre: async () => ({}),
    runPost: async () => ({}),
    runStop: async () => ({ blockingError: "evidence not verified" }),
  };
  expect((await run(ctx)).error).toBeTruthy();
});

it("Team keeps partial error state in notifications and clears it after a later successful turn", async () => {
  const ctx = context();
  createAgents(ctx.sessionId, [{ role: "outcome-reader", name: "reader" }]);
  state.mode = "fatal";
  const first = await runAgentTurn(
    { ...ctx, modelConfig: ctx.modelConfig, notifyResults: true },
    "reader",
    "first",
  );
  expect(first.error).toBeTruthy();
  expect(getAgent(ctx.sessionId, "reader")?.status).toBe("error");
  expect(drainNotifications(ctx.sessionId).join("\n")).toContain("<status>error</status>");
  state.mode = "success";
  await runAgentTurn({ ...ctx, modelConfig: ctx.modelConfig }, "reader", "retry");
  expect(getAgent(ctx.sessionId, "reader")?.status).toBe("done");
  expect(getAgent(ctx.sessionId, "reader")?.error).toBeUndefined();
});

it("Team does not present an earlier turn's findings as output of a failed new turn", async () => {
  const ctx = context();
  createAgents(ctx.sessionId, [{ role: "outcome-reader", name: "reader" }]);
  await runAgentTurn({ ...ctx, modelConfig: ctx.modelConfig }, "reader", "first");
  state.mode = "fatal-empty";
  const result = await runAgentTurn({ ...ctx, modelConfig: ctx.modelConfig }, "reader", "second");
  expect(result.output).toBe("");
  expect(result.error).toBeTruthy();
});

it("Workflow does not cache a partial report from a failed worker as a completed step", async () => {
  state.mode = "fatal";
  const record = await runWorkflow(
    JSON.stringify({ steps: [{ agent: "Read evidence" }] }),
    context(),
  );
  expect(record.status).toBe("failed");
  const dir = path.join(root, ".claude", "workflow-runs");
  expect(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0).toBe(0);
});
