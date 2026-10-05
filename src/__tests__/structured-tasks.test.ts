// ============================================================
// Structured Task Management Tests
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTasks,
  createTask,
  getTask,
  listTasks,
  resetTaskIdCounter,
  updateTask,
} from "../structured-tasks.js";

describe("Structured Tasks", () => {
  const sessionId = "test-session";

  beforeEach(() => {
    clearTasks(sessionId);
    resetTaskIdCounter();
  });

  describe("createTask", () => {
    it("should create a task with default status pending", () => {
      const task = createTask(sessionId, "Fix bug", "Fix the authentication bug");

      expect(task.id).toBe("1");
      expect(task.subject).toBe("Fix bug");
      expect(task.description).toBe("Fix the authentication bug");
      expect(task.status).toBe("pending");
      expect(task.blocks).toEqual([]);
      expect(task.blockedBy).toEqual([]);
    });

    it("should create tasks with sequential IDs", () => {
      const task1 = createTask(sessionId, "Task 1", "Description 1");
      const task2 = createTask(sessionId, "Task 2", "Description 2");

      expect(task1.id).toBe("1");
      expect(task2.id).toBe("2");
    });

    it("should support activeForm and metadata", () => {
      const task = createTask(sessionId, "Run tests", "Run all unit tests", "Running tests", {
        priority: "high",
      });

      expect(task.activeForm).toBe("Running tests");
      expect(task.metadata).toEqual({ priority: "high" });
    });
  });

  describe("getTask", () => {
    it("should retrieve an existing task", () => {
      const created = createTask(sessionId, "Test", "Description");
      const retrieved = getTask(sessionId, created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.subject).toBe("Test");
    });

    it("should return undefined for non-existent task", () => {
      const task = getTask(sessionId, "999");
      expect(task).toBeUndefined();
    });

    it("should isolate tasks by session", () => {
      const task1 = createTask("session1", "Task 1", "Desc 1");
      const task2 = createTask("session2", "Task 2", "Desc 2");

      expect(getTask("session1", task1.id)).toBeDefined();
      expect(getTask("session1", task2.id)).toBeUndefined();
      expect(getTask("session2", task2.id)).toBeDefined();
      expect(getTask("session2", task1.id)).toBeUndefined();
    });
  });

  describe("listTasks", () => {
    it("should list all tasks for a session", () => {
      createTask(sessionId, "Task 1", "Desc 1");
      createTask(sessionId, "Task 2", "Desc 2");

      const tasks = listTasks(sessionId);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]?.subject).toBe("Task 1");
      expect(tasks[1]?.subject).toBe("Task 2");
    });

    it("should return empty array for session with no tasks", () => {
      const tasks = listTasks("empty-session");
      expect(tasks).toEqual([]);
    });
  });

  describe("updateTask", () => {
    it("should update task status", () => {
      const task = createTask(sessionId, "Task", "Description");
      const updated = updateTask(sessionId, task.id, { status: "in_progress" });

      expect(updated?.status).toBe("in_progress");
    });

    it("should update task subject and description", () => {
      const task = createTask(sessionId, "Old", "Old desc");
      const updated = updateTask(sessionId, task.id, {
        subject: "New",
        description: "New desc",
      });

      expect(updated?.subject).toBe("New");
      expect(updated?.description).toBe("New desc");
    });

    it("should add dependencies", () => {
      const task1 = createTask(sessionId, "Task 1", "Desc 1");
      const task2 = createTask(sessionId, "Task 2", "Desc 2");

      updateTask(sessionId, task2.id, { addBlockedBy: [task1.id] });
      updateTask(sessionId, task1.id, { addBlocks: [task2.id] });

      const updated1 = getTask(sessionId, task1.id);
      const updated2 = getTask(sessionId, task2.id);

      expect(updated1?.blocks).toContain(task2.id);
      expect(updated2?.blockedBy).toContain(task1.id);
    });

    it("should not duplicate dependencies", () => {
      const task = createTask(sessionId, "Task", "Desc");
      const other = createTask(sessionId, "Other", "Desc");
      updateTask(sessionId, task.id, { addBlocks: [other.id] });
      updateTask(sessionId, task.id, { addBlocks: [other.id] });

      const updated = getTask(sessionId, task.id);
      expect(updated?.blocks).toEqual([other.id]);
      expect(getTask(sessionId, other.id)?.blockedBy).toEqual([task.id]);
    });

    it("should ignore dependencies on unknown tasks and self-references", () => {
      const task = createTask(sessionId, "Task", "Desc");
      updateTask(sessionId, task.id, { addBlocks: ["999", task.id] });

      const updated = getTask(sessionId, task.id);
      expect(updated?.blocks).toEqual([]);
      expect(updated?.blockedBy).toEqual([]);
    });

    it("should reject dependency cycles", () => {
      const a = createTask(sessionId, "A", "Desc");
      const b = createTask(sessionId, "B", "Desc");
      updateTask(sessionId, a.id, { addBlocks: [b.id] });
      updateTask(sessionId, b.id, { addBlocks: [a.id] }); // would close a cycle

      expect(getTask(sessionId, b.id)?.blocks).toEqual([]);
      expect(getTask(sessionId, a.id)?.blockedBy).toEqual([]);
    });

    it("should merge metadata", () => {
      const task = createTask(sessionId, "Task", "Desc", undefined, { a: 1, b: 2 });
      updateTask(sessionId, task.id, { metadata: { b: 3, c: 4 } });

      const updated = getTask(sessionId, task.id);
      expect(updated?.metadata).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("should delete metadata keys when set to null", () => {
      const task = createTask(sessionId, "Task", "Desc", undefined, { a: 1, b: 2 });
      updateTask(sessionId, task.id, { metadata: { b: null } });

      const updated = getTask(sessionId, task.id);
      expect(updated?.metadata).toEqual({ a: 1 });
    });

    it("should return undefined for non-existent task", () => {
      const result = updateTask(sessionId, "999", { status: "completed" });
      expect(result).toBeUndefined();
    });

    it("should update updatedAt timestamp", () => {
      const task = createTask(sessionId, "Task", "Desc");
      const originalUpdatedAt = task.updatedAt;

      // Wait a bit to ensure timestamp differs
      const startTime = Date.now();
      while (Date.now() - startTime < 5) {
        // Busy wait
      }

      const updated = updateTask(sessionId, task.id, { status: "in_progress" });
      expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe("task lifecycle", () => {
    it("should support full task lifecycle", () => {
      // Create
      const task = createTask(sessionId, "Implement feature", "Add new feature X");
      expect(task.status).toBe("pending");

      // Start work
      updateTask(sessionId, task.id, { status: "in_progress", owner: "alice" });
      let updated = getTask(sessionId, task.id);
      expect(updated?.status).toBe("in_progress");
      expect(updated?.owner).toBe("alice");

      // Complete
      updateTask(sessionId, task.id, { status: "completed" });
      updated = getTask(sessionId, task.id);
      expect(updated?.status).toBe("completed");

      // Delete — review fix: status:"deleted" actually REMOVES the task
      // (the old code tagged it in place, leaving it listed forever).
      updateTask(sessionId, task.id, { status: "deleted" });
      updated = getTask(sessionId, task.id);
      expect(updated).toBeUndefined();
      expect(listTasks(sessionId).some((t) => t.id === task.id)).toBe(false);
    });
  });
});
