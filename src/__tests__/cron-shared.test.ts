// ============================================================
// Cron Tools Tests
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  getScheduledJob,
  listScheduledJobs,
  registerScheduledJob,
  removeScheduledJob,
  resetScheduledJobs,
  validateCron,
} from "../tools/extended/cron-shared.js";

describe("Cron Shared Logic", () => {
  beforeEach(() => {
    resetScheduledJobs();
  });

  describe("validateCron", () => {
    it("should accept valid cron expressions", () => {
      expect(validateCron("0 9 * * *")).toBeNull();
      expect(validateCron("*/5 * * * *")).toBeNull();
      expect(validateCron("30 14 1 * *")).toBeNull();
      expect(validateCron("0 0 * * 0")).toBeNull();
      expect(validateCron("0-30 9-17 * * 1-5")).toBeNull();
    });

    it("should reject invalid field count", () => {
      expect(validateCron("0 9 *")).toContain("5 fields");
      expect(validateCron("0 9 * * * *")).toContain("5 fields");
    });

    it("should reject out-of-range values", () => {
      expect(validateCron("60 9 * * *")).toContain("out of range");
      expect(validateCron("0 24 * * *")).toContain("out of range");
      expect(validateCron("0 0 32 * *")).toContain("out of range");
      expect(validateCron("0 0 * 13 *")).toContain("out of range");
      expect(validateCron("0 0 * * 8")).toContain("out of range");
    });

    it("should reject invalid syntax", () => {
      expect(validateCron("abc 9 * * *")).toContain("not a number");
      expect(validateCron("0 9/2/3 * * *")).toContain("too many / separators");
      expect(validateCron("0 9/abc * * *")).toContain("positive integer");
    });

    it("should reject invalid ranges", () => {
      expect(validateCron("30-10 * * * *")).toContain("range end before start");
    });
  });

  describe("registerScheduledJob", () => {
    it("should register a job with default settings", () => {
      const job = registerScheduledJob({
        cron: "0 9 * * *",
        prompt: "Test prompt",
        recurring: true,
        durable: false,
      });

      expect(job.id).toBeDefined();
      expect(job.cron).toBe("0 9 * * *");
      expect(job.prompt).toBe("Test prompt");
      expect(job.recurring).toBe(true);
      expect(job.durable).toBe(false);
    });

    it("should generate unique IDs", () => {
      const job1 = registerScheduledJob({
        cron: "0 9 * * *",
        prompt: "Prompt 1",
        recurring: true,
        durable: false,
      });
      const job2 = registerScheduledJob({
        cron: "0 10 * * *",
        prompt: "Prompt 2",
        recurring: true,
        durable: false,
      });

      expect(job1.id).not.toBe(job2.id);
    });

    it("should trim cron expression", () => {
      const job = registerScheduledJob({
        cron: "  0 9 * * *  ",
        prompt: "Test",
        recurring: true,
        durable: false,
      });

      expect(job.cron).toBe("0 9 * * *");
    });
  });

  describe("listScheduledJobs", () => {
    it("should list all registered jobs", () => {
      registerScheduledJob({
        cron: "0 9 * * *",
        prompt: "Job 1",
        recurring: true,
        durable: false,
      });
      registerScheduledJob({
        cron: "0 10 * * *",
        prompt: "Job 2",
        recurring: true,
        durable: false,
      });

      const jobs = listScheduledJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.prompt).toBe("Job 1");
      expect(jobs[1]?.prompt).toBe("Job 2");
    });

    it("should return empty array when no jobs", () => {
      const jobs = listScheduledJobs();
      expect(jobs).toEqual([]);
    });
  });

  describe("getScheduledJob", () => {
    it("should retrieve a job by ID", () => {
      const registered = registerScheduledJob({
        cron: "0 9 * * *",
        prompt: "Test",
        recurring: true,
        durable: false,
      });

      const retrieved = getScheduledJob(registered.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(registered.id);
      expect(retrieved?.prompt).toBe("Test");
    });

    it("should return undefined for non-existent job", () => {
      const job = getScheduledJob("non-existent");
      expect(job).toBeUndefined();
    });
  });

  describe("removeScheduledJob", () => {
    it("should remove a job and return true", () => {
      const job = registerScheduledJob({
        cron: "0 9 * * *",
        prompt: "Test",
        recurring: true,
        durable: false,
      });

      const removed = removeScheduledJob(job.id);
      expect(removed).toBe(true);
      expect(getScheduledJob(job.id)).toBeUndefined();
      expect(listScheduledJobs()).toHaveLength(0);
    });

    it("should return false for non-existent job", () => {
      const removed = removeScheduledJob("non-existent");
      expect(removed).toBe(false);
    });
  });

  describe("resetScheduledJobs", () => {
    it("should clear all jobs", () => {
      registerScheduledJob({
        cron: "0 9 * * *",
        prompt: "Job 1",
        recurring: true,
        durable: false,
      });
      registerScheduledJob({
        cron: "0 10 * * *",
        prompt: "Job 2",
        recurring: true,
        durable: false,
      });

      expect(listScheduledJobs()).toHaveLength(2);

      resetScheduledJobs();

      expect(listScheduledJobs()).toHaveLength(0);
    });
  });

  describe("job types", () => {
    it("should support one-shot jobs", () => {
      const job = registerScheduledJob({
        cron: "30 14 25 12 *",
        prompt: "Christmas reminder",
        recurring: false,
        durable: false,
      });

      expect(job.recurring).toBe(false);
    });

    it("should support durable jobs", () => {
      const job = registerScheduledJob({
        cron: "0 9 * * 1-5",
        prompt: "Daily standup",
        recurring: true,
        durable: true,
      });

      expect(job.durable).toBe(true);
    });
  });
});
