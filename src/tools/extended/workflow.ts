// ============================================================
// Workflow Tool — run a model-written orchestration script
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { runWorkflow } from "../../workflow.js";
import { buildTool } from "../registry.js";

const WorkflowSchema = z.strictObject({
  description: z.string().describe("Short (3-6 word) description of the workflow"),
  script: z
    .string()
    .describe(
      "An async JS expression body that orchestrates worker sub-agents. " +
        "Available globals: agent(prompt,{label}) to run one worker and get its final text; " +
        "parallel([() => agent(...), ...]) to run several at once; " +
        "pipeline(items, ...stages); log(msg) and phase(title) for progress; args for input. " +
        "End with `return <summary>`.",
    ),
  args: z.string().optional().describe("Optional input string exposed to the script as `args`"),
});

export const WorkflowTool: Tool = buildTool({
  name: "workflow",
  description: "Run a fan-out orchestration of worker sub-agents",
  promptDescription:
    "Run a multi-agent orchestration: write a small async JS script that fans out " +
    "worker sub-agents in parallel, then synthesize. Globals: agent(prompt,{label}) " +
    "(one worker → its final text), parallel([thunks]), pipeline(items,...stages), " +
    "log(msg), phase(title), args. End with `return <summary>`. Workers get a limited " +
    "toolset (read/glob/grep/bash — bash is NOT sandboxed, so workers can mutate " +
    "files), capped at a bounded concurrency. Only final worker texts are " +
    "returned — not their intermediate tool output.",
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
    if (!input.script.trim()) {
      return { content: "", error: "script is required" };
    }

    const record = await runWorkflow(input.script, context, { args: input.args });

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
