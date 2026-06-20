// ============================================================
// Tests: New Tools (Todo, WebFetch, Task)
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TodoTool, getTodos, clearTodos } from "../todo-tool.js";
import type { ToolContext } from "../types.js";

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-newtools-"));
  ctx = {
    workspaceRoot: tmpDir,
    sessionId: "test-newtools",
    permissionMode: "default",
  };
  clearTodos("test-newtools");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearTodos("test-newtools");
});

// --- TodoTool ---

describe("TodoTool", () => {
  it("should store and format an empty list", async () => {
    const result = await TodoTool.call({ todos: [] }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("(empty todo list)");
  });

  it("should store and display todo items", async () => {
    const result = await TodoTool.call(
      {
        todos: [
          { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
          { content: "Design API", status: "completed", activeForm: "Designing API" },
          { content: "Deploy", status: "pending", activeForm: "Deploying" },
        ],
      },
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Write tests");
    expect(result.content).toContain("Design API");
    expect(result.content).toContain("Deploy");
    expect(result.content).toContain("3 items");
    expect(result.content).toContain("1 in progress");
  });

  it("should display activeForm for in_progress items", async () => {
    const result = await TodoTool.call(
      {
        todos: [
          { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug #42" },
        ],
      },
      ctx,
    );
    expect(result.content).toContain("→ Fixing bug #42");
  });

  it("should reject invalid status values", async () => {
    const result = await TodoTool.call(
      {
        todos: [
          { content: "Bad item", status: "invalid_status", activeForm: "Test" },
        ],
      } as any,
      ctx,
    );
    expect(result.error).toContain("Invalid status");
  });

  it("should reject items without content", async () => {
    const result = await TodoTool.call(
      {
        todos: [{ status: "pending", activeForm: "" }],
      } as any,
      ctx,
    );
    expect(result.error).toContain("Invalid todo item");
  });

  it("should replace previous todo list on update", async () => {
    await TodoTool.call(
      { todos: [{ content: "Old task", status: "pending", activeForm: "Old" }] },
      ctx,
    );
    const result = await TodoTool.call(
      { todos: [{ content: "New task", status: "completed", activeForm: "New" }] },
      ctx,
    );
    expect(result.content).toContain("New task");
    expect(result.content).not.toContain("Old task");
  });

  it("should store todos per session", async () => {
    await TodoTool.call(
      { todos: [{ content: "Session A", status: "pending", activeForm: "A" }] },
      ctx,
    );
    const todosA = getTodos("test-newtools");
    expect(todosA).toHaveLength(1);

    const todosB = getTodos("other-session");
    expect(todosB).toHaveLength(0);
  });
});

// --- WebFetchTool (static tests, no network) ---

import { WebFetchTool } from "../web-fetch.js";

describe("WebFetchTool", () => {
  it("should reject missing url", async () => {
    const result = await WebFetchTool.call(
      { url: "", fetchInfo: "test" },
      ctx,
    );
    expect(result.error).toContain("url is required");
  });

  it("should reject missing fetchInfo", async () => {
    const result = await WebFetchTool.call(
      { url: "https://example.com", fetchInfo: "" },
      ctx,
    );
    expect(result.error).toContain("fetchInfo is required");
  });

  it("should reject non-http protocols", async () => {
    const result = await WebFetchTool.call(
      { url: "ftp://example.com/file", fetchInfo: "test" },
      ctx,
    );
    expect(result.error).toContain("Unsupported protocol");
  });

  it("should reject invalid URLs", async () => {
    const result = await WebFetchTool.call(
      { url: "not-a-valid-url!!!", fetchInfo: "test" },
      ctx,
    );
    expect(result.error).toContain("Invalid URL");
  });

  it("should reject internal/localhost addresses", async () => {
    const result = await WebFetchTool.call(
      { url: "http://localhost:3000/api", fetchInfo: "test" },
      ctx,
    );
    expect(result.error).toContain("internal");
  });

  it("should reject 127.0.0.1", async () => {
    const result = await WebFetchTool.call(
      { url: "http://127.0.0.1:8080/data", fetchInfo: "test" },
      ctx,
    );
    expect(result.error).toContain("internal");
  });

  it("should reject 192.168.x.x addresses", async () => {
    const result = await WebFetchTool.call(
      { url: "http://192.168.1.1/admin", fetchInfo: "test" },
      ctx,
    );
    expect(result.error).toContain("internal");
  });

  it("should reject 10.x.x.x addresses", async () => {
    const result = await WebFetchTool.call(
      { url: "http://10.0.0.1/secret", fetchInfo: "test" },
      ctx,
    );
    expect(result.error).toContain("internal");
  });
});

// --- TaskTool (static tests, no LLM) ---

import { TaskTool } from "../task-tool.js";

describe("TaskTool", () => {
  it("does not require parent approval", () => {
    expect(TaskTool.requiresApproval?.()).toBe(false);
  });

  it("should reject missing description", async () => {
    const result = await TaskTool.call(
      { description: "", prompt: "do something", subagent_name: "code-explorer" },
      ctx,
    );
    expect(result.error).toContain("description is required");
  });

  it("should reject missing prompt", async () => {
    const result = await TaskTool.call(
      { description: "test", prompt: "", subagent_name: "code-explorer" },
      ctx,
    );
    expect(result.error).toContain("prompt is required");
  });

  it("should reject unknown subagent type", async () => {
    const result = await TaskTool.call(
      {
        description: "test",
        prompt: "do something",
        subagent_name: "nonexistent-type",
      },
      ctx,
    );
    expect(result.error).toContain("Unknown subagent type");
  });

  it("should require modelConfig in context", async () => {
    const ctxWithoutModel: ToolContext = {
      workspaceRoot: tmpDir,
      sessionId: "test",
      permissionMode: "default",
    };
    const result = await TaskTool.call(
      {
        description: "test",
        prompt: "do something",
        subagent_name: "code-explorer",
      },
      ctxWithoutModel,
    );
    expect(result.error).toContain("modelConfig");
  });
});
