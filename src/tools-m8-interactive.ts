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

import { createTool } from "./tool-registry.js";
import type { PermissionMode, Tool, ToolResult } from "./types.js";

// --- 8.2 EnterPlanMode -------------------------------------------------------

export const EnterPlanModeTool: Tool = createTool({
  name: "enter_plan_mode",
  description: "Switch the session into read-only plan mode",
  promptDescription:
    "Enter plan mode: the session becomes read-only — research/read tools still " +
    "work, but destructive tools (write/edit/bash) are blocked until you call " +
    "exit_plan_mode. Use this while investigating before you've agreed on an approach.",
  inputSchema: { type: "object", properties: {}, required: [] },
  isReadOnly: true, // entering a safer mode is itself non-destructive
  isConcurrencySafe: false,
  async call(_input, context): Promise<ToolResult> {
    (context as { permissionMode: PermissionMode }).permissionMode = "plan";
    return {
      content:
        "Entered plan mode. Destructive tools are now blocked. " +
        "Investigate freely, then call exit_plan_mode to resume editing.",
    };
  },
});

// --- 8.2 ExitPlanMode --------------------------------------------------------

interface ExitPlanModeInput {
  /** Mode to return to; defaults to "default". */
  to?: "default" | "acceptEdits";
  [key: string]: unknown;
}

export const ExitPlanModeTool: Tool = createTool<ExitPlanModeInput>({
  name: "exit_plan_mode",
  description: "Leave plan mode and resume normal (or accept-edits) operation",
  promptDescription:
    "Exit plan mode once the user has approved the plan. Optionally pass to=" +
    "acceptEdits to auto-approve file edits afterward; otherwise returns to default.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        enum: ["default", "acceptEdits"],
        description: "Mode to return to (default)",
      },
    },
    required: [],
  },
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    const target: PermissionMode = input.to === "acceptEdits" ? "acceptEdits" : "default";
    (context as { permissionMode: PermissionMode }).permissionMode = target;
    return { content: `Exited plan mode. Now in "${target}" mode.` };
  },
});

// --- 8.1 AskUserQuestion -----------------------------------------------------

interface AskUserQuestionInput {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }> | string[];
  multiSelect?: boolean;
  [key: string]: unknown;
}

/** Normalize options that may arrive as plain strings. */
function normalizeOptions(
  options: AskUserQuestionInput["options"],
): Array<{ label: string; description?: string }> {
  return (options ?? []).map((o) =>
    typeof o === "string" ? { label: o } : { label: o.label, description: o.description },
  );
}

export const AskUserQuestionTool: Tool = createTool<AskUserQuestionInput>({
  name: "ask_user_question",
  description: "Ask the user a structured single/multi-select question",
  promptDescription:
    "Ask the user a structured question with selectable options and block for " +
    "their answer. Use when you need a decision only the user can make (choosing " +
    "between valid approaches, confirming scope). Provide 2-4 concise options. " +
    "Set multiSelect:true to allow multiple selections. Returns the chosen label(s).",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask" },
      header: { type: "string", description: "Short category label" },
      options: {
        type: "array",
        description: "Selectable options (objects with label/description, or strings)",
        items: { type: "object" },
      },
      multiSelect: { type: "boolean", description: "Allow choosing more than one" },
    },
    required: ["question", "options"],
  },
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolResult> {
    const options = normalizeOptions(input.options);
    if (options.length === 0) {
      return { content: "", error: "ask_user_question requires at least one option" };
    }
    if (!context.askUserQuestion) {
      // No interactive channel (sub-agent / non-interactive). Surface the
      // question as text so the model can decide or defer rather than hang.
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
