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

/**
 * Counting semaphore over activeWorkers + a FIFO queue. Invariant: a slot is
 * either counted in activeWorkers or currently owned by a queued waiter being
 * woken — never both, never neither.
 *
 * The previous implementation raced: release() decremented BEFORE waking a
 * waiter, and the waiter re-incremented only after its microtask ran. In that
 * window a newcomer on the fast path could ALSO take the slot, after which the
 * waiter's increment overshot the cap — silently defeating the concurrency
 * limit that exists to protect the provider.
 */
async function acquireWorkerSlot(): Promise<void> {
  // Fast path only when nobody is waiting: otherwise a newcomer could grab a
  // slot that releaseWorkerSlot() just transferred to a queued waiter.
  if (workerQueue.length === 0 && activeWorkers < MAX_WORKER_CONCURRENCY) {
    activeWorkers++;
    return;
  }
  await new Promise<void>((resolve) => workerQueue.push(resolve));
  // Slot ownership was TRANSFERRED by releaseWorkerSlot (count unchanged) —
  // do NOT increment here.
}

function releaseWorkerSlot(): void {
  const next = workerQueue.shift();
  if (next) {
    // Hand the slot directly to the waiter; the count stays the same.
    next();
  } else {
    activeWorkers--;
  }
}

/** Exposed for tests only — the semaphore is module-internal by design. */
export const __workerSlots = {
  acquire: acquireWorkerSlot,
  release: releaseWorkerSlot,
  max: MAX_WORKER_CONCURRENCY,
};

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

  const timeoutMs = options.timeoutMs ?? 120_000;
  // When the wall-clock budget expires we flip `revoked` so the sandbox's
  // helpers (agent/parallel/pipeline) start throwing — pending async work
  // stops making progress instead of running on in the background forever.
  let revoked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      revoked = true;
      reject(new Error(`workflow timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't let a completed workflow's lingering timer keep the process alive.
    timer.unref?.();
  });

  const agent = async (prompt: string, opts?: { label?: string }) => {
    if (revoked) throw new Error("workflow timed out (revoked)");
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

  try {
    const wrapped = `(async () => {\n${script}\n})()`;
    // vm's own `timeout` option covers a SYNCHRONOUS infinite loop during the
    // initial evaluation (e.g. a bare `while (true) {}` — the async IIFE body
    // runs synchronously up to its first await, inside runInContext), which
    // would otherwise freeze the event loop and leave the Promise.race timer
    // no chance to fire. A sync loop hidden BEHIND an await still cannot be
    // preempted from this thread — that would require running the script in a
    // worker thread, deliberately out of scope for a personal CLI.
    const syncBudget = Math.min(timeoutMs, 10_000);
    const result: unknown = await Promise.race([
      vm.runInContext(wrapped, sandbox, { timeout: syncBudget }),
      timeout,
    ]);
    record.status = "completed";
    record.finishedAt = Date.now();
    record.result = result === undefined ? undefined : String(result);
  } catch (error: any) {
    record.status = "failed";
    record.finishedAt = Date.now();
    record.logs.push(`error: ${error?.message ?? error}`);
    if (revoked) {
      record.logs.push("note: timed out — in-flight worker calls were revoked mid-flight");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return record;
}
