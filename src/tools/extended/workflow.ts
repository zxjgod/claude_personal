// ============================================================
// Workflow Tool — run a model-written orchestration plan
// ============================================================

import * as fs from "node:fs";
import { z } from "zod";
import { isBlockedPath } from "../../permissions.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { runWorkflow } from "../../workflow.js";
import { WORKFLOW_DSL_DOC } from "../../workflow-dsl.js";
import { buildTool } from "../registry.js";
import { resolveInWorkspace } from "../utils/path.js";

const MAX_PLAN_BYTES = 1024 * 1024;

const WorkflowSchema = z.strictObject({
  // Official declares `description` as "Ignored — set the workflow description in
  // the script's `meta` block", and it is optional there. It was REQUIRED here
  // yet never read by the executor, so a caller had to invent a value the
  // runtime threw away. Now optional, and the describe() says so.
  description: z
    .string()
    .optional()
    .describe(
      "Short (3-6 word) description of the workflow. Optional and not used by the " +
        "executor — the plan's own meta carries the real description.",
    ),
  plan: z
    .string()
    .optional()
    .describe(
      "A JSON object describing the orchestration (DATA, not code — nothing is " +
        "evaluated). Shape: { phase?, steps: Step[] }. See the tool description for the " +
        "full step grammar. End with a synthesize step to produce the summary. " +
        "Required unless scriptPath is given.",
    ),
  scriptPath: z
    .string()
    .optional()
    .describe(
      "Path to a JSON plan file on disk, inside the workspace. Takes precedence over " +
        "`plan`, so an edited plan can be re-run without re-sending it. Mirrors " +
        "official's `scriptPath`.",
    ),
  args: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe(
      "Optional input recorded with the workflow for context. Official takes a JSON " +
        "object here; a string is also accepted. Pass arrays/objects as real JSON " +
        "values, NOT as a JSON-encoded string.",
    ),
  resumeFromRunId: z
    .string()
    .optional()
    .describe("Reuse completed unchanged worker calls from a previous run of this session"),
  // Official: "Ignored — set the workflow title in the script's `meta` block."
  // Accepted and discarded so an official-shaped call passes the strict parse.
  title: z.string().optional().describe("Ignored, matching official; kept for compatibility"),
});

/**
 * Resolve `scriptPath` to plan text, enforcing the same containment policy every
 * file-reading tool uses: the path must land inside the workspace (or an allowed
 * directory) and must not be a blocked path. A model-supplied absolute path must
 * not be able to read outside the sandbox.
 */
function readPlanFromDisk(
  scriptPath: string,
  context: ToolContext,
): { ok: true; plan: string } | { ok: false; error: string } {
  const resolution = resolveInWorkspace(
    scriptPath,
    context.workspaceRoot,
    context.allowedDirectories,
  );
  if (!resolution.ok) return { ok: false, error: resolution.error };
  if (isBlockedPath(resolution.path, context.workspaceRoot))
    return { ok: false, error: "Access denied: plan path is a blocked path" };
  if (!fs.existsSync(resolution.path))
    return { ok: false, error: `Plan file not found: ${resolution.path}` };
  const stat = fs.statSync(resolution.path);
  if (!stat.isFile()) return { ok: false, error: `Plan path is not a file: ${resolution.path}` };
  if (stat.size > MAX_PLAN_BYTES)
    return { ok: false, error: `Plan file is too large (${stat.size} bytes)` };
  return { ok: true, plan: fs.readFileSync(resolution.path, "utf-8") };
}

export const WorkflowTool: Tool = buildTool({
  name: "workflow",
  description: "Run a fan-out orchestration of worker sub-agents",
  promptDescription: `Run a multi-agent orchestration by submitting a JSON PLAN that fans out worker sub-agents, then synthesizes their reports. The plan is data, not code — no script is evaluated.\n\nParameters: plan (required unless scriptPath is given, JSON plan text), scriptPath (optional, read the plan from a workspace file instead), args (optional input recorded with the run), resumeFromRunId (optional, reuse a previous run's completed workers).\n\n${WORKFLOW_DSL_DOC}`,
  schema: WorkflowSchema,
  isReadOnly: false, // spawns sub-agent loops (model calls)
  isConcurrencySafe: false, // each workflow is a heavyweight unit; serialize

  async call(input, context): Promise<ToolResult> {
    if (!context.modelConfig) {
      return { content: "", error: "workflow requires modelConfig in context." };
    }
    if (context.permissionMode === "plan") {
      return { content: "", error: "Plan mode: workflow tool is disabled." };
    }

    // Official's `scriptPath` takes precedence over the inline script.
    let plan = input.plan ?? "";
    if (input.scriptPath) {
      const read = readPlanFromDisk(input.scriptPath, context);
      if (!read.ok) return { content: "", error: read.error };
      plan = read.plan;
    }
    if (!plan.trim()) {
      return {
        content: "",
        error: "plan (or scriptPath) is required — nothing to orchestrate.",
      };
    }
    // Official `script` is aliased onto `plan`, but official's script is a
    // JS module (`export const meta = …`) while this implementation takes JSON
    // data. Fail loudly and specifically rather than letting a JS script die in
    // JSON.parse with a bare "Unexpected token".
    if (!plan.trimStart().startsWith("{")) {
      return {
        content: "",
        error:
          "plan must be a JSON object starting with '{'. This build evaluates no " +
          "JavaScript: an official-style `script` module (export const meta = …, " +
          "agent(), parallel()) is not supported — send the equivalent JSON plan.",
      };
    }

    const record = await runWorkflow(plan, context, {
      args: input.args,
      resumeFromRunId: input.resumeFromRunId,
    });

    const header =
      `[Workflow ${record.id} ${record.status}]` +
      (record.result !== undefined ? `\nResult: ${record.result}` : "") +
      (record.logs.length > 0
        ? `\n\nProgress:\n${record.logs.map((l) => `  - ${l}`).join("\n")}`
        : "");

    return {
      content: header,
      error: record.status === "failed" ? "Workflow failed" : undefined,
      metadata: { durationMs: (record.finishedAt ?? Date.now()) - record.startedAt },
    };
  },
});
