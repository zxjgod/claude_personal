// ============================================================
// M8 Interactive tools — EnterPlanMode / ExitPlanMode / AskUserQuestion
// ============================================================
// These tools cooperate with session state and the CLI, rather than just
// touching the filesystem:
//   - plan-mode tools flip context.permissionMode at runtime (the agent loop
//     reuses one ToolContext object across a turn, so the mutation is seen by
//     subsequent permission checks in the same session).
//   - AskUserQuestion calls context.askUserQuestion (injected by the CLI) to
//     block for a structured choice. Without that callback (sub-agents/tests)
//     it returns a clear "not available" result instead of hanging.
// ============================================================

import { z } from "zod";
import type { PermissionMode, Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

// --- 8.2 EnterPlanMode -------------------------------------------------------

export const EnterPlanModeTool: Tool = buildTool({
  name: "enter_plan_mode",
  description: "Switch the session into read-only plan mode",
  promptDescription:
    "Enter plan mode: the session becomes read-only — research/read tools still " +
    "work, but destructive tools (write/edit/bash) are blocked until you call " +
    "exit_plan_mode. Use this while investigating before you've agreed on an approach.",
  schema: z.strictObject({}),
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(_input, context): Promise<ToolResult> {
    context.setPermissionMode?.("plan");
    (context as { permissionMode: PermissionMode }).permissionMode = "plan";
    return {
      content:
        "Entered plan mode. Destructive tools are now blocked. " +
        "Investigate freely, then call exit_plan_mode to resume editing.",
    };
  },
});

// --- 8.2 ExitPlanMode --------------------------------------------------------

const ExitPlanModeSchema = z.strictObject({
  to: z.enum(["default", "acceptEdits"]).optional().describe("Mode to return to (default)"),
});

export const ExitPlanModeTool: Tool = buildTool({
  name: "exit_plan_mode",
  description: "Leave plan mode and resume normal (or accept-edits) operation",
  promptDescription:
    "Exit plan mode once the user has approved the plan. Optionally pass to=" +
    "acceptEdits to auto-approve file edits afterward; otherwise returns to default.",
  schema: ExitPlanModeSchema,
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    const target: PermissionMode = input.to === "acceptEdits" ? "acceptEdits" : "default";
    context.setPermissionMode?.(target);
    (context as { permissionMode: PermissionMode }).permissionMode = target;
    return { content: `Exited plan mode. Now in "${target}" mode.` };
  },
});

// --- 8.1 AskUserQuestion -----------------------------------------------------

const AskUserQuestionOptionSchema = z.strictObject({
  label: z.string().describe("Option label shown to the user"),
  description: z.string().optional().describe("Additional context about this option"),
});

const AskUserQuestionSchema = z.strictObject({
  question: z.string().describe("The question to ask"),
  header: z.string().optional().describe("Short category label"),
  options: z
    .array(z.union([AskUserQuestionOptionSchema, z.string()]))
    .min(2)
    .max(4)
    .describe("Selectable options (objects with label/description, or strings)"),
  multiSelect: z.boolean().optional().describe("Allow choosing more than one"),
});

export const AskUserQuestionTool: Tool = buildTool({
  name: "ask_user_question",
  description: "Ask the user a structured single/multi-select question",
  promptDescription:
    "Ask the user a structured question with selectable options and block for " +
    "their answer. Use when you need a decision only the user can make (choosing " +
    "between valid approaches, confirming scope). Provide 2-4 concise options. " +
    "Set multiSelect:true to allow multiple selections. Returns the chosen label(s).",
  schema: AskUserQuestionSchema,
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    const options = (input.options ?? []).map((o) =>
      typeof o === "string" ? { label: o } : { label: o.label, description: o.description },
    );
    if (options.length === 0) {
      return { content: "", error: "ask_user_question requires at least one option" };
    }
    if (!context.askUserQuestion) {
      const list = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
      return {
        content:
          `[Interactive questions are unavailable in this context.]\n` +
          `Question: ${input.question}\nOptions:\n${list}`,
      };
    }
    const answer = await context.askUserQuestion({
      question: input.question,
      header: input.header ?? "Question",
      options,
      multiSelect: input.multiSelect === true,
    });
    if (answer === null) {
      return { content: "User cancelled the question without selecting an option." };
    }
    return { content: `User selected: ${answer.join(", ")}` };
  },
});
