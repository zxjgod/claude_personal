import type { Message, ModelCaller, ModelConfig } from "./types.js";
export interface GoalState {
  objective: string;
  complete: boolean;
  checks: number;
  reason?: string;
  suspended?: boolean;
}
const goals = new Map<string, GoalState>();
/** Hard cap on paid evaluator calls per goal — each check is a real model call. */
export const MAX_GOAL_CHECKS = 20;
export function setSessionGoal(sessionId: string, objective: string): void {
  if (!objective) goals.delete(sessionId);
  else goals.set(sessionId, { objective, complete: false, checks: 0 });
}
export function sessionGoal(sessionId: string): GoalState | undefined {
  return goals.get(sessionId);
}
export function releaseSessionGoal(sessionId: string): void {
  goals.delete(sessionId);
}
export function restoreGoal(sessionId: string, value: unknown): void {
  goals.delete(sessionId);
  if (typeof value === "string" && value) {
    goals.set(sessionId, {
      objective: value,
      complete: false,
      checks: 0,
      suspended: true,
      reason: "Legacy goal has no completion state; set /goal again to resume automatic work.",
    });
  } else if (value && typeof value === "object") {
    const state = value as Partial<GoalState>;
    if (typeof state.objective === "string" && state.objective)
      goals.set(sessionId, {
        objective: state.objective,
        complete: state.complete === true,
        checks:
          Number.isInteger(state.checks) && Number(state.checks) >= 0 ? Number(state.checks) : 0,
        reason: typeof state.reason === "string" ? state.reason : undefined,
        suspended: state.suspended === true,
      });
  }
}
export function suspendGoal(sessionId: string, reason: string): void {
  const goal = goals.get(sessionId);
  if (goal) {
    goal.suspended = true;
    goal.reason = reason;
  }
}
export async function evaluateSessionGoal(
  sessionId: string,
  messages: Message[],
  call: ModelCaller,
  config: ModelConfig,
  signal?: AbortSignal,
): Promise<GoalState | undefined> {
  const goal = goals.get(sessionId);
  if (!goal || goal.complete || goal.suspended) return goal;
  if (goal.checks >= MAX_GOAL_CHECKS) {
    goal.suspended = true;
    goal.reason = `Goal evaluation stopped after ${MAX_GOAL_CHECKS} checks; set /goal again to resume.`;
    return goal;
  }
  if (signal?.aborted) throw signal.reason ?? new Error("Goal evaluation cancelled");
  const evidence = messages
    .slice(-16)
    .map((message) =>
      message.role === "tool"
        ? `${message.name}: ${message.content}`
        : typeof message.content === "string"
          ? `${message.role}: ${message.content}`
          : `${message.role}: ${JSON.stringify(message.content)}`,
    )
    .join("\n")
    .slice(-24000);
  let output = "";
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  for await (const event of call(
    [
      {
        role: "user",
        content: [{ type: "text", text: `Objective: ${goal.objective}\nEvidence:\n${evidence}` }],
      },
    ],
    [],
    'Evaluate the objective independently using concrete evidence. Never accept a claim of success without evidence. Return JSON {"complete":boolean,"reason":string}. If incomplete, identify the next required action.',
    { ...config, maxTokens: 1024 },
    combined,
  )) {
    if (event.type === "text_delta") output += event.delta;
    if (event.type === "error") throw event.error;
  }
  // Count every paid evaluation up front — including failed/invalid ones — so
  // a model that keeps returning non-JSON cannot retry forever without a trace.
  goal.checks++;
  try {
    const value = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, "")) as {
      complete?: unknown;
      reason?: unknown;
    };
    if (typeof value.complete !== "boolean") throw new Error("Invalid goal evaluator result");
    goal.complete = value.complete;
    goal.reason = typeof value.reason === "string" ? value.reason : "";
  } catch (error) {
    goal.reason = `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
    if (goal.checks >= MAX_GOAL_CHECKS) goal.suspended = true;
    throw error;
  }
  return goal;
}
