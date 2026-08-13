// ============================================================
// Workflow — model-written orchestration scripts (Phase 3)
// ============================================================
// Mirrors Claude Code's "dynamic workflows": the model writes a small JS
// orchestration script that fans out worker sub-agents in parallel, verifies
// their output, and returns a synthesis. The script runs in a `vm` sandbox
// with a handful of injected helpers; `agent()` spawns a real sub-agent loop
// (read-only by default) and returns only its final text, so a wide fan-out
// stays within a bounded concurrency cap instead of hammering the provider.
// ============================================================

import * as vm from "node:vm";
import { agentLoop } from "./agent-loop.js";
import { createModelCaller } from "./llm-adapter.js";
import { extractLastAssistantText, getCoreToolsForSubagents } from "./subagents.js";
import type { Message, ToolContext } from "./types.js";

// --- worker sub-agent -------------------------------------------------------

const WORKER_PROMPT = [
  "You are a workflow worker sub-agent.",
  "Complete the given task using the available tools.",
  "Be thorough but efficient; do not ask clarifying questions — work with what you have.",
  "Your final reply is the ONLY thing returned to the orchestrator, so make it a",
  "self-contained report: state your conclusion and include any file paths the",
  "orchestrator needs (it does not see your intermediate tool output).",
].join("\n");

const WORKER_MAX_TURNS = 8;

// Cap concurrent worker agents so a wide fan-out can't fire the provider at
// once. Mirrors the Task tool's semaphore.
const MAX_WORKER_CONCURRENCY = (() => {
  const raw = Number(process.env.WORKFLOW_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
})();

let activeWorkers = 0;
const workerQueue: Array<() => void> = [];

async function acquireWorkerSlot(): Promise<void> {
  if (activeWorkers < MAX_WORKER_CONCURRENCY) {
    activeWorkers++;
    return;
  }
  await new Promise<void>((resolve) => workerQueue.push(resolve));
  activeWorkers++;
}

function releaseWorkerSlot(): void {
  activeWorkers--;
  const next = workerQueue.shift();
  if (next) next();
}

/** Spawn one read-only worker sub-agent and return its final assistant text. */
export async function runWorkerAgent(prompt: string, context: ToolContext): Promise<string> {
  if (!context.modelConfig) throw new Error("workflow requires modelConfig in context");
  const coreTools = await getCoreToolsForSubagents();
  const tools = coreTools.filter((t) => ["read", "glob", "grep", "bash"].includes(t.name));
  const subMessages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  const subCaller = createModelCaller(context.modelConfig);
  let errorMessage: string | undefined;

  await acquireWorkerSlot();
  try {
    for await (const event of agentLoop(subMessages, tools, subCaller, context.modelConfig, {
      systemPrompt: WORKER_PROMPT,
      maxTurns: WORKER_MAX_TURNS,
      autoCompactThreshold: 50_000,
      toolContext: {
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        permissionMode: context.permissionMode,
        modelConfig: context.modelConfig,
        askUser: context.askUser,
      },
      askUser: context.askUser,
    })) {
      if (event.type === "error") errorMessage = String(event.error);
      else if (event.type === "aborted") errorMessage = event.reason;
    }
  } catch (error: any) {
    errorMessage = error?.message ?? String(error);
  } finally {
    releaseWorkerSlot();
  }

  const text = extractLastAssistantText(subMessages);
  if (text) return text;
  if (errorMessage) throw new Error(`worker failed: ${errorMessage}`);
  return "(no output)";
}

// --- registry ---------------------------------------------------------------

export interface WorkflowRecord {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  logs: string[];
  result?: string;
}

const WORKFLOWS = new Map<string, WorkflowRecord>();
let wfCounter = 0;

/** List all workflow records, most-recent first. */
export function listWorkflows(): WorkflowRecord[] {
  return [...WORKFLOWS.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getWorkflow(id: string): WorkflowRecord | undefined {
  return WORKFLOWS.get(id);
}

/** Test/util: clear all workflow records. */
export function resetWorkflows(): void {
  WORKFLOWS.clear();
  wfCounter = 0;
}

// --- script runner ----------------------------------------------------------

export interface WorkflowOptions {
  /** Value exposed to the script as the global `args`. */
  args?: unknown;
  /** Inject a worker runner for tests; defaults to the real sub-agent loop. */
  agentRunner?: (prompt: string, context: ToolContext) => Promise<string>;
  /** Total wall-clock budget for the whole workflow (ms). */
  timeoutMs?: number;
}

/**
 * Run a model-written orchestration script. The script is an async expression
 * body (it may `return` a value) with these globals injected:
 *
 *   agent(prompt, {label}) — run ONE worker sub-agent, return its final text
 *   parallel([thunks])      — run the thunks concurrently, return their results
 *   pipeline(items, ...stages) — run items through each stage concurrently
 *   log(msg) / phase(title)  — progress lines captured into the record
 *   args                     — the caller-supplied args value
 *
 * The script is NOT arbitrary shell — it's an async JS expression over these
 * helpers, run in a `vm` sandbox with no fs/network/process access.
 */
export async function runWorkflow(
  script: string,
  context: ToolContext,
  options: WorkflowOptions = {},
): Promise<WorkflowRecord> {
  const agentRunner = options.agentRunner ?? runWorkerAgent;
  const id = `wf-${++wfCounter}`;
  const record: WorkflowRecord = {
    id,
    status: "running",
    startedAt: Date.now(),
    logs: [],
  };
  WORKFLOWS.set(id, record);

  const agent = async (prompt: string, opts?: { label?: string }) => {
    const label = opts?.label ?? (prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt);
    record.logs.push(`agent: ${label}`);
    return agentRunner(prompt, context);
  };
  const parallel = (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t)));
  const pipeline = async (
    items: unknown[],
    ...stages: Array<(item: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]> => {
    let acc = items;
    for (const stage of stages) {
      acc = await Promise.all(acc.map(async (item, i) => stage(item, i)));
    }
    return acc;
  };

  const sandbox: Record<string, unknown> = {
    agent,
    parallel,
    pipeline,
    log: (m: unknown) => record.logs.push(String(m)),
    phase: (t: unknown) => record.logs.push(`[phase] ${String(t)}`),
    args: options.args,
  };
  vm.createContext(sandbox);

  const timeoutMs = options.timeoutMs ?? 120_000;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`workflow timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  try {
    const wrapped = `(async () => {\n${script}\n})()`;
    const result: unknown = await Promise.race([vm.runInContext(wrapped, sandbox), timeout]);
    record.status = "completed";
    record.finishedAt = Date.now();
    record.result = result === undefined ? undefined : String(result);
  } catch (error: any) {
    record.status = "failed";
    record.finishedAt = Date.now();
    record.logs.push(`error: ${error?.message ?? error}`);
  }

  return record;
}
