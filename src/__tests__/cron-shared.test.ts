// ============================================================
// Cron Tools Tests
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectDueCronJobs,
  cronMatches,
  getScheduledJob,
  listScheduledJobs,
  loadDurableJobs,
  MAX_SCHEDULED_JOBS,
  persistDurableJobs,
  registerScheduledJob,
  removeScheduledJob,
  resetScheduledJobs,
  type ScheduledJob,
  validateCron,
} from "../tools/extended/cron-shared.js";

/** Register and assert success (registerScheduledJob returns null at the cap). */
function mustRegister(input: {
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}): ScheduledJob {
  const job = registerScheduledJob(input);
  if (!job) throw new Error("job registration unexpectedly hit the cap");
  return job;
}

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

    it("should accept relative +N second delays", () => {
      expect(validateCron("+60")).toBeNull();
      expect(validateCron("+3600")).toBeNull();
      expect(validateCron("  +120  ")).toBeNull();
    });

    it("should reject malformed relative delays", () => {
      expect(validateCron("+0")).toContain("positive integer");
      expect(validateCron("+abc")).toContain("positive integer");
      expect(validateCron("+-5")).toContain("positive integer");
    });
  });

  describe("registerScheduledJob", () => {
    it("should register a job with default settings", () => {
      const job = mustRegister({
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
      const job1 = mustRegister({
        cron: "0 9 * * *",
        prompt: "Prompt 1",
        recurring: true,
        durable: false,
      });
      const job2 = mustRegister({
        cron: "0 10 * * *",
        prompt: "Prompt 2",
        recurring: true,
        durable: false,
      });

      expect(job1.id).not.toBe(job2.id);
    });

    it("should trim cron expression", () => {
      const job = mustRegister({
        cron: "  0 9 * * *  ",
        prompt: "Test",
        recurring: true,
        durable: false,
      });

      expect(job.cron).toBe("0 9 * * *");
    });

    it("should stamp createdAtMs for +N anchoring", () => {
      const before = Date.now();
      const job = mustRegister({
        cron: "+60",
        prompt: "Test",
        recurring: false,
        durable: false,
      });
      expect(job.createdAtMs).toBeGreaterThanOrEqual(before);
    });

    it("should return null once the MAX_SCHEDULED_JOBS cap is reached", () => {
      for (let i = 0; i < MAX_SCHEDULED_JOBS; i++) {
        mustRegister({ cron: "0 9 * * *", prompt: `Job ${i}`, recurring: true, durable: false });
      }
      const overflow = registerScheduledJob({
        cron: "0 9 * * *",
        prompt: "One too many",
        recurring: true,
        durable: false,
      });
      expect(overflow).toBeNull();
      expect(listScheduledJobs()).toHaveLength(MAX_SCHEDULED_JOBS);
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
      const registered = mustRegister({
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
      const job = mustRegister({
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
      const job = mustRegister({
        cron: "30 14 25 12 *",
        prompt: "Christmas reminder",
        recurring: false,
        durable: false,
      });

      expect(job.recurring).toBe(false);
    });

    it("should support durable jobs", () => {
      const job = mustRegister({
        cron: "0 9 * * 1-5",
        prompt: "Daily standup",
        recurring: true,
        durable: true,
      });

      expect(job.durable).toBe(true);
    });
  });

  describe("cronMatches", () => {
    // 2026-09-02 is a Wednesday (getDay() === 3)
    const wed = new Date(2026, 8, 2, 10, 30, 0); // local time: Sep 2 2026 10:30

    it("should match a wildcard expression", () => {
      expect(cronMatches(wed, "* * * * *")).toBe(true);
    });

    it("should match exact values", () => {
      expect(cronMatches(wed, "30 10 2 9 3")).toBe(true);
      expect(cronMatches(wed, "31 10 2 9 3")).toBe(false);
    });

    it("should match step expressions", () => {
      expect(cronMatches(wed, "*/15 * * * *")).toBe(true); // 30 % 15 === 0
      expect(cronMatches(wed, "*/7 * * * *")).toBe(false); // 30 % 7 !== 0
      expect(cronMatches(wed, "10-40/10 * * * *")).toBe(true); // 10,20,30,40
      expect(cronMatches(wed, "5-40/10 * * * *")).toBe(false); // 5,15,25,35
    });

    it("should match range expressions", () => {
      expect(cronMatches(wed, "* 9-17 * * *")).toBe(true); // hour 10 in 9-17
      expect(cronMatches(wed, "* 18-23 * * *")).toBe(false);
      expect(cronMatches(wed, "* * * * 1-5")).toBe(true); // Wednesday in Mon-Fri
    });

    it("should match list expressions", () => {
      expect(cronMatches(wed, "15,30,45 * * * *")).toBe(true);
      expect(cronMatches(wed, "15,31,45 * * * *")).toBe(false);
      expect(cronMatches(wed, "* * * * 1,3,5")).toBe(true); // Mon/Wed/Fri
      expect(cronMatches(wed, "* * * * 2,4")).toBe(false);
    });

    it("should treat DOM and DOW as OR when both are restricted", () => {
      // DOM matches (2nd), DOW does not (Thursday 4) → still fires
      expect(cronMatches(wed, "30 10 2 * 4")).toBe(true);
      // DOW matches (Wednesday 3), DOM does not (15th) → still fires
      expect(cronMatches(wed, "30 10 15 * 3")).toBe(true);
      // Neither matches → no fire
      expect(cronMatches(wed, "30 10 15 * 4")).toBe(false);
      // Only DOM restricted → must match DOM (AND with unrestricted DOW)
      expect(cronMatches(wed, "30 10 15 * *")).toBe(false);
      expect(cronMatches(wed, "30 10 2 * *")).toBe(true);
    });

    it("should normalize Sunday 7 to 0", () => {
      const sun = new Date(2026, 8, 6, 0, 0, 0); // Sep 6 2026 is a Sunday
      expect(cronMatches(sun, "0 0 * * 7")).toBe(true);
      expect(cronMatches(sun, "0 0 * * 0")).toBe(true);
    });

    it("should return false for malformed expressions", () => {
      expect(cronMatches(wed, "not a cron")).toBe(false);
      expect(cronMatches(wed, "99 99 99 99 99")).toBe(false);
    });
  });

  describe("collectDueCronJobs", () => {
    it("should collect cron jobs matching the given minute", () => {
      mustRegister({ cron: "30 10 * * *", prompt: "standup", recurring: true, durable: false });
      const due = collectDueCronJobs(new Date(2026, 8, 2, 10, 30, 15));
      expect(due).toHaveLength(1);
      expect(due[0]?.prompt).toContain("standup");
    });

    it("should dedup within the same minute", () => {
      const job = mustRegister({
        cron: "* * * * *",
        prompt: "tick",
        recurring: true,
        durable: false,
      });
      const t0 = new Date(2026, 8, 2, 10, 30, 5);
      const t1 = new Date(2026, 8, 2, 10, 30, 45); // same minute
      expect(collectDueCronJobs(t0)).toHaveLength(1);
      expect(collectDueCronJobs(t1)).toHaveLength(0);
      expect(getScheduledJob(job.id)).toBeDefined(); // recurring job survives
    });

    it("should fire again in the next minute", () => {
      mustRegister({ cron: "* * * * *", prompt: "tick", recurring: true, durable: false });
      expect(collectDueCronJobs(new Date(2026, 8, 2, 10, 30, 5))).toHaveLength(1);
      expect(collectDueCronJobs(new Date(2026, 8, 2, 10, 31, 5))).toHaveLength(1);
    });

    it("should remove one-shot jobs after firing", () => {
      const job = mustRegister({
        cron: "* * * * *",
        prompt: "once",
        recurring: false,
        durable: false,
      });
      expect(collectDueCronJobs(new Date(2026, 8, 2, 10, 30, 5))).toHaveLength(1);
      expect(getScheduledJob(job.id)).toBeUndefined();
      expect(collectDueCronJobs(new Date(2026, 8, 2, 10, 31, 5))).toHaveLength(0);
    });

    it("should fire +N relative delays once the delay has elapsed", () => {
      const job = mustRegister({
        cron: "+60",
        prompt: "wake up",
        recurring: false,
        durable: false,
      });
      const firedAt = new Date(job.createdAtMs + 61_000);
      const due = collectDueCronJobs(firedAt);
      expect(due).toHaveLength(1);
      expect(due[0]?.prompt).toContain("wake up");
      expect(getScheduledJob(job.id)).toBeUndefined(); // always one-shot
    });

    it("should not fire +N delays before the delay elapses", () => {
      const job = mustRegister({
        cron: "+60",
        prompt: "wake up",
        recurring: false,
        durable: false,
      });
      const tooEarly = new Date(job.createdAtMs + 30_000);
      expect(collectDueCronJobs(tooEarly)).toHaveLength(0);
      expect(getScheduledJob(job.id)).toBeDefined();
    });
  });

  describe("durable persistence", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should round-trip durable jobs through scheduled_tasks.json", () => {
      const durable = mustRegister({
        cron: "0 9 * * 1-5",
        prompt: "standup",
        recurring: true,
        durable: true,
      });
      mustRegister({ cron: "0 10 * * *", prompt: "session only", recurring: true, durable: false });

      persistDurableJobs(tmpDir);
      const file = path.join(tmpDir, ".claude", "scheduled_tasks.json");
      expect(fs.existsSync(file)).toBe(true);

      resetScheduledJobs();
      expect(listScheduledJobs()).toHaveLength(0);

      const result = loadDurableJobs(tmpDir);
      expect(result).toEqual({ loaded: 1, skipped: 0 });
      const restored = getScheduledJob(durable.id);
      expect(restored).toBeDefined();
      expect(restored?.cron).toBe("0 9 * * 1-5");
      expect(restored?.prompt).toBe("standup");
      expect(restored?.durable).toBe(true);
      expect(restored?.createdAtMs).toBe(durable.createdAtMs);
    });

    it("should skip invalid records instead of aborting the load", () => {
      const dir = path.join(tmpDir, ".claude");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "scheduled_tasks.json"),
        JSON.stringify({
          version: 1,
          jobs: [
            { id: "good", cron: "0 9 * * *", prompt: "ok", recurring: true, createdAtMs: 1 },
            { id: "bad-cron", cron: "99 99 99 99 99", prompt: "bad", recurring: true },
            { id: "bad-shape", cron: 42 },
          ],
        }),
      );
      const result = loadDurableJobs(tmpDir);
      expect(result).toEqual({ loaded: 1, skipped: 2 });
      expect(getScheduledJob("good")).toBeDefined();
    });

    it("should return zeros when no persistence file exists", () => {
      expect(loadDurableJobs(tmpDir)).toEqual({ loaded: 0, skipped: 0 });
    });
    it("preserves identical saved task ids in different workspaces", () => {
      const second = path.join(tmpDir, "second");
      for (const [root, prompt] of [
        [tmpDir, "A task"],
        [second, "B task"],
      ]) {
        fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
        fs.writeFileSync(
          path.join(root, ".claude", "scheduled_tasks.json"),
          JSON.stringify({
            version: 1,
            jobs: [{ id: "shared-id", cron: "* * * * *", prompt, recurring: true, createdAtMs: 1 }],
          }),
        );
        expect(loadDurableJobs(root).loaded).toBe(1);
      }
      expect(getScheduledJob("shared-id", { workspaceRoot: second })?.prompt).toBe("B task");
      removeScheduledJob("shared-id", { workspaceRoot: tmpDir });
      expect(getScheduledJob("shared-id", { workspaceRoot: second })?.prompt).toBe("B task");
    });
  });
});
