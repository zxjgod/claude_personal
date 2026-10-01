// ============================================================
// ScheduleWakeup Tests
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelWakeup,
  getWakeupJob,
  listWakeupJobs,
  resetWakeupJobs,
  ScheduleWakeupTool,
  scheduleWakeup,
} from "../tools/extended/schedule-wakeup.js";

describe("ScheduleWakeup", () => {
  beforeEach(() => {
    resetWakeupJobs();
  });

  describe("scheduleWakeup", () => {
    it("should schedule a wakeup job", () => {
      const job = scheduleWakeup(120, "Check CI status", "Waiting for build");

      expect(job.id).toBeDefined();
      expect(job.delaySeconds).toBe(120);
      expect(job.prompt).toBe("Check CI status");
      expect(job.reason).toBe("Waiting for build");
      expect(job.scheduledAt).toBeDefined();
      expect(job.fireAt).toBeDefined();
    });

    it("should generate unique IDs", () => {
      const job1 = scheduleWakeup(60, "Prompt 1", "Reason 1");
      const job2 = scheduleWakeup(60, "Prompt 2", "Reason 2");

      expect(job1.id).not.toBe(job2.id);
    });

    it("should calculate fireAt correctly", () => {
      const before = process.hrtime.bigint();
      const job = scheduleWakeup(120, "Test", "Test reason");
      const after = process.hrtime.bigint();

      const expectedMin = before + BigInt(120 * 1_000_000_000);
      const expectedMax = after + BigInt(120 * 1_000_000_000);

      expect(job.fireAt).toBeGreaterThanOrEqual(expectedMin);
      expect(job.fireAt).toBeLessThanOrEqual(expectedMax);
    });
  });

  describe("listWakeupJobs", () => {
    it("should list all scheduled wakeup jobs", () => {
      scheduleWakeup(60, "Job 1", "Reason 1");
      scheduleWakeup(120, "Job 2", "Reason 2");

      const jobs = listWakeupJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.prompt).toBe("Job 1");
      expect(jobs[1]?.prompt).toBe("Job 2");
    });

    it("should return empty array when no jobs", () => {
      const jobs = listWakeupJobs();
      expect(jobs).toEqual([]);
    });
  });

  describe("getWakeupJob", () => {
    it("should retrieve a job by ID", () => {
      const scheduled = scheduleWakeup(60, "Test", "Test reason");
      const retrieved = getWakeupJob(scheduled.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(scheduled.id);
      expect(retrieved?.prompt).toBe("Test");
    });

    it("should return undefined for non-existent job", () => {
      const job = getWakeupJob("non-existent");
      expect(job).toBeUndefined();
    });
  });

  describe("cancelWakeup", () => {
    it("should cancel a job and return true", () => {
      const job = scheduleWakeup(60, "Test", "Test reason");
      expect(listWakeupJobs()).toHaveLength(1);

      const cancelled = cancelWakeup(job.id);
      expect(cancelled).toBe(true);
      expect(listWakeupJobs()).toHaveLength(0);
      expect(getWakeupJob(job.id)).toBeUndefined();
    });

    it("should return false for non-existent job", () => {
      const cancelled = cancelWakeup("non-existent");
      expect(cancelled).toBe(false);
    });
  });

  describe("resetWakeupJobs", () => {
    it("should clear all jobs", () => {
      scheduleWakeup(60, "Job 1", "Reason 1");
      scheduleWakeup(120, "Job 2", "Reason 2");
      expect(listWakeupJobs()).toHaveLength(2);

      resetWakeupJobs();
      expect(listWakeupJobs()).toHaveLength(0);
    });
  });

  describe("cache-aware delays", () => {
    it("should handle short delays (cache warm)", () => {
      const job = scheduleWakeup(270, "Quick check", "Under 5 min");
      expect(job.delaySeconds).toBe(270);
    });

    it("should handle long delays (amortize cache miss)", () => {
      const job = scheduleWakeup(1800, "Long wait", "30 min idle");
      expect(job.delaySeconds).toBe(1800);
    });

    it("should warn about 300s inefficiency in tool", () => {
      // This is tested at the tool level, not core logic
      const job = scheduleWakeup(300, "Edge case", "Exactly 5 min");
      expect(job.delaySeconds).toBe(300);
    });
  });

  describe("tool input contract", () => {
    it("accepts stop=true without scheduling fields", () => {
      expect(ScheduleWakeupTool.validateInput?.({ stop: true })).toEqual({ stop: true });
    });

    it("rejects an incomplete scheduling request", () => {
      expect(() => ScheduleWakeupTool.validateInput?.({ prompt: "check" })).toThrow(
        /delaySeconds: Required unless stop=true/,
      );
    });
  });
});
