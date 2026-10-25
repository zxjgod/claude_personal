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

  it("appends only new entries (no O(N²) duplicate lines)", async () => {
    // Regression: persist() used to re-append the ENTIRE in-memory array on
    // every log(), so N entries produced ~N²/2 lines on disk.
    const logger = new AuditLogger({ logFilePath: logFile });
    for (let i = 0; i < 5; i++) {
      await logger.log({
        operation: "bash",
        command: `cmd-${i}`,
        workspaceRoot: "/workspace",
        userConfirmed: false,
        outcome: "success",
      });
    }

    const content = await fs.promises.readFile(logFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    const commands = lines.map((l) => JSON.parse(l).command);
    expect(commands).toEqual(["cmd-0", "cmd-1", "cmd-2", "cmd-3", "cmd-4"]);
  });

  it("rewrites the file wholesale after maxEntries trim (no stale lines)", async () => {
    const small = new AuditLogger({ logFilePath: logFile, maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      await small.log({
        operation: "bash",
        command: `cmd-${i}`,
        workspaceRoot: "/workspace",
        userConfirmed: false,
        outcome: "success",
      });
    }

    const content = await fs.promises.readFile(logFile, "utf-8");
    const commands = content
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).command);
    expect(commands).toEqual(["cmd-2", "cmd-3", "cmd-4"]);

    // Logging after the trim must keep the sliding window consistent.
    await small.log({
      operation: "bash",
      command: "cmd-5",
      workspaceRoot: "/workspace",
      userConfirmed: false,
      outcome: "success",
    });
    const after = (await fs.promises.readFile(logFile, "utf-8")).split("\n").filter(Boolean);
    expect(after.map((l) => JSON.parse(l).command)).toEqual(["cmd-3", "cmd-4", "cmd-5"]);
  });

  it("a fresh logger recovers all previously persisted entries", async () => {
    const logger = new AuditLogger({ logFilePath: logFile });
    await logger.log({
      operation: "bash",
      command: "first",
      workspaceRoot: "/workspace",
      userConfirmed: false,
      outcome: "success",
    });
    const reloaded = new AuditLogger({ logFilePath: logFile });
    const entries = await reloaded.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe("first");
  });
});

describe("AuditLogger — concurrent persistence boundaries (self-review fix)", () => {
  let dir: string;
  let logFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-audit-conc-"));
    logFile = path.join(dir, "audit.log");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Hold the FIRST matching write until `open()`, so a second log() can land
   * while the first persist is still awaiting its write. `hit` resolves when
   * the gated write has been reached (the gated append is also the write that
   * CREATES the file, so existence polling cannot detect it).
   */
  function gateWrites(trigger: (options: { flag?: string }) => boolean) {
    const original = fs.promises.writeFile.bind(fs.promises);
    let release!: () => void;
    let hitResolve!: () => void;
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hit = new Promise<void>((resolve) => {
      hitResolve = resolve;
    });
    let gateArmed = true;
    fs.promises.writeFile = (async (...args: Parameters<typeof fs.promises.writeFile>) => {
      const options = args[2] as { flag?: string } | undefined;
      if (gateArmed && trigger(options ?? {})) {
        gateArmed = false;
        hitResolve();
        await gated;
      }
      return original(...args);
    }) as typeof fs.promises.writeFile;
    return {
      hit,
      open: () => release(),
      restore: () => {
        fs.promises.writeFile = original;
      },
    };
  }

  const entry = (command: string) => ({
    operation: "bash" as const,
    command,
    workspaceRoot: "/workspace",
    userConfirmed: false,
    outcome: "success" as const,
  });

  it("an entry logged during an APPEND is still persisted afterwards", async () => {
    const gate = gateWrites((options) => options.flag === "a");
    const logger = new AuditLogger({ logFilePath: logFile });
    const first = logger.log(entry("A"));
    await gate.hit; // A's append write is now held mid-persist
    const second = logger.log(entry("B")); // lands while A's write is in flight
    gate.open();
    await Promise.all([first, second]);
    gate.restore();
    // The first cut re-read entries.length after the await: B was counted as
    // persisted, its own persist computed an empty delta, and only "A" ever
    // reached the disk (probe-verified against the old code).
    const onDisk = (await fs.promises.readFile(logFile, "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).command);
    expect(onDisk).toEqual(["A", "B"]);
    expect((await new AuditLogger({ logFilePath: logFile }).query()).map((e) => e.command)).toEqual(
      ["A", "B"],
    );
  });
});
