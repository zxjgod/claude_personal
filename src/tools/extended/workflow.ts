// ============================================================
// Workflow Tool — run a model-written orchestration script
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { runWorkflow } from "../../workflow.js";
import { WORKFLOW_DSL_DOC } from "../../workflow-dsl.js";
import { buildTool } from "../registry.js";

const WorkflowSchema = z.strictObject({
  description: z.string().describe("Short (3-6 word) description of the workflow"),
  plan: z
    .string()
    .describe(
      "A JSON object describing the orchestration (DATA, not code — nothing is " +
        "evaluated). Shape: { phase?, steps: Step[] }. See the tool description for the " +
        "full step grammar. End with a synthesize step to produce the summary.",
    ),
  args: z.string().optional().describe("Optional input recorded with the workflow for context"),
  resumeFromRunId: z
    .string()
    .optional()
    .describe("Reuse completed unchanged worker calls from a previous run of this session"),
});

export const WorkflowTool: Tool = buildTool({
  name: "workflow",
  description: "Run a fan-out orchestration of worker sub-agents",
  promptDescription: `Run a multi-agent orchestration by submitting a JSON PLAN that fans out worker sub-agents, then synthesizes their reports. The plan is data, not code — no script is evaluated.\n\n${WORKFLOW_DSL_DOC}`,
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
    if (!input.plan.trim()) {
      return { content: "", error: "plan is required" };
    }

    const record = await runWorkflow(input.plan, context, {
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
