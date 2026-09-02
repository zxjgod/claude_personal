// ============================================================
// Tests: Team multi-agent layer (M10)
// ============================================================
// The pure state functions need no model. For runAgentTurn / tools, we mock
// the llm-adapter so a sub-agent loop yields a canned text + done, exercising
// history accumulation, status transitions, and the tool surface.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the model caller: yields one text chunk then done (no tool calls).
vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () =>
    async function* () {
      yield { type: "text_delta", delta: "agent reply" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    },
}));

import {
  createAgents,
  getAgent,
  listAgents,
  resetTeams,
  runAgentTurn,
  stopAgent,
  type TeamRunContext,
} from "../team.js";
import {
  SendMessageTool,
  TaskGetTool,
  TaskListTool,
  TaskStopTool,
  TeamCreateTool,
} from "../tools/breadth/team.js";
import type { ModelConfig, ToolContext } from "../types.js";

const modelConfig: ModelConfig = { provider: "deepseek", model: "deepseek-chat", apiKey: "k" };

function ctx(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "team-sess",
    permissionMode: "default",
    modelConfig,
  };
}

function runContext(): TeamRunContext {
  return {
    modelConfig,
    workspaceRoot: process.cwd(),
    sessionId: "team-sess",
    permissionMode: "default",
  };
}

beforeEach(() => resetTeams());

describe("team manager state", () => {
  it("creates named agents with valid roles", () => {
    const r = createAgents("team-sess", [
      { role: "code-explorer", name: "Scout" },
      { role: "general" },
    ]);
    expect(r.created).toHaveLength(2);
    expect(getAgent("team-sess", "scout")).toBeDefined();
    expect(r.errors).toHaveLength(0);
  });

  it("rejects unknown roles", () => {
    const r = createAgents("team-sess", [{ role: "nonsense" }]);
    expect(r.created).toHaveLength(0);
    expect(r.errors[0]).toContain("Unknown role");
  });

  it("rejects duplicate ids", () => {
    createAgents("team-sess", [{ role: "general", name: "worker" }]);
    const r = createAgents("team-sess", [{ role: "general", name: "worker" }]);
    expect(r.errors[0]).toContain("already exists");
  });

  it("isolates teams by session", () => {
    createAgents("s1", [{ role: "general", name: "a" }]);
    createAgents("s2", [{ role: "general", name: "b" }]);
    expect(listAgents("s1").map((x) => x.id)).toEqual(["a"]);
    expect(listAgents("s2").map((x) => x.id)).toEqual(["b"]);
  });

  it("stopAgent marks an agent stopped", () => {
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    expect(stopAgent("team-sess", "w")).toBe(true);
    expect(getAgent("team-sess", "w")!.status).toBe("stopped");
    expect(stopAgent("team-sess", "missing")).toBe(false);
  });
});

describe("runAgentTurn", () => {
  it("runs a turn, accumulates history, sets done", async () => {
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    const r = await runAgentTurn(runContext(), "w", "do something");
    expect(r.output).toBe("agent reply");
    const agent = getAgent("team-sess", "w")!;
    expect(agent.status).toBe("done");
    expect(agent.lastOutput).toBe("agent reply");
    // user message + assistant reply now in history
    expect(agent.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("continues the same conversation across turns", async () => {
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    await runAgentTurn(runContext(), "w", "first");
    await runAgentTurn(runContext(), "w", "second");
    const agent = getAgent("team-sess", "w")!;
    const userTexts = agent.messages
      .filter((m) => m.role === "user")
      .map((m) => (m as any).content[0].text);
    expect(userTexts).toEqual(["first", "second"]);
  });

  it("errors for an unknown agent", async () => {
    const r = await runAgentTurn(runContext(), "ghost", "hi");
    expect(r.error).toContain("No agent");
  });
});

describe("team tools", () => {
  it("team_create reports created agents", async () => {
    const r = await TeamCreateTool.call(
      { agents: [{ role: "code-explorer", name: "scout" }] },
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("scout");
  });

  it("team_create errors when all roles invalid", async () => {
    const r = await TeamCreateTool.call({ agents: [{ role: "bogus" }] }, ctx());
    expect(r.error).toContain("No agents created");
  });

  it("send_message returns the agent reply", async () => {
    await TeamCreateTool.call({ agents: [{ role: "general", name: "w" }] }, ctx());
    const r = await SendMessageTool.call({ agent_id: "w", message: "go" }, ctx());
    expect(r.content).toContain("agent reply");
  });

  it("send_message background returns immediately and task_get polls", async () => {
    await TeamCreateTool.call({ agents: [{ role: "general", name: "bg" }] }, ctx());
    const r = await SendMessageTool.call(
      { agent_id: "bg", message: "go", background: true },
      ctx(),
    );
    expect(r.content).toContain("background");
    // Let the fire-and-forget turn settle.
    await new Promise((res) => setTimeout(res, 20));
    const got = await TaskGetTool.call({ agent_id: "bg" }, ctx());
    expect(got.content).toContain("agent reply");
  });

  it("send_message errors for unknown agent", async () => {
    const r = await SendMessageTool.call({ agent_id: "nope", message: "x" }, ctx());
    expect(r.error).toContain("No agent");
  });

  it("task_list shows team members", async () => {
    await TeamCreateTool.call({ agents: [{ role: "general", name: "w" }] }, ctx());
    const r = await TaskListTool.call({}, ctx());
    expect(r.content).toContain("w");
    expect(r.content).toContain("general");
  });

  it("task_stop stops an agent", async () => {
    await TeamCreateTool.call({ agents: [{ role: "general", name: "w" }] }, ctx());
    const r = await TaskStopTool.call({ agent_id: "w" }, ctx());
    expect(r.content).toContain("stopped");
    expect(getAgent("team-sess", "w")!.status).toBe("stopped");
  });
});

describe("team_delete + parent-signal cascade (M35)", () => {
  it("deleteAgent removes an agent and its history", async () => {
    const { deleteAgent } = await import("../team.js");
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    expect(getAgent("team-sess", "w")).toBeDefined();
    expect(deleteAgent("team-sess", "w")).toBe(true);
    expect(getAgent("team-sess", "w")).toBeUndefined();
    // Deleting a missing agent returns false.
    expect(deleteAgent("team-sess", "w")).toBe(false);
  });

  it("TeamDeleteTool deletes via the tool surface", async () => {
    const { TeamDeleteTool } = await import("../tools/breadth/team.js");
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    const r = await TeamDeleteTool.call({ agent_id: "w" }, ctx());
    expect(r.content).toContain("deleted");
    expect(getAgent("team-sess", "w")).toBeUndefined();
  });

  it("a parent signal abort cascades into a running agent turn", async () => {
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    const parent = new AbortController();
    // Abort the parent before the turn runs: the agent's forked scope is born
    // aborted, so the loop stops immediately and the turn yields no output.
    parent.abort("parent gone");
    const res = await runAgentTurn(
      { ...runContext(), parentSignal: parent.signal },
      "w",
      "do work",
    );
    expect(res.output).toBe("");
  });
});

describe("runAgentTurn — notifyResults (M41)", () => {
  it("pushes a task notification when the turn was requested as a background handoff", async () => {
    const { drainNotifications, resetNotifications } = await import("../tools/notifications.js");
    resetNotifications("team-sess");
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    const r = await runAgentTurn({ ...runContext(), notifyResults: true }, "w", "do something");
    expect(r.output).toBe("agent reply");
    const drained = drainNotifications("team-sess");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("<task_id>team-w</task_id>");
    expect(drained[0]).toContain("<kind>team</kind>");
    expect(drained[0]).toContain("<status>done</status>");
    expect(drained[0]).toContain("agent reply");
  });

  it("pushes nothing for a synchronous turn (notifyResults off)", async () => {
    const { drainNotifications, resetNotifications } = await import("../tools/notifications.js");
    resetNotifications("team-sess");
    createAgents("team-sess", [{ role: "general", name: "w" }]);
    await runAgentTurn(runContext(), "w", "do something");
    expect(drainNotifications("team-sess")).toEqual([]);
  });

  it("background send_message reports its completion through the notification queue", async () => {
    const { drainNotifications, resetNotifications } = await import("../tools/notifications.js");
    resetNotifications("team-sess");
    await TeamCreateTool.call({ agents: [{ role: "general", name: "bg" }] }, ctx());
    await SendMessageTool.call({ agent_id: "bg", message: "go", background: true }, ctx());
    // Let the fire-and-forget turn settle.
    await new Promise((res) => setTimeout(res, 20));
    const drained = drainNotifications("team-sess");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("<task_id>team-bg</task_id>");
    expect(drained[0]).toContain("<status>done</status>");
  });
});
