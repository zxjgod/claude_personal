// ============================================================
// Structured Task Management Tools
// ============================================================
// TaskCreate, TaskGet, TaskUpdate, TaskList - structured task tracking
// for project management, separate from the "task" tool (sub-agent spawning).
// ============================================================

import { z } from "zod";
import {
  createTask,
  getTask,
  listTasks,
  type StructuredTask,
  updateTask,
} from "../../structured-tasks.js";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

// ============================================================
// TaskCreate
// ============================================================

const TaskCreateSchema = z.strictObject({
  subject: z.string().min(1).describe("A brief title for the task (imperative form)"),
  description: z.string().min(1).describe("What needs to be done"),
  activeForm: z
    .string()
    .optional()
    .describe('Present continuous form shown in spinner when in_progress (e.g., "Running tests")'),
  metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata to attach"),
});

export const TaskCreateTool: Tool = buildTool({
  name: "TaskCreate",
  description: "Create a structured task for tracking work",
  promptDescription:
    "Create a task with a clear, actionable subject (imperative form like " +
    '"Fix authentication bug") and description. activeForm is shown in the spinner ' +
    'when in_progress (e.g., "Fixing authentication bug"). All tasks start as pending. ' +
    "Use TaskUpdate to set dependencies and change status.",
  schema: TaskCreateSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  searchHint: "task create todo project management tracking",

  async call(input, context): Promise<ToolResult> {
    const task = createTask(
      context.sessionId,
      input.subject,
      input.description,
      input.activeForm,
      input.metadata,
    );
    return {
      content:
        `Created task ${task.id}: ${task.subject}\n` +
        `Status: ${task.status}\n` +
        `Description: ${task.description}`,
    };
  },
});

// ============================================================
// TaskGet
// ============================================================

const TaskGetSchema = z.strictObject({
  taskId: z.string().describe("The ID of the task to retrieve"),
});

export const TaskGetTool: Tool = buildTool({
  name: "TaskGet",
  description: "Retrieve a task by its ID",
  promptDescription:
    "Get full details of a task including subject, description, status, dependencies " +
    "(blocks/blockedBy), owner, and metadata. Use before starting work to understand requirements.",
  schema: TaskGetSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "task get retrieve details",

  async call(input, context): Promise<ToolResult> {
    const task = getTask(context.sessionId, input.taskId);
    if (!task) {
      return { content: "", error: `Task ${input.taskId} not found` };
    }
    return { content: formatTaskDetails(task) };
  },
});

// ============================================================
// TaskUpdate
// ============================================================

const TaskUpdateSchema = z.strictObject({
  taskId: z.string().describe("The ID of the task to update"),
  status: z
    .enum(["pending", "in_progress", "completed", "deleted"])
    .optional()
    .describe("New status for the task"),
  subject: z.string().optional().describe("New subject for the task"),
  description: z.string().optional().describe("New description for the task"),
  activeForm: z.string().optional().describe("New activeForm for the task"),
  owner: z.string().optional().describe("New owner for the task"),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe("Metadata keys to merge. Set a key to null to delete it."),
  addBlocks: z.array(z.string()).optional().describe("Task IDs that this task blocks"),
  addBlockedBy: z.array(z.string()).optional().describe("Task IDs that block this task"),
});

export const TaskUpdateTool: Tool = buildTool({
  name: "TaskUpdate",
  description: "Update a task's status, details, or dependencies",
  promptDescription:
    "Update a task. status progresses: pending → in_progress → completed. " +
    "Use deleted to permanently remove. Set addBlocks for tasks that cannot start " +
    "until this one completes. Set addBlockedBy for tasks that must complete before " +
    "this one can start. IMPORTANT: Mark tasks completed only when FULLY accomplished. " +
    "If blocked or encountering errors, keep as in_progress and create new tasks for blockers.",
  schema: TaskUpdateSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  searchHint: "task update status complete block",

  async call(input, context): Promise<ToolResult> {
    const { taskId, ...updates } = input;
    const task = updateTask(context.sessionId, taskId, updates);
    if (!task) {
      return { content: "", error: `Task ${taskId} not found` };
    }
    return {
      content: `Updated task ${task.id}: ${task.subject}\nStatus: ${task.status}`,
    };
  },
});

// ============================================================
// TaskList
// ============================================================

const TaskListSchema = z.strictObject({});

export const TaskListTool: Tool = buildTool({
  name: "TaskList",
  description: "List all tasks in the task list",
  promptDescription:
    "List all tasks with id, subject, status, owner, and blockedBy. Use to see what " +
    "tasks are available to work on (status: pending, no owner, not blocked) or check " +
    "overall progress. Prefer working on tasks in ID order (lowest first) when multiple " +
    "are available.",
  schema: TaskListSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "task list show all tasks",

  async call(_input, context): Promise<ToolResult> {
    const tasks = listTasks(context.sessionId);
    if (tasks.length === 0) {
      return { content: "No tasks. Create one with TaskCreate." };
    }

    const lines = tasks.map((t) => {
      const blockedNote = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : "";
      const ownerNote = t.owner ? ` (owner: ${t.owner})` : "";
      return `${t.id}. [${t.status}] ${t.subject}${ownerNote}${blockedNote}`;
    });

    return {
      content: `Tasks (${tasks.length}):\n${lines.join("\n")}`,
    };
  },
});

// ============================================================
// Helper
// ============================================================

function formatTaskDetails(task: StructuredTask): string {
  const lines = [
    `Task ${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
  ];

  if (task.activeForm) {
    lines.push(`Active Form: ${task.activeForm}`);
  }
  if (task.owner) {
    lines.push(`Owner: ${task.owner}`);
  }
  if (task.blocks.length > 0) {
    lines.push(`Blocks: ${task.blocks.join(", ")}`);
  }
  if (task.blockedBy.length > 0) {
    lines.push(`Blocked By: ${task.blockedBy.join(", ")}`);
  }
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
  }

  return lines.join("\n");
}
