// ============================================================
// Tests: Notification Center (M41)
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  drainNotifications,
  formatNotificationLine,
  formatTaskNotification,
  pushTaskNotification,
  resetNotifications,
  takeUnseenForDisplay,
} from "../tools/notifications.js";

describe("notifications", () => {
  beforeEach(() => {
    resetNotifications();
  });

  describe("pushTaskNotification / drainNotifications", () => {
    it("returns the formatted <task_notification> XML on drain", () => {
      pushTaskNotification("s1", {
        id: "job-3",
        kind: "bash",
        status: "done",
        summary: "run the test suite",
      });
      const drained = drainNotifications("s1");
      expect(drained).toHaveLength(1);
      expect(drained[0]).toBe(
        [
          "<task_notification>",
          "<task_id>job-3</task_id>",
          "<kind>bash</kind>",
          "<status>done</status>",
          "<summary>run the test suite</summary>",
          "</task_notification>",
        ].join("\n"),
      );
    });

    it("includes the <output> block when outputTail is present", () => {
      pushTaskNotification("s1", {
        id: "job-4",
        kind: "bash",
        status: "error",
        summary: "build failed",
        outputTail: "Error: missing symbol",
      });
      const drained = drainNotifications("s1");
      expect(drained[0]).toContain("<output>\nError: missing symbol\n</output>");
    });

    it("drains in FIFO order and empties the queue", () => {
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "first" });
      pushTaskNotification("s1", { id: "b", kind: "agent", status: "killed", summary: "second" });
      const drained = drainNotifications("s1");
      expect(drained).toHaveLength(2);
      expect(drained[0]).toContain("<task_id>a</task_id>");
      expect(drained[1]).toContain("<task_id>b</task_id>");
      expect(drainNotifications("s1")).toEqual([]);
    });

    it("returns [] for an unknown session", () => {
      expect(drainNotifications("never-pushed")).toEqual([]);
    });
  });

  describe("session isolation", () => {
    it("keeps per-session queues independent", () => {
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "one" });
      pushTaskNotification("s2", { id: "b", kind: "agent", status: "done", summary: "two" });
      pushTaskNotification("s2", { id: "c", kind: "bash", status: "done", summary: "three" });

      expect(drainNotifications("s1")).toHaveLength(1);
      // s2 untouched by s1's drain.
      expect(drainNotifications("s2")).toHaveLength(2);
      expect(drainNotifications("s2")).toEqual([]);
    });
  });

  describe("takeUnseenForDisplay", () => {
    it("peeks without draining the model-visible queue", () => {
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "one" });
      const unseen = takeUnseenForDisplay("s1");
      expect(unseen).toHaveLength(1);
      expect(unseen[0]).toEqual({ id: "a", kind: "bash", status: "done", summary: "one" });
      // Still queued for the model.
      expect(drainNotifications("s1")).toHaveLength(1);
    });

    it("marks returned notifications displayed so they are not shown again", () => {
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "one" });
      takeUnseenForDisplay("s1");
      expect(takeUnseenForDisplay("s1")).toEqual([]);
      // A later push is still unseen.
      pushTaskNotification("s1", { id: "b", kind: "agent", status: "done", summary: "two" });
      const unseen = takeUnseenForDisplay("s1");
      expect(unseen).toHaveLength(1);
      expect(unseen[0].id).toBe("b");
    });

    it("returns [] for an unknown session", () => {
      expect(takeUnseenForDisplay("never-pushed")).toEqual([]);
    });

    it("draining clears displayed state — a re-push is shown again", () => {
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "one" });
      takeUnseenForDisplay("s1");
      drainNotifications("s1");
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "one" });
      expect(takeUnseenForDisplay("s1")).toHaveLength(1);
    });
  });

  describe("formatTaskNotification", () => {
    it("emits task_id/kind/status/summary tags in order", () => {
      const xml = formatTaskNotification({
        id: "job-9",
        kind: "agent",
        status: "done",
        summary: "research summary",
      });
      const lines = xml.split("\n");
      expect(lines[0]).toBe("<task_notification>");
      expect(lines[1]).toBe("<task_id>job-9</task_id>");
      expect(lines[2]).toBe("<kind>agent</kind>");
      expect(lines[3]).toBe("<status>done</status>");
      expect(lines[4]).toBe("<summary>research summary</summary>");
      expect(lines[5]).toBe("</task_notification>");
      expect(lines).toHaveLength(6);
    });

    it("omits the <output> tag when outputTail is absent", () => {
      const xml = formatTaskNotification({
        id: "job-1",
        kind: "bash",
        status: "done",
        summary: "s",
      });
      expect(xml).not.toContain("<output>");
    });

    it("wraps outputTail in an <output> tag with newlines", () => {
      const xml = formatTaskNotification({
        id: "job-1",
        kind: "bash",
        status: "error",
        summary: "s",
        outputTail: "line one\nline two",
      });
      expect(xml).toContain("<output>\nline one\nline two\n</output>");
      expect(xml.endsWith("</task_notification>")).toBe(true);
    });
  });

  describe("formatNotificationLine", () => {
    it("renders the human-facing one-liner", () => {
      const line = formatNotificationLine({
        id: "job-3",
        kind: "bash",
        status: "done",
        summary: "run tests",
      });
      expect(line).toBe("后台任务 job-3 (bash) done: run tests");
    });

    it("truncates summaries longer than 60 chars with an ellipsis", () => {
      const summary = "x".repeat(80);
      const line = formatNotificationLine({
        id: "job-3",
        kind: "bash",
        status: "done",
        summary,
      });
      expect(line).toBe(`后台任务 job-3 (bash) done: ${"x".repeat(60)}…`);
    });

    it("does not truncate summaries of exactly 60 chars", () => {
      const summary = "x".repeat(60);
      const line = formatNotificationLine({
        id: "job-3",
        kind: "bash",
        status: "done",
        summary,
      });
      expect(line).toBe(`后台任务 job-3 (bash) done: ${summary}`);
    });
  });

  describe("resetNotifications", () => {
    it("clears only the given session when sessionId is passed", () => {
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "one" });
      pushTaskNotification("s2", { id: "b", kind: "bash", status: "done", summary: "two" });
      resetNotifications("s1");
      expect(drainNotifications("s1")).toEqual([]);
      expect(drainNotifications("s2")).toHaveLength(1);
    });

    it("clears all sessions when called without arguments", () => {
      pushTaskNotification("s1", { id: "a", kind: "bash", status: "done", summary: "one" });
      pushTaskNotification("s2", { id: "b", kind: "bash", status: "done", summary: "two" });
      resetNotifications();
      expect(drainNotifications("s1")).toEqual([]);
      expect(drainNotifications("s2")).toEqual([]);
    });
  });
});
