// ============================================================
// Team — stateful multi-agent collaboration (M10)
// ============================================================
// Where the Task tool spawns a one-shot, throwaway sub-agent, a Team is a
// set of NAMED agents that persist across messages: each keeps its own
// conversation history and status, so the main agent can create a team once
// and then send follow-up messages to specific members (point-to-point
// orchestration). State is keyed by sessionId so concurrent sessions stay
// isolated (same pattern as read-tracker / change-tracker).
//
// Agents reuse the sub-agent registry (src/subagents.ts) for their role's
// tool set and system prompt. Running an agent's turn reuses agentLoop, which
// mutates the agent's messages array in place — so history accumulates
// naturally across send_message calls.
// ============================================================

import type { Message, ModelConfig, PermissionMode, SubAgentProgress } from "./types.js";
import { agentLoop } from "./agent-loop.js";
import { createModelCaller } from "./llm-adapter.js";
import { getSubagentType, resolveSubagentTools } from "./subagents.js";

const AGENT_MAX_TURNS = 10;
const AGENT_COMPACT_THRESHOLD = 50_000;

export type AgentStatus = "idle" | "running" | "done" | "error" | "stopped";

export interface TeamAgent {
  id: string;
  role: string;
  messages: Message[];
  status: AgentStatus;
  lastOutput: string;
  toolCalls: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** Set while running so task_stop can abort it. */
  abort?: AbortController;
}

/** Context the team runner needs (threaded from the calling tool's ToolContext). */
export interface TeamRunContext {
  modelConfig: ModelConfig;
  workspaceRoot: string;
  sessionId: string;
  permissionMode: PermissionMode;
  onProgress?: (event: SubAgentProgress) => void;
}

// sessionId -> (agentId -> agent)
const teams = new Map<string, Map<string, TeamAgent>>();

function bucket(sessionId: string): Map<string, TeamAgent> {
  let m = teams.get(sessionId);
  if (!m) {
    m = new Map();
    teams.set(sessionId, m);
  }
  return m;
}

/** Sanitize a requested agent name into a stable id. */
function normalizeId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface CreateSpec {
  role: string;
  name?: string;
}

export interface CreateResult {
  created: Array<{ id: string; role: string }>;
  errors: string[];
}

/** Create one or more named agents in the session's team. */
export function createAgents(sessionId: string, specs: CreateSpec[]): CreateResult {
  const m = bucket(sessionId);
  const created: Array<{ id: string; role: string }> = [];
  const errors: string[] = [];
  let counter = m.size;

  for (const spec of specs) {
    const role = spec.role?.trim();
    if (!role || !getSubagentType(role)) {
      errors.push(`Unknown role "${spec.role}"`);
      continue;
    }
    let id = spec.name ? normalizeId(spec.name) : `${role}-${++counter}`;
    if (!id) id = `agent-${++counter}`;
    if (m.has(id)) {
      errors.push(`Agent id "${id}" already exists`);
      continue;
    }
    const now = Date.now();
    m.set(id, {
      id,
      role,
      messages: [],
      status: "idle",
      lastOutput: "",
      toolCalls: 0,
      createdAt: now,
      updatedAt: now,
    });
    created.push({ id, role });
  }
  return { created, errors };
}

export function getAgent(sessionId: string, id: string): TeamAgent | undefined {
  return teams.get(sessionId)?.get(normalizeId(id));
}

export function listAgents(sessionId: string): TeamAgent[] {
  return Array.from(teams.get(sessionId)?.values() ?? []);
}

export function stopAgent(sessionId: string, id: string): boolean {
  const agent = getAgent(sessionId, id);
  if (!agent) return false;
  if (agent.status === "running" && agent.abort) {
    agent.abort.abort("stopped by task_stop");
  }
  agent.status = "stopped";
  agent.updatedAt = Date.now();
  return true;
}

/** Test/util. */
export function resetTeams(): void {
  teams.clear();
}

// Lazy core-tool import to avoid a cycle (tools.ts → tools-team.ts → team.ts).
let _coreTools: import("./types.js").Tool[] | null = null;
async function getCoreTools(): Promise<import("./types.js").Tool[]> {
  if (!_coreTools) {
    const { ReadTool, GlobTool, GrepTool, BashTool, WriteTool, EditTool } = await import(
      "./tools.js"
    );
    _coreTools = [ReadTool, GlobTool, GrepTool, BashTool, WriteTool, EditTool];
  }
  return _coreTools;
}

export interface TurnResult {
  output: string;
  toolCalls: number;
  error?: string;
}

/**
 * Send `message` to an agent and run one turn of its loop. The agent's own
 * message history accumulates in place (agentLoop pushes assistant/tool
 * messages), so subsequent calls continue the same conversation.
 */
export async function runAgentTurn(
  ctx: TeamRunContext,
  agentId: string,
  message: string,
): Promise<TurnResult> {
  const agent = getAgent(ctx.sessionId, agentId);
  if (!agent) {
    return { output: "", toolCalls: 0, error: `No agent "${agentId}" in this team` };
  }
  const role = getSubagentType(agent.role);
  if (!role) {
    return { output: "", toolCalls: 0, error: `Agent role "${agent.role}" no longer registered` };
  }

  agent.messages.push({ role: "user", content: [{ type: "text", text: message }] });
  agent.status = "running";
  agent.updatedAt = Date.now();
  const abort = new AbortController();
  agent.abort = abort;

  const caller = createModelCaller(ctx.modelConfig);
  const systemPrompt = [role.systemPrompt, "", `You are team member "${agent.id}" (role: ${agent.role}).`].join("\n");

  const chunks: string[] = [];
  let toolCalls = 0;
  let error: string | undefined;

  try {
    const coreTools = await getCoreTools();
    const tools = resolveSubagentTools(role, coreTools);
    const loop = agentLoop(agent.messages, tools, caller, ctx.modelConfig, {
      systemPrompt,
      maxTurns: role.maxTurns ?? AGENT_MAX_TURNS,
      autoCompactThreshold: AGENT_COMPACT_THRESHOLD,
      abortSignal: abort.signal,
      toolContext: {
        workspaceRoot: ctx.workspaceRoot,
        sessionId: ctx.sessionId,
        permissionMode: ctx.permissionMode,
        modelConfig: ctx.modelConfig,
      },
    });

    for await (const event of loop) {
      switch (event.type) {
        case "text_delta":
          chunks.push(event.delta);
          break;
        case "tool_use":
          toolCalls++;
          ctx.onProgress?.({ subagentName: agent.id, phase: "tool_use", toolName: event.name, input: event.input });
          break;
        case "tool_results":
          ctx.onProgress?.({ subagentName: agent.id, phase: "tool_results", results: event.results });
          break;
        case "done":
          ctx.onProgress?.({ subagentName: agent.id, phase: "done" });
          break;
        case "aborted":
          error = event.reason;
          break;
        case "error":
          error = String(event.error);
          break;
      }
    }
  } catch (e: any) {
    error = e?.message || String(e);
  }

  const output = chunks.join("").trim();
  agent.toolCalls += toolCalls;
  agent.lastOutput = output;
  agent.updatedAt = Date.now();
  agent.abort = undefined;
  // A stop requested mid-run wins over done.
  if ((agent.status as AgentStatus) !== "stopped") {
    agent.status = error && !output ? "error" : "done";
  }
  if (error) agent.error = error;

  return { output, toolCalls, error };
}

