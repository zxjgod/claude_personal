// ============================================================
// Workflow DSL — declarative orchestration, NO arbitrary code
// ------------------------------------------------------------
// SECURITY. This module replaces the previous `node:vm` sandbox, which
// executed MODEL-WRITTEN JAVASCRIPT. `vm.createContext` is not a security
// boundary: a context escapes it with a plain constructor chain —
//
//     this.constructor.constructor("return process")()   // → the real process
//
// which we confirmed empirically (typeof process === "object"). A single
// prompt-injected workflow could therefore read LLM_API_KEY and every other
// credential in the environment. The `timeout`, the `worker_threads`
// isolation and the API allow-list did NOT mitigate this: none of them
// constrain code ACCESS, only execution time and which globals are named in
// the sandbox object — and the constructor chain reaches the real ones
// anyway. The only real boundary is not running model-authored code at all.
//
// The DSL keeps what the tool actually needs — fan out workers, run them in
// parallel, push items through per-item stages, log progress, synthesize a
// summary — while making the execution shape DATA rather than code. There is
// no eval, no Function constructor, no vm, and no host object reachable from
// anything the interpreter touches.
//
// Grammar (JSON):
//
//   { phase?: string, steps: Step[] }
//
//   Step =
//     | { agent: <prompt>, label?: string }         → worker report
//     | { parallel: Step[] }                          → Step[]
//     | { pipeline: { items: string[], stages: string[] } } → string[]
//     | { log: string } | { phase: string }           → no result
//     | { synthesize: { from: number[], prompt: string } } → final string
//
// `parallel` fans sub-trees out concurrently. `pipeline` maps each item
// through every stage IN ORDER, where `{input}` in a stage template is
// replaced by that item's current text — the natural "review each of these
// N files" shape. `synthesize` reads the results of PRECEDING steps by index
// and hands them to one final worker that writes the summary; it is how the
// orchestrator gets an answer, since the model no longer computes one itself.
// ============================================================

/** One node of the orchestration tree. */
export type WorkflowStep =
  | { agent: string; label?: string }
  | { parallel: WorkflowStep[] }
  | { pipeline: { items: string[]; stages: string[] } }
  | { log: string }
  | { phase: string }
  | { synthesize: { from: number[]; prompt: string } };

export interface WorkflowPlan {
  phase?: string;
  steps: WorkflowStep[];
}

export class WorkflowDslError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDslError";
  }
}

/**
 * Result of evaluating one step: worker text, an array of results (from
 * `parallel` / `pipeline`), or nothing (from `log` / `phase`). Recursive
 * because a `parallel` may contain another `parallel`.
 */
export type StepResult = string | StepResult[] | null;

const MAX_DEPTH = 8;
const MAX_NODES = 64;
const MAX_PROMPT_CHARS = 8_000;
const MAX_SYNTHESIZE_FROM = 16;
const MAX_PIPELINE_ITEMS = 32;

/** `{input}` placeholder in pipeline stage templates. */
const INPUT_PLACEHOLDER = /\{input\}/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asPrompt(v: unknown, where: string): string {
  if (typeof v !== "string") throw new WorkflowDslError(`${where}: expected a string prompt`);
  if (v.trim() === "") throw new WorkflowDslError(`${where}: prompt must not be empty`);
  if (v.length > MAX_PROMPT_CHARS) {
    throw new WorkflowDslError(
      `${where}: prompt is ${v.length} chars, over the ${MAX_PROMPT_CHARS} limit`,
    );
  }
  return v;
}

function asLabel(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new WorkflowDslError(`${where}: label must be a string`);
  return v.length > 200 ? v.slice(0, 200) : v;
}

function asStringList(v: unknown, where: string, max: number): string[] {
  if (!Array.isArray(v)) throw new WorkflowDslError(`${where}: expected an array of strings`);
  if (v.length === 0) throw new WorkflowDslError(`${where}: must not be empty`);
  if (v.length > max) throw new WorkflowDslError(`${where}: at most ${max} entries allowed`);
  return v.map((entry, i) => asPrompt(entry, `${where}[${i}]`));
}

/** Parse + validate a plan. Throws WorkflowDslError with a precise message. */
export function parseWorkflowPlan(input: unknown): WorkflowPlan {
  if (typeof input !== "string") {
    throw new WorkflowDslError("workflow must be a JSON string");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (error) {
    throw new WorkflowDslError(
      `workflow is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(raw)) throw new WorkflowDslError("workflow must be a JSON object");
  if (raw.phase !== undefined && typeof raw.phase !== "string") {
    throw new WorkflowDslError("phase must be a string");
  }
  if (!Array.isArray(raw.steps)) {
    throw new WorkflowDslError('workflow requires a "steps" array');
  }
  if (raw.steps.length === 0) throw new WorkflowDslError("steps must not be empty");
  const budget = { nodes: 0 };
  const steps = raw.steps.map((s, i) => parseStep(s, 0, `steps[${i}]`, budget));
  // A synthesize reads the results of PRECEDING top-level steps, so every
  // "from" index must point strictly before the step containing it — without
  // this check an out-of-range index silently resolves to no text at runtime.
  steps.forEach((step, i) => {
    validateSynthesizeRefs(step, i, `steps[${i}]`);
  });
  return { phase: raw.phase as string | undefined, steps };
}

function validateSynthesizeRefs(step: WorkflowStep, selfIndex: number, where: string): void {
  if ("synthesize" in step) {
    for (const idx of step.synthesize.from) {
      if (idx >= selfIndex) {
        throw new WorkflowDslError(
          `${where}.synthesize: "from" index ${idx} does not reference a preceding step ` +
            `(only steps[0..${selfIndex - 1}] complete before this step)`,
        );
      }
    }
    return;
  }
  if ("parallel" in step) {
    step.parallel.forEach((child, i) => {
      validateSynthesizeRefs(child, selfIndex, `${where}.parallel[${i}]`);
    });
  }
}

function parseStep(
  raw: unknown,
  depth: number,
  where: string,
  budget: { nodes: number },
): WorkflowStep {
  if (depth > MAX_DEPTH) {
    throw new WorkflowDslError(`${where}: nesting deeper than ${MAX_DEPTH} levels`);
  }
  if (++budget.nodes > MAX_NODES) {
    throw new WorkflowDslError(`workflow has more than ${MAX_NODES} steps`);
  }
  if (!isRecord(raw)) throw new WorkflowDslError(`${where}: each step must be an object`);

  // Exactly one KIND key selects what runs; `label` is the one permitted
  // modifier, and only on `agent`. Anything else is ambiguous, so reject
  // rather than guess which half of the object was meant.
  const keys = Object.keys(raw);
  const kindKeys = keys.filter((k) => k !== "label");
  if (kindKeys.length !== 1) {
    throw new WorkflowDslError(
      `${where}: a step must have exactly one kind key (agent, parallel, pipeline, log, phase, or synthesize), found ${kindKeys.length}`,
    );
  }
  const key = kindKeys[0]!;
  if (key !== "agent" && keys.includes("label")) {
    throw new WorkflowDslError(`${where}: "label" is only valid on an agent step`);
  }
  const value = raw[key];

  switch (key) {
    case "agent":
      return { agent: asPrompt(value, where), label: asLabel(raw.label, where) };

    case "log":
    case "phase":
      if (typeof value !== "string")
        throw new WorkflowDslError(`${where}: ${key} must be a string`);
      return key === "log" ? { log: value } : { phase: value };

    case "parallel": {
      if (!Array.isArray(value)) {
        throw new WorkflowDslError(`${where}: parallel must be an array of steps`);
      }
      if (value.length === 0) throw new WorkflowDslError(`${where}: parallel must not be empty`);
      return {
        parallel: value.map((s, i) => parseStep(s, depth + 1, `${where}.parallel[${i}]`, budget)),
      };
    }

    case "pipeline": {
      if (!isRecord(value)) {
        throw new WorkflowDslError(`${where}: pipeline must be { items, stages }`);
      }
      const { items, stages } = value as { items?: unknown; stages?: unknown };
      return {
        pipeline: {
          items: asStringList(items, `${where}.pipeline.items`, MAX_PIPELINE_ITEMS),
          stages: asStringList(stages, `${where}.pipeline.stages`, MAX_DEPTH + 1),
        },
      };
    }

    case "synthesize": {
      if (!isRecord(value)) {
        throw new WorkflowDslError(`${where}: synthesize must be { from, prompt }`);
      }
      const from = value.from;
      if (!Array.isArray(from) || from.length === 0) {
        throw new WorkflowDslError(
          `${where}.synthesize: "from" must be a non-empty array of step indexes`,
        );
      }
      if (from.length > MAX_SYNTHESIZE_FROM) {
        throw new WorkflowDslError(
          `${where}.synthesize: "from" may reference at most ${MAX_SYNTHESIZE_FROM} steps`,
        );
      }
      for (const idx of from) {
        if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
          throw new WorkflowDslError(
            `${where}.synthesize: "from" must contain non-negative integers`,
          );
        }
      }
      return { synthesize: { from: from as number[], prompt: asPrompt(value.prompt, where) } };
    }

    default:
      throw new WorkflowDslError(
        `${where}: unknown step kind "${key}" (expected agent, parallel, pipeline, log, phase, or synthesize)`,
      );
  }
}

/** Callbacks the interpreter needs from its host. */
export interface WorkflowHost {
  /** Run one worker sub-agent; resolves to its final report. */
  agent(prompt: string, label?: string): Promise<string>;
  /** Progress line surfaced in the workflow log. */
  log(line: string): void;
  /** Aborts long-running fan-outs. */
  signal?: AbortSignal;
}

/** Flatten a (possibly nested) step result to text for embedding in a prompt. */
export function collectText(value: StepResult | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  const parts: string[] = [];
  const walk = (v: StepResult): void => {
    if (v === null) return;
    if (typeof v === "string") {
      if (v.trim() !== "") parts.push(v);
      return;
    }
    v.forEach(walk);
  };
  walk(value);
  return parts.join("\n\n---\n\n");
}

/**
 * Interpret a plan. Sequential steps run in order and each result is kept, so
 * a later `synthesize` can reference it by index. `parallel` fans out
 * concurrently; `pipeline` threads each item through the stages in order.
 * Actual worker concurrency is bounded by the host's semaphore, not here.
 */
export async function runWorkflowPlan(
  plan: WorkflowPlan,
  host: WorkflowHost,
): Promise<{ result: StepResult; results: StepResult[] }> {
  const results: StepResult[] = [];
  let result: StepResult = null;

  if (plan.phase) host.log(`[phase] ${plan.phase}`);

  for (const [i, step] of plan.steps.entries()) {
    if (host.signal?.aborted) throw new WorkflowDslError(`steps[${i}]: workflow aborted`);
    result = await runStep(step, `steps[${i}]`, host, results);
    if (host.signal?.aborted) throw new WorkflowDslError(`steps[${i}]: workflow aborted`);
    results.push(result);
  }
  return { result, results };
}

async function runStep(
  step: WorkflowStep,
  where: string,
  host: WorkflowHost,
  prior: StepResult[],
): Promise<StepResult> {
  if (host.signal?.aborted) throw new WorkflowDslError(`${where}: workflow aborted`);

  if ("agent" in step) {
    host.log(`agent: ${step.label ?? truncate(step.agent)}`);
    return await host.agent(step.agent, step.label);
  }

  if ("log" in step) {
    host.log(step.log);
    return null;
  }

  if ("phase" in step) {
    host.log(`[phase] ${step.phase}`);
    return null;
  }

  if ("parallel" in step) {
    return await Promise.all(
      step.parallel.map((child, i) => runStep(child, `${where}.parallel[${i}]`, host, prior)),
    );
  }

  if ("pipeline" in step) {
    const { items, stages } = step.pipeline;
    host.log(`${where}: pipeline ${items.length} item(s) × ${stages.length} stage(s)`);
    // Each item advances independently; a failure in one item must not
    // cancel the others, so failures degrade to a marker string.
    return await Promise.all(
      items.map(async (item, i) => {
        let current = item;
        for (const [si, template] of stages.entries()) {
          if (host.signal?.aborted) {
            throw new WorkflowDslError(`${where}.pipeline[${i}]: workflow aborted`);
          }
          const prompt = template.replace(INPUT_PLACEHOLDER, () => current);
          try {
            current = await host.agent(prompt, `pipeline[${i}] stage ${si + 1}`);
          } catch (error) {
            if (host.signal?.aborted) {
              throw new WorkflowDslError(`${where}.pipeline[${i}]: workflow aborted`);
            }
            return `[failed at stage ${si + 1}: ${
              error instanceof Error ? error.message : String(error)
            }]`;
          }
        }
        return current;
      }),
    );
  }

  // synthesize: read the reports of PRECEDING steps by index and hand them to
  // one final worker that writes the answer.
  const combined = step.synthesize.from
    .map((idx) => collectText(prior[idx]))
    .filter((text) => text.trim() !== "")
    .join("\n\n---\n\n");
  if (combined.trim() === "") {
    throw new WorkflowDslError(`${where}.synthesize: referenced steps produced no text`);
  }
  host.log(`${where}: synthesize from [${step.synthesize.from.join(", ")}]`);
  return await host.agent(
    `${step.synthesize.prompt}\n\n--- worker reports to synthesize ---\n${combined}`,
    "synthesize",
  );
}

function truncate(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Human-readable schema doc, embedded in the tool's promptDescription. */
export const WORKFLOW_DSL_DOC = [
  "Submit a JSON object describing the orchestration (this is DATA, not code):",
  '{ "phase": "<optional label>", "steps": [ ... ] }',
  "Each step is exactly ONE of:",
  '  { "agent": "<task for one worker>", "label": "<optional>" }      → that report',
  '  { "parallel": [ <step>, ... ] }                                 → array',
  '  { "pipeline": { "items": ["<a>","<b>"], "stages": ["<uses {input}>"] } }',
  '  { "log": "<progress line>" }   { "phase": "<phase name>" }        → no result',
  '  { "synthesize": { "from": [<step index>,...], "prompt": "<how to combine>" } }',
  "In a pipeline stage, {input} is replaced by that item's current text, so each",
  "item passes through every stage in order. Make the LAST step a synthesize:",
  "it receives the reports of the steps named in `from`, and one final worker",
  "writes the summary. Workers get a limited toolset (read/glob/grep/bash —",
  "bash is NOT sandboxed, so workers can mutate files) and run with bounded",
  "concurrency; only final reports come back, not intermediate tool output.",
].join("\n");
