// Workflow orchestration scripts with bounded worker execution.

import { Worker } from "node:worker_threads";
import { agentLoop, WORKER_COMPACT_THRESHOLD } from "./agent-loop.js";
import { createModelCaller } from "./llm-adapter.js";
import { extractLastAssistantText, getCoreToolsForSubagents } from "./subagents.js";
import type { Message, ToolContext } from "./types.js";
import { CancellationScope } from "./utils/cancellation.js";

const WORKER_PROMPT = [
  "You are a workflow worker sub-agent.",
  "Complete the given task using the available tools.",
  "Be thorough but efficient; do not ask clarifying questions - work with what you have.",
  "Your final reply is the ONLY thing returned to the orchestrator, so make it a",
  "self-contained report: state your conclusion and include any file paths the",
  "orchestrator needs (it does not see intermediate tool output).",
].join("\n");

const WORKER_MAX_TURNS = 8;
const MAX_WORKER_CONCURRENCY = (() => {
  const raw = Number(process.env.WORKFLOW_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
})();

interface WorkerWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

let activeWorkers = 0;
const workerQueue: WorkerWaiter[] = [];

async function acquireWorkerSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Workflow worker aborted before acquiring a slot");
  if (workerQueue.length === 0 && activeWorkers < MAX_WORKER_CONCURRENCY) {
    activeWorkers++;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: WorkerWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = workerQueue.indexOf(waiter);
        if (index >= 0) workerQueue.splice(index, 1);
        reject(new Error("Workflow worker aborted while waiting for a slot"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    workerQueue.push(waiter);
  });
}

function releaseWorkerSlot(): void {
  while (workerQueue.length > 0) {
    const next = workerQueue.shift()!;
    if (next.signal?.aborted) {
      if (next.onAbort && next.signal) next.signal.removeEventListener("abort", next.onAbort);
      next.reject(new Error("Workflow worker aborted while waiting for a slot"));
      continue;
    }
    if (next.onAbort && next.signal) next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
    return;
  }
  activeWorkers--;
}

export const __workerSlots = {
  acquire: acquireWorkerSlot,
  release: releaseWorkerSlot,
  max: MAX_WORKER_CONCURRENCY,
};

export async function runWorkerAgent(
  prompt: string,
  context: ToolContext,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!context.modelConfig) throw new Error("workflow requires modelConfig in context");
  const coreTools = await getCoreToolsForSubagents();
  const tools = coreTools.filter((t) => ["read", "glob", "grep", "bash"].includes(t.name));
  const subMessages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  const subCaller = createModelCaller(context.modelConfig);
  let errorMessage: string | undefined;

  await acquireWorkerSlot(abortSignal);
  try {
    for await (const event of agentLoop(subMessages, tools, subCaller, context.modelConfig, {
      systemPrompt: WORKER_PROMPT,
      maxTurns: WORKER_MAX_TURNS,
      autoCompactThreshold: WORKER_COMPACT_THRESHOLD,
      toolContext: {
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        permissionMode: context.permissionMode,
        modelConfig: context.modelConfig,
        askUser: context.askUser,
        abortSignal,
      },
      askUser: context.askUser,
      abortSignal,
    })) {
      if (event.type === "error") errorMessage = String(event.error);
      else if (event.type === "aborted") errorMessage = String(event.reason);
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    releaseWorkerSlot();
  }

  const text = extractLastAssistantText(subMessages);
  if (text) return text;
  if (errorMessage) throw new Error(`worker failed: ${errorMessage}`);
  return "(no output)";
}

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

export function listWorkflows(): WorkflowRecord[] {
  return [...WORKFLOWS.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getWorkflow(id: string): WorkflowRecord | undefined {
  return WORKFLOWS.get(id);
}

export function resetWorkflows(): void {
  WORKFLOWS.clear();
  wfCounter = 0;
}

export interface WorkflowOptions {
  args?: unknown;
  agentRunner?: (
    prompt: string,
    context: ToolContext,
    abortSignal?: AbortSignal,
  ) => Promise<string>;
  timeoutMs?: number;
}

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

  const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
  const workflowScope = new CancellationScope(context.abortSignal);
  let revoked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      revoked = true;
      reject(new Error(`workflow timed out after ${timeoutMs}ms`));
      workflowScope.cancel("hard", "workflow timed out");
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([
      runWorkflowScriptInWorker(
        script,
        options.args,
        Math.min(timeoutMs, 10_000),
        async (prompt, label) => {
          if (revoked || workflowScope.aborted) throw new Error("workflow timed out (revoked)");
          const displayLabel = label ?? (prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt);
          record.logs.push(`agent: ${displayLabel}`);
          return agentRunner(prompt, context, workflowScope.signal);
        },
        (line) => record.logs.push(line),
        workflowScope.signal,
      ),
      timeout,
    ]);
    record.status = "completed";
    record.finishedAt = Date.now();
    record.result = result;
  } catch (error) {
    record.status = "failed";
    record.finishedAt = Date.now();
    record.logs.push(`error: ${error instanceof Error ? error.message : String(error)}`);
    if (revoked) record.logs.push("note: timed out; in-flight worker calls were revoked");
  } finally {
    if (timer) clearTimeout(timer);
    if (!workflowScope.aborted) workflowScope.cancel("hard", "workflow completed");
    workflowScope.dispose();
  }

  return record;
}

/** Message protocol sent by the workflow worker (see WORKFLOW_WORKER_SOURCE). */
interface WorkflowWorkerMessage {
  type?: string;
  id?: number;
  message?: unknown;
  prompt?: unknown;
  label?: string;
  result?: unknown;
  error?: unknown;
}

function runWorkflowScriptInWorker(
  script: string,
  args: unknown,
  syncBudget: number,
  runAgent: (prompt: string, label?: string) => Promise<string>,
  onLog: (line: string) => void,
  abortSignal: AbortSignal,
): Promise<string | undefined> {
  const worker = new Worker(WORKFLOW_WORKER_SOURCE, {
    eval: true,
    workerData: { script, args, syncBudget },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const send = (message: unknown): void => {
      try {
        worker.postMessage(message);
      } catch {
        // The worker may already be terminated after timeout.
      }
    };
    const finish = (error?: Error, result?: string): void => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(new Error("Workflow aborted"));

    worker.on("message", (message: WorkflowWorkerMessage) => {
      if (message?.type === "log") {
        onLog(String(message.message));
      } else if (message?.type === "agent") {
        void runAgent(String(message.prompt), message.label)
          .then((result) => send({ type: "agent_result", id: message.id, result }))
          .catch((error: unknown) =>
            send({
              type: "agent_result",
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      } else if (message?.type === "result") {
        finish(undefined, message.result === undefined ? undefined : String(message.result));
      } else if (message?.type === "error") {
        finish(new Error(String(message.error)));
      }
    });
    worker.on("error", (error) => finish(error));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) finish(new Error(`Workflow worker exited with code ${code}`));
    });
    abortSignal.addEventListener("abort", onAbort, { once: true });
    if (abortSignal.aborted) onAbort();
  });
}

const WORKFLOW_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const pendingAgents = new Map();
let nextAgentId = 1;

parentPort.on("message", (message) => {
  if (!message || message.type !== "agent_result") return;
  const pending = pendingAgents.get(message.id);
  if (!pending) return;
  pendingAgents.delete(message.id);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.result);
});

function agent(prompt, opts) {
  return new Promise((resolve, reject) => {
    const id = nextAgentId++;
    pendingAgents.set(id, { resolve, reject });
    parentPort.postMessage({
      type: "agent",
      id,
      prompt: String(prompt),
      label: opts && opts.label ? String(opts.label) : undefined,
    });
  });
}

const parallel = (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk)));
const pipeline = async (items, ...stages) => {
  let acc = items;
  for (const stage of stages) {
    acc = await Promise.all(acc.map((item, index) => stage(item, index)));
  }
  return acc;
};

const sandbox = {
  agent,
  parallel,
  pipeline,
  log: (message) => parentPort.postMessage({ type: "log", message: String(message) }),
  phase: (title) => parentPort.postMessage({ type: "log", message: "[phase] " + String(title) }),
  args: workerData.args,
};
vm.createContext(sandbox);

(async () => {
  try {
    const wrapped = "(async () => {\n" + workerData.script + "\n})()";
    const result = await vm.runInContext(wrapped, sandbox, { timeout: workerData.syncBudget });
    parentPort.postMessage({ type: "result", result: result === undefined ? undefined : String(result) });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: error && error.message ? error.message : String(error) });
  }
})();
`;
