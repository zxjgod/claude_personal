// ============================================================
// Todo Tool — Structured task list management
// ============================================================
// LLM creates/updates a structured task list that the user sees
// rendered as a progress tracker. The LLM sends the FULL list
// each time (complete replacement).
// ============================================================

import { createTool } from "./tool-registry.js";
import type { Tool, ToolResult } from "./types.js";

// --- Types ---

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface TodoInput {
  todos: TodoItem[];
  [key: string]: unknown;
}

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

export const TodoTool: Tool = createTool<TodoInput>({
  name: "todo",
  description: "Create and update a structured task list for the current coding session",
  promptDescription:
    "Create and update a structured task list for your current coding session. " +
    "Send the FULL list as { todos: [...] } each time — any existing items not " +
    "in the new list are removed. Each item needs content (description), status " +
    '(one of "pending" | "in_progress" | "completed"), and activeForm ' +
    "(a present-tense label shown while in progress, e.g. 'Adding tests').",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The COMPLETE todo list. Items not included will be removed.",
      },
    },
    required: ["todos"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    const todos = input.todos ?? [];

    // Validate
    for (const item of todos) {
      if (!item.content || typeof item.content !== "string") {
        return {
          content: "",
          error: `Invalid todo item: missing "content" (string)`,
        };
      }
      if (!["pending", "in_progress", "completed"].includes(item.status)) {
        return {
          content: "",
          error: `Invalid status "${item.status}" for "${item.content}". Must be: pending | in_progress | completed`,
        };
      }
    }

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
