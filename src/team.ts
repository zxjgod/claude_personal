import { scopedHooks } from "./scoped-execution.js";
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

import { agentLoop, WORKER_COMPACT_THRESHOLD } from "./agent-loop.js";
import { createModelCaller } from "./llm-adapter.js";
import {
  buildSubagentSystemPrompt,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  getSubagentType,
  preloadAgentSkills,
  resolveSubagentTools,
  subagentModelConfig,
} from "./subagents.js";
import { pushTaskNotification } from "./tools/notifications.js";
import {
  type AskUserFn,
  deriveSubContext,
  type Message,
  type ModelConfig,
  type PermissionMode,
  type SubAgentProgress,
  type ToolContext,
} from "./types.js";
import { CancellationScope } from "./utils/cancellation.js";
import { Semaphore } from "./utils/semaphore.js";
import { createSubAgentApprover } from "./utils/subagent-security.js";

const AGENT_MAX_TURNS = 10;

// Max team agents running a turn at once. The Task and Agent tools each cap
// their own fan-out; team had no cap, so N `send_message` calls in one turn
// opened N concurrent agentLoops straight at the provider. Deliberately a
// SEPARATE semaphore from Task's/Agent's so a mixed fan-out doesn't starve
// either kind — same reasoning as agent.ts. Override via TEAM_MAX_CONCURRENCY.
const MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.TEAM_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
})();

const teamSlots = new Semaphore(MAX_CONCURRENCY, "Team agent");

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
  /** Cancellation scope set while running so task_stop can abort it (M35). */
  scope?: CancellationScope;
}

/** Context the team runner needs (threaded from the calling tool's ToolContext). */
export interface TeamRunContext {
  modelConfig: ModelConfig;
  workspaceRoot: string;
  sessionId: string;
  permissionMode: PermissionMode;
  permissionPolicy?: ToolContext["permissionPolicy"];
  onProgress?: (event: SubAgentProgress) => void;
  /**
   * Parent loop's interactive approver, forwarded into each agent's sub-loop so
   * a team agent's destructive tool calls (bash/write/edit) prompt the user
   * instead of being auto-approved. Absent in tests.
   */
  askUser?: AskUserFn;
  /**
   * Parent loop's cancellation signal (M35, kernel §9). When present, each
   * agent's run is forked from it, so a parent Ctrl+C / abort cascades into the
   * team agent's loop. Absent → the agent's own controller is the root (current
   * behavior: only task_stop can abort it).
   */
  parentSignal?: AbortSignal;
  /**
   * Push the turn's result as a background completion notification (M41) so a
   * fire-and-forget send_message (background:true) reaches the main loop
   * without task_get polling. Synchronous callers leave this off — they
   * already receive the return value.
   */
  notifyResults?: boolean;
  hooks?: import("./types.js").HookRunner;
}

// sessionId -> (agentId -> agent)
const teams = new Map<string, Map<string, TeamAgent>>();
export function restoreTeam(sessionId: string, values: unknown[]): void {
  const members = bucket(sessionId);
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<TeamAgent>;
    if (
      typeof entry.id !== "string" ||
      typeof entry.role !== "string" ||
      !Array.isArray(entry.messages)
    )
      continue;
    const interrupted = entry.status === "running";
    members.set(entry.id, {
      id: entry.id,
      role: entry.role,
      messages: entry.messages.filter(
        (message) => message && ["user", "assistant", "system", "tool"].includes(message.role),
      ),
      status: interrupted
        ? "stopped"
        : ["idle", "done", "error", "stopped"].includes(String(entry.status))
          ? entry.status!
          : "idle",
      lastOutput: entry.lastOutput ?? "",
      toolCalls: entry.toolCalls ?? 0,
      createdAt: entry.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      error: interrupted
        ? "Previous process ended during this agent turn; send a follow-up to continue."
        : entry.error,
    });
  }
}

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
  if (agent.status === "running" && agent.scope) {
    agent.scope.cancel("hard", "stopped by task_stop");
  }
  agent.status = "stopped";
  agent.updatedAt = Date.now();
  return true;
}

/**
 * Remove an agent from the team (M35). If it is running, its scope is cancelled
 * first so the in-flight loop stops, then the entry is deleted along with its
 * accumulated history. Returns false when no such agent exists.
 */
export function deleteAgent(sessionId: string, id: string): boolean {
  const m = teams.get(sessionId);
  const agent = m?.get(normalizeId(id));
  if (!m || !agent) return false;
  if (agent.status === "running" && agent.scope) {
    agent.scope.cancel("hard", "deleted by team_delete");
  }
  return m.delete(normalizeId(id));
}

/** Test/util. */
export function resetTeams(): void {
  teams.clear();
  // The semaphore is a module singleton, so a test whose turn was aborted
  // mid-flight (or that deliberately over-subscribes) would otherwise leak
  // slots into the next case and make later ones hang on acquire().
  teamSlots.reset();
}

/** Current team concurrency cap (exported for tests and /status). */
export function teamConcurrencyLimit(): number {
  return MAX_CONCURRENCY;
}

// Core tools for team-agent resolution come from the subagents registry (CLI
// injects them at startup, 16.9), breaking the old tools.ts → tools-team.ts →
// team.ts → tools.ts cycle that was patched with a lazy dynamic import.

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
  // M35: fork the agent's scope from the parent signal so a parent abort
  // cascades; task_stop still cancels this scope directly.
  const scope = new CancellationScope(ctx.parentSignal);
  agent.scope = scope;

  // Bound the fan-out. Acquired AFTER the scope exists so a queued turn still
  // aborts cleanly (Ctrl+C / task_stop while waiting for a slot), and released
  // in the finally below so an early throw can never strand a slot.
  let slotHeld = false;
  try {
    await teamSlots.acquire(scope.signal);
    slotHeld = true;
  } catch (e) {
    scope.dispose();
    agent.scope = undefined;
    agent.status = "stopped";
    agent.updatedAt = Date.now();
    // The turn never ran — retract the queued user message so the history
    // isn't left holding an unanswered message the model would see (and
    // treat as acknowledged) on the next send_message. Safe to pop: the
    // busy guard rejects concurrent turns, so ours is the last entry.
    agent.messages.pop();
    return {
      output: "",
      toolCalls: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let toolCalls = 0;
  let error: string | undefined;

  try {
    const config = subagentModelConfig(role, ctx.modelConfig);
    const caller = createModelCaller(config);
    const systemPrompt = buildSubagentSystemPrompt(
      role,
      [
        role.systemPrompt,
        "",
        `You are team member "${agent.id}" (role: ${agent.role}).`,
        await preloadAgentSkills(role, ctx.workspaceRoot),
      ].join("\n"),
      { workspaceRoot: ctx.workspaceRoot },
    );
    const coreTools = await getCoreToolsForSubagents();
    const tools = resolveSubagentTools(role, coreTools);

    // P0 Security Fix: Use restricted approver to prevent sub-agents
    // from bypassing permissions on dangerous tools (bash/write/edit)
    const subApprover = createSubAgentApprover(ctx.askUser, true);

    const loop = agentLoop(agent.messages, tools, caller, config, {
      systemPrompt,
      maxTurns: role.maxTurns ?? AGENT_MAX_TURNS,
      autoCompactThreshold: WORKER_COMPACT_THRESHOLD,
      abortSignal: scope.signal,
      toolContext: deriveSubContext(ctx, {
        modelConfig: config,
        askUser: subApprover,
        abortSignal: scope.signal,
        hooks: scopedHooks(ctx.hooks, role.hooks, ctx.sessionId, ctx.workspaceRoot),
        permissionMode:
          ctx.permissionMode === "plan"
            ? "plan"
            : role.permissionMode === "plan" || role.permissionMode === "dontAsk"
              ? role.permissionMode
              : ctx.permissionMode,
      }),
      // Also pass restricted askUser at the LoopOptions level
      askUser: subApprover,
    });

    for await (const event of loop) {
      switch (event.type) {
        case "tool_use":
          toolCalls++;
          ctx.onProgress?.({
            subagentName: agent.id,
            phase: "tool_use",
            toolName: event.name,
            input: event.input,
          });
          break;
        case "tool_results":
          ctx.onProgress?.({
            subagentName: agent.id,
            phase: "tool_results",
            results: event.results,
          });
          break;
        case "done":
          ctx.onProgress?.({ subagentName: agent.id, phase: "done", reason: event.finishReason });
          break;
        case "aborted":
          error = event.reason;
          break;
        case "error":
          error = String(event.error);
          break;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    if (slotHeld) {
      teamSlots.release();
      slotHeld = false;
    }
    scope.dispose();
    agent.scope = undefined;
  }

  // Context protection (kernel §4): the agent's output is ONLY its final
  // assistant text, not its accumulated turn-by-turn narration. agentLoop
  // mutated agent.messages in place, so the last assistant text lives there.
  const output = extractLastAssistantText(agent.messages);
  agent.toolCalls += toolCalls;
  agent.lastOutput = output;
  agent.updatedAt = Date.now();
  // A stop requested mid-run wins over done.
  if ((agent.status as AgentStatus) !== "stopped") {
    agent.status = error && !output ? "error" : "done";
  }
  if (error) agent.error = error;

  // M41: push, rather than requiring lead-side polling, when the turn was
  // requested as a background handoff. Existing synchronous callers still
  // receive the return value as before.
  if (ctx.notifyResults) {
    pushTaskNotification(ctx.sessionId, {
      id: `team-${agent.id}`,
      kind: "team",
      status: error && !output ? "error" : "done",
      summary: `team agent ${agent.id} completed`,
      outputTail: (output || error || "").slice(-500) || undefined,
    });
  }
  if (agent.status === "done") {
    await ctx.hooks
      ?.runEvent?.("TeammateIdle", {
        session_id: ctx.sessionId,
        teammate_id: agent.id,
        status: agent.status,
      })
      .catch(() => {});
  }

  return { output, toolCalls, error };
}
