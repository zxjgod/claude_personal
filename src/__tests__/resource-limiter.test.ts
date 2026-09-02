// ============================================================
// Error Scenario Tests - Resource Limiter
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import { ResourceLimiter } from "../utils/resource-limiter.js";

describe("ResourceLimiter", () => {
  beforeEach(() => {
    ResourceLimiter.resetMetrics();
  });

  describe("checkFileSize", () => {
    it("should reject files exceeding max size", () => {
      const result = ResourceLimiter.checkFileSize(20 * 1024 * 1024); // 20MB
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds limit");
    });

    it("should accept files within limit", () => {
      const result = ResourceLimiter.checkFileSize(5 * 1024 * 1024); // 5MB
      expect(result.allowed).toBe(true);
    });
  });

  describe("trackFileOpen/Close", () => {
    it("should track open files", () => {
      const result1 = ResourceLimiter.trackFileOpen("/file1.txt");
      expect(result1.allowed).toBe(true);

      const metrics = ResourceLimiter.getMetrics();
      expect(metrics.openFiles.size).toBe(1);
      expect(metrics.openFiles.has("/file1.txt")).toBe(true);
    });

    it("should reject when max open files reached", () => {
      // Set low limit for testing
      ResourceLimiter.setLimits({ maxOpenFiles: 2 });

      ResourceLimiter.trackFileOpen("/file1.txt");
      ResourceLimiter.trackFileOpen("/file2.txt");

      const result = ResourceLimiter.trackFileOpen("/file3.txt");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Too many open files");
    });

    it("should release file handles on close", () => {
      ResourceLimiter.trackFileOpen("/file1.txt");
      ResourceLimiter.trackFileClose("/file1.txt");

      const metrics = ResourceLimiter.getMetrics();
      expect(metrics.openFiles.size).toBe(0);
    });
  });

  describe("acquireToolSlot/releaseToolSlot", () => {
    it("should track running tools", async () => {
      const result = await ResourceLimiter.acquireToolSlot();
      expect(result.allowed).toBe(true);

      const metrics = ResourceLimiter.getMetrics();
      expect(metrics.runningTools).toBe(1);
      expect(metrics.totalToolCalls).toBe(1);
    });

    it("should reject when max concurrent tools reached", async () => {
      // Set low limit for testing
      ResourceLimiter.setLimits({ maxConcurrentTools: 2 });

      await ResourceLimiter.acquireToolSlot();
      await ResourceLimiter.acquireToolSlot();

      const result = await ResourceLimiter.acquireToolSlot();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Too many concurrent tools");
    });

    it("should release tool slots", async () => {
      await ResourceLimiter.acquireToolSlot();
      ResourceLimiter.releaseToolSlot();

      const metrics = ResourceLimiter.getMetrics();
      expect(metrics.runningTools).toBe(0);
    });

    it("should not go below zero on release", async () => {
      ResourceLimiter.releaseToolSlot();
      ResourceLimiter.releaseToolSlot();

      const metrics = ResourceLimiter.getMetrics();
      expect(metrics.runningTools).toBe(0);
    });
  });

  describe("recordToolFailure", () => {
    it("should track failed tools", () => {
      ResourceLimiter.recordToolFailure();
      ResourceLimiter.recordToolFailure();

      const metrics = ResourceLimiter.getMetrics();
      expect(metrics.failedToolCalls).toBe(2);
    });
  });

  describe("checkMemoryUsage", () => {
    it("should return memory status", () => {
      const result = ResourceLimiter.checkMemoryUsage();

      expect(result).toHaveProperty("withinLimits");
      expect(result).toHaveProperty("usage");
      expect(result).toHaveProperty("limit");
      expect(typeof result.usage).toBe("number");
      expect(result.usage).toBeGreaterThan(0);
    });
  });

  describe("checkContentLength", () => {
    it("should reject content exceeding limit", () => {
      const result = ResourceLimiter.checkContentLength(20 * 1024 * 1024);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds limit");
    });

    it("should accept content within limit", () => {
      const result = ResourceLimiter.checkContentLength(5 * 1024 * 1024);
      expect(result.allowed).toBe(true);
    });
  });

  describe("getSummary", () => {
    it("should return complete summary", async () => {
      await ResourceLimiter.acquireToolSlot();
      ResourceLimiter.trackFileOpen("/file.txt");
      ResourceLimiter.recordToolFailure();

      // Wait a bit to ensure non-zero uptime
      await new Promise((resolve) => setTimeout(resolve, 10));

      const summary = ResourceLimiter.getSummary();

      expect(summary.memory).toHaveProperty("withinLimits");
      expect(summary.tools.running).toBe(1);
      expect(summary.tools.total).toBe(1);
      expect(summary.tools.failed).toBe(1);
      expect(summary.files.open).toBe(1);
      expect(summary.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("createTimeout", () => {
    it("should create timeout promise", () => {
      const { promise, clear } = ResourceLimiter.createTimeout(100);

      expect(promise).toBeInstanceOf(Promise);
      expect(typeof clear).toBe("function");

      clear(); // Clean up
    });

    it("should reject after timeout", async () => {
      const { promise } = ResourceLimiter.createTimeout(10);

      await expect(promise).rejects.toThrow("Tool execution timeout");
    });

    it("should be clearable", async () => {
      const { clear } = ResourceLimiter.createTimeout(10);

      clear();

      // Should not reject after clear
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });

  describe("setLimits/getLimits", () => {
    it("should update limits", () => {
      ResourceLimiter.setLimits({ maxConcurrentTools: 5 });

      const limits = ResourceLimiter.getLimits();
      expect(limits.maxConcurrentTools).toBe(5);
    });

    it("should preserve other limits", () => {
      const originalLimits = ResourceLimiter.getLimits();
      ResourceLimiter.setLimits({ maxConcurrentTools: 5 });

      const limits = ResourceLimiter.getLimits();
      expect(limits.maxFileSize).toBe(originalLimits.maxFileSize);
    });
  });
});
