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
// Batch C2: the official approval flow. The agent presents its plan; the tool
// surfaces it via context.requestPlanApproval (the TUI's "Ready to code?"
// panel). Approve → acceptEdits and implementation continues; reject → the
// agent stays in plan mode with the feedback. Without an approval surface
// (sub-agents, tests, non-interactive runs) the call degrades to the legacy
// direct switch so those contexts keep working.

const ExitPlanModeSchema = z.strictObject({
  plan: z
    .string()
    .min(1)
    .describe(
      "The full implementation plan in markdown — approach, files you intend " +
        "to touch, and verification steps. This is what the user reviews.",
    ),
  to: z.enum(["default", "acceptEdits"]).optional().describe("Mode to return to (default)"),
});

export const ExitPlanModeTool: Tool = buildTool({
  name: "exit_plan_mode",
  description:
    "Present your implementation plan for user approval and exit plan mode. " +
    "Call ONLY in plan mode once exploration is done; approval switches the " +
    "session to accept-edits mode so you can implement. Ask clarifying " +
    "questions in plain text instead of calling this prematurely.",
  promptDescription:
    "Exit plan mode by presenting the implementation plan (markdown) for user " +
    "approval: { plan: '...' }. On approval the session switches to " +
    "accept-edits mode and you implement the plan; on rejection you stay in " +
    "plan mode and revise.",
  schema: ExitPlanModeSchema,
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    if (!context.requestPlanApproval) {
      return {
        content: input.plan ?? "",
        error: "Plan approval is unavailable; the session remains in plan mode.",
      };
    }
    const verdict = await context.requestPlanApproval(input.plan);
    if (verdict.choice === "approve") {
      context.setPermissionMode?.("acceptEdits");
      (context as { permissionMode: PermissionMode }).permissionMode = "acceptEdits";
      return {
        content:
          "Plan approved by the user. The session is now in accept-edits mode — " +
          "proceed with implementation exactly as approved." +
          (verdict.plan !== input.plan
            ? `

The user revised the plan in the editor; implement THIS version:

${verdict.plan}`
            : ""),
        metadata: { summary: "Plan approved — accept edits mode on" },
      };
    }
    return {
      content:
        `The user rejected the plan${verdict.plan !== input.plan ? " (with an edited version attached)" : ""}. ` +
        "You remain in plan mode. Read the feedback, revise, and call " +
        "exit_plan_mode again — or ask clarifying questions in plain text." +
        (verdict.plan !== input.plan
          ? `

User's edited plan:

${verdict.plan}`
          : ""),
      error: "plan rejected by user",
    };
  },
});

// --- 8.1 AskUserQuestion -----------------------------------------------------

const AskUserQuestionOptionSchema = z.strictObject({
  label: z.string().describe("Option label shown to the user"),
  description: z.string().optional().describe("Additional context about this option"),
  preview: z.string().optional().describe("Text or code preview shown while the option is focused"),
});

const SingleQuestionSchema = z.strictObject({
  question: z.string().describe("The question to ask"),
  header: z.string().optional().describe("Short category label"),
  options: z
    .array(z.union([AskUserQuestionOptionSchema, z.string()]))
    .min(2)
    .max(4)
    .describe("Selectable options (objects with label/description, or strings)"),
  multiSelect: z.boolean().optional().describe("Allow choosing more than one"),
});
const AskUserQuestionSchema = z.union([
  SingleQuestionSchema,
  z.strictObject({ questions: z.array(SingleQuestionSchema).min(1).max(4) }),
]);

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
    if ("questions" in input && Array.isArray(input.questions)) {
      const batch = input.questions as Array<z.infer<typeof SingleQuestionSchema>>;
      const answers: Record<string, string[]> = {};
      for (const [index, question] of batch.entries()) {
        if (!context.askUserQuestion)
          return {
            content: "Interactive questions are unavailable.",
            error: "No interactive question channel",
          };
        const answer = await context.askUserQuestion({
          ...question,
          header: `${index + 1}/${batch.length} · ${question.header ?? "Question"}`,
          multiSelect: question.multiSelect === true,
          options: question.options.map((option) =>
            typeof option === "string" ? { label: option } : option,
          ),
        });
        if (answer === null) return { content: JSON.stringify({ answers, cancelled: true }) };
        answers[question.question] = answer;
      }
      return { content: JSON.stringify({ answers }) };
    }
    const single = input as z.infer<typeof SingleQuestionSchema>;
    const options = (single.options ?? []).map((o) =>
      typeof o === "string"
        ? { label: o }
        : { label: o.label, description: o.description, preview: o.preview },
    );
    if (options.length === 0) {
      return { content: "", error: "ask_user_question requires at least one option" };
    }
    if (!context.askUserQuestion) {
      const list = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
      return {
        content:
          `[Interactive questions are unavailable in this context.]\n` +
          `Question: ${single.question}\nOptions:\n${list}`,
      };
    }
    const answer = await context.askUserQuestion({
      question: single.question,
      header: single.header ?? "Question",
      options,
      multiSelect: single.multiSelect === true,
    });
    if (answer === null) {
      return { content: "User cancelled the question without selecting an option." };
    }
    return { content: `User selected: ${answer.join(", ")}` };
  },
});
