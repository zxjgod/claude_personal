// ============================================================
// Health Check System Tests
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import { HealthChecker, resetStartTime } from "../utils/health-check.js";
import { ResourceLimiter } from "../utils/resource-limiter.js";

describe("HealthChecker", () => {
  beforeEach(() => {
    ResourceLimiter.resetMetrics();
    resetStartTime();
  });

  describe("check", () => {
    it("should return healthy status with all checks passing", async () => {
      const result = await HealthChecker.check();

      expect(result.status).toBe("healthy");
      expect(result.checks.filesystem).toBe(true);
      expect(result.checks.memory).toBe(true);
      expect(result.checks.tools).toBe(true);
      expect(result.checks.resources).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should include metrics", async () => {
      const result = await HealthChecker.check();

      expect(result.metrics).toHaveProperty("uptime");
      expect(result.metrics).toHaveProperty("totalTools");
      expect(result.metrics).toHaveProperty("failedTools");
      expect(result.metrics).toHaveProperty("memoryUsage");
      expect(result.metrics).toHaveProperty("memoryLimit");
      expect(result.metrics).toHaveProperty("openFiles");
      expect(result.metrics).toHaveProperty("runningTools");

      expect(result.metrics.uptime).toBeGreaterThanOrEqual(0);
      expect(result.metrics.memoryUsage).toBeGreaterThan(0);
    });

    it("should include timestamp", async () => {
      const before = Date.now();
      const result = await HealthChecker.check();
      const after = Date.now();

      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });

    it("should detect high tool failure rate", async () => {
      // Simulate failed tools
      for (let i = 0; i < 10; i++) {
        await ResourceLimiter.acquireToolSlot();
        ResourceLimiter.recordToolFailure();
        ResourceLimiter.releaseToolSlot();
      }

      // Add some successful tools
      for (let i = 0; i < 5; i++) {
        await ResourceLimiter.acquireToolSlot();
        ResourceLimiter.releaseToolSlot();
      }

      const result = await HealthChecker.check();

      expect(result.checks.tools).toBe(false);
      expect(result.status).not.toBe("healthy");
      expect(result.errors.some((e) => e.includes("failure rate"))).toBe(true);
    });

    it("should detect near-limit open files", async () => {
      // Set low limit for testing
      ResourceLimiter.setLimits({ maxOpenFiles: 10 });

      // Open files near limit (95%)
      for (let i = 0; i < 10; i++) {
        ResourceLimiter.trackFileOpen(`/file${i}.txt`);
      }

      const result = await HealthChecker.check();

      expect(result.checks.resources).toBe(false);
      expect(result.errors.some((e) => e.includes("Open files"))).toBe(true);
    });

    it("should be healthy with no tool calls", async () => {
      const result = await HealthChecker.check();

      expect(result.checks.tools).toBe(true);
      expect(result.metrics.totalTools).toBe(0);
    });

    it("should return degraded status with minor issues", async () => {
      // Create a minor issue (elevated tool failures, but not critical)
      for (let i = 0; i < 10; i++) {
        await ResourceLimiter.acquireToolSlot();
        ResourceLimiter.releaseToolSlot();
      }

      // 6% failure rate (elevated but not critical)
      ResourceLimiter.recordToolFailure();

      const result = await HealthChecker.check();

      // Should be degraded due to warning
      expect(result.status).toBe("degraded");
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("getReport", () => {
    it("should generate human-readable report", async () => {
      const report = await HealthChecker.getReport();

      expect(report).toContain("Health Status:");
      expect(report).toContain("Checks:");
      expect(report).toContain("filesystem:");
      expect(report).toContain("memory:");
      expect(report).toContain("tools:");
      expect(report).toContain("resources:");
      expect(report).toContain("Metrics:");
      expect(report).toContain("Uptime:");
      expect(report).toContain("Last check:");
    });

    it("should include status emoji", async () => {
      const report = await HealthChecker.getReport();

      // Check for any of the status emojis (avoiding character class with combining chars)
      const hasEmoji = report.includes("✅") || report.includes("⚠️") || report.includes("❌");
      expect(hasEmoji).toBe(true);
    });

    it("should show issues when present", async () => {
      // Create an issue
      ResourceLimiter.setLimits({ maxOpenFiles: 10 });
      for (let i = 0; i < 10; i++) {
        ResourceLimiter.trackFileOpen(`/file${i}.txt`);
      }

      const report = await HealthChecker.getReport();

      expect(report).toContain("Issues:");
      expect(report).toContain("⚠️");
    });

    it("should format bytes correctly", async () => {
      const report = await HealthChecker.getReport();

      // Should have memory in MB or GB
      expect(report).toMatch(/Memory:.*[MG]B/);
    });

    it("should format uptime correctly", async () => {
      // Wait a bit to get measurable uptime
      await new Promise((resolve) => setTimeout(resolve, 100));

      const report = await HealthChecker.getReport();

      // Should have uptime with time unit
      expect(report).toMatch(/Uptime:.*[smh]/);
    });
  });

  describe("filesystem check", () => {
    it("should pass filesystem check in normal conditions", async () => {
      const result = await HealthChecker.check();

      expect(result.checks.filesystem).toBe(true);
    });
  });

  describe("memory check", () => {
    it("should pass memory check with normal usage", async () => {
      const result = await HealthChecker.check();

      expect(result.checks.memory).toBe(true);
      expect(result.metrics.memoryUsage).toBeGreaterThan(0);
      expect(result.metrics.memoryLimit).toBeGreaterThan(0);
    });
  });

  describe("resources check", () => {
    it("should pass with low resource usage", async () => {
      const result = await HealthChecker.check();

      expect(result.checks.resources).toBe(true);
      expect(result.metrics.openFiles).toBe(0);
    });

    it("should warn about elevated open files", async () => {
      ResourceLimiter.setLimits({ maxOpenFiles: 10 });

      // Open 8 files (80%)
      for (let i = 0; i < 8; i++) {
        ResourceLimiter.trackFileOpen(`/file${i}.txt`);
      }

      const result = await HealthChecker.check();

      expect(result.errors.some((e) => e.includes("Open files elevated"))).toBe(true);
    });
  });
});
