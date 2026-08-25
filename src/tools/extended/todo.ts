// ============================================================
// Todo Tool — Structured task list management
// ============================================================
// LLM creates/updates a structured task list that the user sees
// rendered as a progress tracker. The LLM sends the FULL list
// each time (complete replacement).
// ============================================================

import { z } from "zod";
import type { TodoDisplayItem, Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

// --- Types ---

// The tool's item shape IS the display shape: the TUI pins the list under the
// spinner as a live projection of this state (via metadata.todos).
type TodoItem = TodoDisplayItem;

const TodoItemSchema = z.strictObject({
  content: z.string().describe("Task description"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Current status"),
  activeForm: z.string().describe("Present-tense label shown while working (e.g. 'Adding tests')"),
});

const TodoSchema = z.strictObject({
  todos: z
    .array(TodoItemSchema)
    .describe("The COMPLETE todo list. Items not included will be removed."),
});
type TodoInput = z.infer<typeof TodoSchema>;

// Module-level session storage
const sessionTodos: Map<string, TodoItem[]> = new Map();

// --- Status Display ---

const STATUS_MAP: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
};

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "(empty todo list)";
  }

  const lines: string[] = [];
  for (const item of todos) {
    const icon = STATUS_MAP[item.status] || "❓";
    lines.push(`${icon} [${item.status}] ${item.content}`);
    if (item.status === "in_progress" && item.activeForm) {
      lines.push(`     → ${item.activeForm}`);
    }
  }
  return lines.join("\n");
}

// --- Tool ---

export const TodoTool: Tool = buildTool({
  name: "todo",
  description: "Create and update a structured task list for the current coding session",
  promptDescription:
    "Create and update a structured task list for your current coding session. " +
    "Send the FULL list as { todos: [...] } each time — existing items not " +
    "included will be removed. Each item needs: content (task description), " +
    "status (one of 'pending' | 'in_progress' | 'completed'), and activeForm " +
    "(present-tense label shown while working, e.g. 'Adding tests'). " +
    "Use this to track multi-step tasks and show progress to the user.",
  schema: TodoSchema,
  isReadOnly: false,
  isConcurrencySafe: false,
  searchHint: "todo task list track progress checklist",
  aliases: ["todos", "tasks", "checklist"],

  async call(input, context): Promise<ToolResult> {
    // Zod validation ensures todos is a valid array with proper item structure
    const todos: TodoItem[] = input.todos;

    // Store
    sessionTodos.set(context.sessionId, todos);

    // Format display
    const counts = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      total: todos.length,
    };
    for (const item of todos) {
      if (item.status === "completed") counts.completed++;
      else if (item.status === "in_progress") counts.in_progress++;
      else counts.pending++;
    }

    let content = `Todo list updated: ${counts.total} items`;
    content += ` (${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed)\n\n`;
    content += formatTodoList(todos);

    return {
      content,
      metadata: {
        linesRead: counts.total,
        // Compact committed row for both UIs; the TUI's live region reads the
        // structured list below instead of this text.
        summary: `Updated todo list: ${counts.total} items (${counts.completed} done)`,
        todos: todos.map((t) => ({ ...t })),
      },
    };
  },

  checkPermissions: async (_input, _context) => {
    return { allowed: true }; // Not destructive
  },
});

// --- Export helpers ---

export function getTodos(sessionId: string): TodoItem[] {
  return sessionTodos.get(sessionId) ?? [];
}

export function clearTodos(sessionId: string): void {
  sessionTodos.delete(sessionId);
}
