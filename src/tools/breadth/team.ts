// ============================================================
// Team tools — TeamCreate / SendMessage / TaskList/Get/Stop (M10)
// ============================================================
// Expose the stateful Team layer (src/team.ts) to the main agent so it can
// orchestrate a set of named collaborators point-to-point. All tools read
// modelConfig/workspaceRoot/sessionId/permissionMode from ToolContext, like
// the Task tool. send_message supports a lightweight background mode (10.4):
// fire-and-forget, then poll with task_get / task_list.
// ============================================================

import { z } from "zod";
import { listSubagentNames } from "../../subagents.js";
import {
  type AgentStatus,
  createAgents,
  deleteAgent,
  getAgent,
  listAgents,
  runAgentTurn,
  stopAgent,
  type TeamRunContext,
} from "../../team.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

function runCtx(context: ToolContext, notifyResults = false): TeamRunContext | { error: string } {
  if (!context.modelConfig) {
    return { error: "Team tools require modelConfig in context (CLI must provide it)." };
  }
  return {
    modelConfig: context.modelConfig,
    workspaceRoot: context.workspaceRoot,
    sessionId: context.sessionId,
    permissionMode: context.permissionMode,
    onProgress: context.onSubAgentProgress,
    // Forward the parent loop's approver into team agent sub-loops so their
    // destructive tool calls prompt the user instead of auto-approving.
    askUser: context.askUser,
    // M35: thread the parent's signal so a parent abort cascades into agents.
    parentSignal: context.abortSignal,
    // M41: background turns push their completion as a task notification.
    notifyResults,
  };
}

function preview(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

// --- 10.1 TeamCreate ---

const TeamCreateSchema = z.strictObject({
  agents: z
    .array(z.strictObject({ role: z.string(), name: z.string().optional() }))
    .min(1)
    .describe("Agents to create: each { role, name? }"),
});

export const TeamCreateTool: Tool = buildTool({
  name: "team_create",
  description: "Create a team of named, stateful collaborator agents",
  promptDescription:
    "Create one or more named agents that persist across messages (unlike the " +
    "one-shot `task` tool). Pass agents: [{role, name?}]. Each keeps its own " +
    `conversation history. Available roles: ${listSubagentNames().join(", ")}. ` +
    "After creating, use send_message to talk to a member by id.",
  schema: TeamCreateSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    if (!Array.isArray(input.agents) || input.agents.length === 0) {
      return { content: "", error: "agents must be a non-empty array of { role, name? }" };
    }
    const { created, errors } = createAgents(context.sessionId, input.agents);
    if (created.length === 0) {
      return { content: "", error: `No agents created. ${errors.join("; ")}` };
    }
    const lines = created.map((a) => `- ${a.id} (role: ${a.role})`);
    const errNote = errors.length > 0 ? `\nSkipped: ${errors.join("; ")}` : "";
    return {
      content: `Created ${created.length} agent(s):\n${lines.join("\n")}${errNote}\nUse send_message <id> to talk to them.`,
    };
  },
});

// --- 10.2 / 10.4 SendMessage ---

const SendMessageSchema = z.strictObject({
  agent_id: z.string().describe("Target agent id (from team_create)"),
  message: z.string().describe("Message / instructions for the agent"),
  background: z
    .boolean()
    .optional()
    .describe("Run without waiting; check later with task_get. Defaults false."),
});

export const SendMessageTool: Tool = buildTool({
  name: "send_message",
  description: "Send a message to a team agent and get its reply",
  promptDescription:
    "Send a message to a team member by id; it runs a turn with its accumulated " +
    "history and returns its reply. Set background:true to run without waiting " +
    "(fire-and-forget) — then poll with task_get/task_list. Create members first " +
    "with team_create.",
  schema: SendMessageSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    const agentId = input.agent_id.trim();
    const message = input.message.trim();
    if (!agentId) return { content: "", error: "agent_id is required" };
    if (!message) return { content: "", error: "message is required" };

    const agent = getAgent(context.sessionId, agentId);
    if (!agent) {
      const known = listAgents(context.sessionId).map((a) => a.id);
      return {
        content: "",
        error: `No agent "${agentId}". ${known.length ? `Known: ${known.join(", ")}` : "Create one with team_create."}`,
      };
    }
    if (agent.status === "running") {
      return { content: "", error: `Agent "${agentId}" is busy (running). Wait or use task_get.` };
    }

    const ctx = runCtx(context, input.background === true);
    if ("error" in ctx) return { content: "", error: ctx.error };

    if (input.background === true) {
      void runAgentTurn(ctx, agentId, message).catch(() => {});
      return {
        content: `Sent to "${agentId}" in background. Use task_get ${agentId} to check progress.`,
      };
    }

    const result = await runAgentTurn(ctx, agentId, message);
    if (result.error && !result.output) {
      return { content: "", error: `Agent "${agentId}" failed: ${result.error}` };
    }
    const header = `[${agentId}] replied (${result.toolCalls} tool call(s)):\n\n`;
    return { content: header + (result.output || "(no output)") };
  },
});

// --- 10.3 TaskList / TaskGet / TaskStop ---

function statusGlyph(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "⏳";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "stopped":
      return "⊘";
    default:
      return "·";
  }
}

export const TaskListTool: Tool = buildTool({
  name: "task_list",
  description: "List all team agents and their status",
  promptDescription:
    "List every agent in the team with id, role, status, tool-call count, and a " +
    "preview of its last output. Use to see what background agents are doing.",
  schema: z.strictObject({}),
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(_input, context): Promise<ToolResult> {
    const agents = listAgents(context.sessionId);
    if (agents.length === 0) {
      return { content: "No team agents. Create some with team_create." };
    }
    const lines = agents.map(
      (a) =>
        `${statusGlyph(a.status)} ${a.id} (${a.role}) — ${a.status}, ${a.toolCalls} tool call(s)` +
        (a.lastOutput ? `\n    ↳ ${preview(a.lastOutput, 120)}` : ""),
    );
    return { content: `Team (${agents.length}):\n${lines.join("\n")}` };
  },
});

const TaskGetSchema = z.strictObject({
  agent_id: z.string().describe("Agent id"),
});

export const TaskGetTool: Tool = buildTool({
  name: "task_get",
  description: "Get a team agent's status and last output",
  promptDescription:
    "Get one agent's current status and full last output by id. Use after a " +
    "background send_message to read the result once status is done.",
  schema: TaskGetSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context): Promise<ToolResult> {
    const agent = getAgent(context.sessionId, input.agent_id);
    if (!agent) return { content: "", error: `No agent "${input.agent_id}"` };
    const head = `[${agent.id}] role=${agent.role} status=${agent.status} toolCalls=${agent.toolCalls}`;
    const err = agent.error ? `\nError: ${agent.error}` : "";
    const body = agent.lastOutput
      ? `\n\n--- Last output ---\n${agent.lastOutput}`
      : "\n(no output yet)";
    return { content: head + err + body };
  },
});

const TaskStopSchema = z.strictObject({
  agent_id: z.string().describe("Agent id"),
});

export const TaskStopTool: Tool = buildTool({
  name: "task_stop",
  description: "Stop a team agent (abort if running)",
  promptDescription:
    "Stop an agent by id. If it's running, its current turn is aborted; the agent " +
    "is marked stopped. Its history is preserved.",
  schema: TaskStopSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    const ok = stopAgent(context.sessionId, input.agent_id);
    if (!ok) return { content: "", error: `No agent "${input.agent_id}"` };
    return { content: `Agent "${input.agent_id}" stopped.` };
  },
});

const TeamDeleteSchema = z.strictObject({
  agent_id: z.string().describe("Agent id"),
});

export const TeamDeleteTool: Tool = buildTool({
  name: "team_delete",
  description: "Delete a team agent (aborts if running)",
  promptDescription:
    "Remove an agent from the team by id. If it's running, its current turn is " +
    "aborted first. Its history is discarded — use task_stop instead if you want " +
    "to keep the agent for later.",
  schema: TeamDeleteSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    const ok = deleteAgent(context.sessionId, input.agent_id);
    if (!ok) return { content: "", error: `No agent "${input.agent_id}"` };
    return { content: `Agent "${input.agent_id}" deleted.` };
  },
});

export const TEAM_TOOLS: Tool[] = [
  TeamCreateTool,
  SendMessageTool,
  TaskListTool,
  TaskGetTool,
  TaskStopTool,
  TeamDeleteTool,
];
