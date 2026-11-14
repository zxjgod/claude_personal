// Workflow orchestration with bounded worker execution.
//
// The orchestration itself is a DECLARATIVE PLAN interpreted by
// src/workflow-dsl.ts — no model-authored code is ever evaluated. See that
// file for why the previous `node:vm` sandbox had to go (it was escapable:
// `this.constructor.constructor("return process")()` reached the real
// `process`, and therefore every credential in the environment).
// Fan-out concurrency is still bounded, and workers still run real agent
// loops with a narrowed tool set.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentLoop, WORKER_COMPACT_THRESHOLD } from "./agent-loop.js";
import { createModelCaller } from "./llm-adapter.js";
import { consumeSubagentLoop, subagentTerminalError } from "./subagent-outcome.js";
import { extractLastAssistantText, getCoreToolsForSubagents } from "./subagents.js";
import { deriveSubContext, type Message, type ToolContext } from "./types.js";
import { renameSyncWithRetry } from "./utils/atomic-rename.js";
import { CancellationScope } from "./utils/cancellation.js";
import { Semaphore } from "./utils/semaphore.js";
import { createSubAgentApprover } from "./utils/subagent-security.js";
import {
  collectText,
  parseWorkflowPlan,
  runWorkflowPlan,
  type StepResult,
} from "./workflow-dsl.js";

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

// Shared Semaphore (utils/semaphore.ts) rather than a private queue — the
// Task/Agent/team caps all use it, so abort-aware FIFO behavior is identical
// everywhere instead of re-implemented per call site.
const workerSlots = new Semaphore(MAX_WORKER_CONCURRENCY, "Workflow worker");

const acquireWorkerSlot = (signal?: AbortSignal): Promise<void> => workerSlots.acquire(signal);
const releaseWorkerSlot = (): void => workerSlots.release();

export const __workerSlots = {
  acquire: acquireWorkerSlot,
  release: releaseWorkerSlot,
  max: MAX_WORKER_CONCURRENCY,
  get active() {
    return workerSlots.active;
  },
  /** Test teardown — the semaphore is a module singleton. */
  reset: (): void => workerSlots.reset(),
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
  const approver = createSubAgentApprover(context.askUser);
  let errorMessage: string | undefined;

  await acquireWorkerSlot(abortSignal);
  try {
    const completion = await consumeSubagentLoop(
      agentLoop(subMessages, tools, subCaller, context.modelConfig, {
        systemPrompt: WORKER_PROMPT,
        maxTurns: WORKER_MAX_TURNS,
        autoCompactThreshold: WORKER_COMPACT_THRESHOLD,
        toolContext: deriveSubContext(context, {
          askUser: approver,
          abortSignal,
          hooks: context.hooks,
        }),
        askUser: approver,
        abortSignal,
      }),
      () => {},
    );
    errorMessage = subagentTerminalError(completion);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    releaseWorkerSlot();
  }

  const text = extractLastAssistantText(subMessages);
  if (errorMessage)
    throw new Error(`worker failed: ${errorMessage}${text ? `\nPartial output: ${text}` : ""}`);
  if (text) return text;
  throw new Error("worker incomplete: no final report");
}

export interface WorkflowRecord {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  logs: string[];
  result?: string;
}

interface WorkflowSnapshot {
  version: 2;
  sessionId: string;
  id: string;
  startedAt: number;
  cache: Record<string, string>;
  unconfirmed: Record<string, string>;
}

const workflowRoot = (context: Pick<ToolContext, "workspaceRoot">) =>
  path.join(context.workspaceRoot, ".claude", "workflow-runs");
const workflowPrefix = (sessionId: string) => `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-`;

const WORKFLOWS = new Map<string, { sessionId: string; record: WorkflowRecord }>();
let wfCounter = 0;

export function listWorkflows(
  context: Pick<ToolContext, "workspaceRoot" | "sessionId">,
): WorkflowRecord[] {
  const root = workflowRoot(context);
  const records = new Map<string, WorkflowRecord>();
  const prefix = workflowPrefix(context.sessionId);
  for (const [file, active] of WORKFLOWS) {
    if (path.dirname(file) === root && active.sessionId === context.sessionId)
      records.set(active.record.id, active.record);
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const file of files) {
    if (!file.startsWith(prefix) || !/^wf-[a-z0-9-]+\.json$/.test(file.slice(prefix.length)))
      continue;
    try {
      const snapshot = JSON.parse(
        fs.readFileSync(path.join(root, file), "utf8"),
      ) as WorkflowSnapshot;
      if (
        snapshot.version !== 2 ||
        snapshot.sessionId !== context.sessionId ||
        file !== `${prefix}${snapshot.id}.json`
      )
        continue;
      if (!records.has(snapshot.id) && Object.keys(snapshot.unconfirmed).length > 0)
        records.set(snapshot.id, {
          id: snapshot.id,
          startedAt: snapshot.startedAt,
          status: "failed",
          logs: [
            `Unconfirmed workers: ${Object.values(snapshot.unconfirmed).slice(0, 12).join(", ")}`,
            "Inspect their effects before retrying.",
          ],
        });
    } catch {
      // A missing or unreadable snapshot does not prevent listing other runs.
    }
  }
  return [...records.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function resetWorkflows(): void {
  WORKFLOWS.clear();
  wfCounter = 0;
}

export interface WorkflowOptions {
  resumeFromRunId?: string;
  retryUnconfirmed?: boolean;
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
  const id = `wf-${Date.now().toString(36)}-${++wfCounter}-${randomUUID().slice(0, 8)}`;
  const cache = new Map<string, string>();
  const unconfirmed = new Map<string, string>();
  const occurrences = new Map<string, number>();
  const runRoot = workflowRoot(context);
  const prefix = workflowPrefix(context.sessionId);
  const snapshotPath = path.join(runRoot, `${prefix}${id}.json`);
  const record: WorkflowRecord = {
    id,
    status: "running",
    startedAt: Date.now(),
    logs: [],
  };
  WORKFLOWS.set(snapshotPath, { sessionId: context.sessionId, record });

  const saveProgress = () => {
    const data: WorkflowSnapshot = {
      version: 2,
      sessionId: context.sessionId,
      id,
      startedAt: record.startedAt,
      cache: Object.fromEntries(cache),
      unconfirmed: Object.fromEntries(unconfirmed),
    };
    fs.mkdirSync(runRoot, { recursive: true });
    const temp = `${snapshotPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data));
    renameSyncWithRetry(temp, snapshotPath);
  };

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
    if (options.resumeFromRunId) {
      const resumeId = options.resumeFromRunId;
      if (!/^[a-zA-Z0-9_-]+$/.test(resumeId)) throw new Error("Invalid workflow run id");
      const source = path.join(runRoot, `${prefix}${resumeId}.json`);
      if (WORKFLOWS.get(source)?.record.status === "running")
        throw new Error(`Workflow ${resumeId} is still running`);
      const saved = JSON.parse(fs.readFileSync(source, "utf8"));
      if (
        saved.version !== 1 &&
        (saved.version !== 2 ||
          saved.sessionId !== context.sessionId ||
          saved.id !== resumeId ||
          !saved.unconfirmed ||
          typeof saved.unconfirmed !== "object" ||
          Array.isArray(saved.unconfirmed) ||
          Object.values(saved.unconfirmed).some((value) => typeof value !== "string"))
      )
        throw new Error("Invalid workflow snapshot for this session");
      const unresolved = Object.values(saved.unconfirmed ?? {});
      if (unresolved.length && !options.retryUnconfirmed)
        throw new Error(
          `Workflow ${resumeId} has ${unresolved.length} unconfirmed worker outcome(s): ${unresolved.slice(0, 12).join(", ")}. Inspect their effects before resuming with retryUnconfirmed: true.`,
        );
      for (const [key, value] of Object.entries(saved.cache ?? {}))
        if (typeof value === "string") cache.set(key, value);
    }
    // Parse BEFORE racing the timeout: a malformed plan is the caller's
    // mistake and should fail fast with a precise message, not surface as a
    // generic timeout.
    const plan = parseWorkflowPlan(script);
    if (options.args !== undefined) {
      record.logs.push(`args: ${safePreview(options.args)}`);
    }
    const { result } = await Promise.race([
      runWorkflowPlan(plan, {
        agent: async (prompt, label, stepPath) => {
          if (revoked || workflowScope.aborted) throw new Error("workflow timed out (revoked)");
          // The interpreter already logs "agent: <label>" per step; this adds
          // the "now running" breadcrumb so a long fan-out is traceable.
          if (label) record.logs.push(`running: ${label}`);
          const occurrence = occurrences.get(prompt) ?? 0;
          occurrences.set(prompt, occurrence + 1);
          const key = createHash("sha256")
            .update(
              JSON.stringify(
                [prompt, context.modelConfig, options.args, occurrence],
                (field, value) => (field === "apiKey" ? undefined : value),
              ),
            )
            .digest("hex");
          const cached = cache.get(key);
          if (cached !== undefined) {
            record.logs.push(`resumed: ${label ?? key.slice(0, 8)}`);
            return cached;
          }
          const workerLocation = stepPath ?? label ?? key.slice(0, 8);
          unconfirmed.set(key, workerLocation);
          saveProgress();
          const result = await agentRunner(prompt, context, workflowScope.signal);
          if (!workflowScope.aborted) {
            cache.set(key, result);
            unconfirmed.delete(key);
            try {
              saveProgress();
            } catch (error) {
              cache.delete(key);
              unconfirmed.set(key, workerLocation);
              throw error;
            }
          }
          return result;
        },
        log: (line) => record.logs.push(line),
        signal: workflowScope.signal,
      }),
      timeout,
    ]);
    record.status = "completed";
    record.finishedAt = Date.now();
    record.result = renderResult(result);
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

function safePreview(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  } catch {
    return String(value);
  }
}

/** Flatten a step result to the single string the model sees as the answer. */
function renderResult(result: StepResult): string {
  const text = collectText(result);
  return text.trim() === "" ? "(no result)" : text;
}
