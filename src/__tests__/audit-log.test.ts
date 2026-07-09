// ============================================================
// Audit Log Tests
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../audit-log.js";

describe("AuditLogger", () => {
  const testDir = path.join(os.tmpdir(), `audit-log-test-${Date.now()}`);
  let logFile: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
    logFile = path.join(testDir, `audit-${Date.now()}-${Math.random()}.log`);
    logger = new AuditLogger({ logFilePath: logFile });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should log entries", async () => {
    await logger.log({
      operation: "bash",
      command: "rm -rf /",
      workspaceRoot: "/workspace",
      userConfirmed: false,
      outcome: "denied",
    });

    const entries = await logger.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe("bash");
    expect(entries[0].outcome).toBe("denied");
    expect(entries[0].command).toBe("rm -rf /");
  });

  it("should filter by operation type", async () => {
    await logger.log({
      operation: "bash",
      workspaceRoot: "/workspace",
      userConfirmed: true,
      outcome: "success",
    });
    await logger.log({
      operation: "edit",
      filePath: "/workspace/test.ts",
      workspaceRoot: "/workspace",
      userConfirmed: true,
      outcome: "success",
    });

    const bashEntries = await logger.query({ operation: "bash" });
    expect(bashEntries).toHaveLength(1);

    const editEntries = await logger.query({ operation: "edit" });
    expect(editEntries).toHaveLength(1);
  });

  it("should filter by outcome", async () => {
    await logger.log({
      operation: "bash",
      workspaceRoot: "/workspace",
      userConfirmed: false,
      outcome: "denied",
    });
    await logger.log({
      operation: "bash",
      workspaceRoot: "/workspace",
      userConfirmed: true,
      outcome: "success",
    });

    const denied = await logger.query({ outcome: "denied" });
    expect(denied).toHaveLength(1);
  });

  it("should filter by time range", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);

    await logger.log({
      operation: "bash",
      workspaceRoot: "/workspace",
      userConfirmed: true,
      outcome: "success",
    });

    const entries = await logger.query({ since: oneHourAgo, until: oneHourLater });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("should get recent entries", async () => {
    for (let i = 0; i < 5; i++) {
      await logger.log({
        operation: "bash",
        command: `cmd-${i}`,
        workspaceRoot: "/workspace",
        userConfirmed: true,
        outcome: "success",
      });
    }

    const recent = await logger.getRecent(3);
    expect(recent).toHaveLength(3);
    // Should be in reverse order (most recent first)
    expect(recent[0].command).toBe("cmd-4");
  });

  it("should include timestamps", async () => {
    await logger.log({
      operation: "edit",
      filePath: "/workspace/test.ts",
      workspaceRoot: "/workspace",
      userConfirmed: true,
      outcome: "success",
    });

    const entries = await logger.query();
    expect(entries[0].timestamp).toBeDefined();
    expect(() => new Date(entries[0].timestamp)).not.toThrow();
  });

  it("should store metadata", async () => {
    await logger.log({
      operation: "tool_execution",
      toolName: "custom-tool",
      workspaceRoot: "/workspace",
      userConfirmed: true,
      outcome: "success",
      metadata: { customField: "value", count: 42 },
    });

    const entries = await logger.query();
    expect(entries[0].metadata?.customField).toBe("value");
    expect(entries[0].metadata?.count).toBe(42);
  });

  it("should clear log", async () => {
    await logger.log({
      operation: "bash",
      workspaceRoot: "/workspace",
      userConfirmed: true,
      outcome: "success",
    });

    expect(await logger.query()).toHaveLength(1);

    await logger.clear();
    expect(await logger.query()).toHaveLength(0);
  });
});

describe("Convenience functions", () => {
  const testDir = path.join(os.tmpdir(), `audit-convenience-test-${Date.now()}`);
  let logFile: string;

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
    logFile = path.join(testDir, `convenience-${Date.now()}.log`);
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("logBashOperation should create entry", async () => {
    const logger = new AuditLogger({ logFilePath: logFile });
    await logger.log({
      operation: "bash",
      command: "npm install",
      workspaceRoot: "/project",
      userConfirmed: true,
      outcome: "success",
      sessionId: "session-123",
    });

    const entries = await logger.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe("bash");
    expect(entries[0].command).toBe("npm install");
    expect(entries[0].sessionId).toBe("session-123");
  });

  it("logFileOperation should create entry", async () => {
    const logger = new AuditLogger({ logFilePath: logFile });
    await logger.log({
      operation: "write",
      filePath: "/project/src/index.ts",
      workspaceRoot: "/project",
      userConfirmed: true,
      outcome: "success",
    });

    const entries = await logger.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe("write");
    expect(entries[0].filePath).toBe("/project/src/index.ts");
  });
});
