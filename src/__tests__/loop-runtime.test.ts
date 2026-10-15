import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLoopRound,
  currentLoop,
  type LoopScope,
  loopSystemInstruction,
  nextAllowedLoopTime,
  pauseLoop,
  resetLoopsForTests,
  resumeLoop,
  settleLoopRound,
  startLoop,
  stopLoop,
  takeDueLoop,
  updateActiveLoop,
} from "../loop-runtime.js";
import { defaultLoopConfig, loopConfig, persistLoopConfig } from "../loop-settings.js";

let scope: LoopScope;
beforeEach(() => {
  scope = { workspaceRoot: mkdtempSync(join(tmpdir(), "ccr-loop-")), sessionId: "session" };
  mkdirSync(join(scope.workspaceRoot, ".claude"));
  writeFileSync(join(scope.workspaceRoot, ".claude/settings.json"), JSON.stringify({ loop: {} }));
  vi.stubEnv("CCR_USER_CONFIG_DIR", join(scope.workspaceRoot, "user"));
  resetLoopsForTests();
});
afterEach(() => {
  resetLoopsForTests();
  vi.unstubAllEnvs();
  rmSync(scope.workspaceRoot, { recursive: true, force: true });
});
function begin() {
  const prompt = takeDueLoop(scope);
  if (!prompt) throw new Error("loop not due");
  const controller = new AbortController();
  const ticket = beginLoopRound(scope, prompt, controller);
  if (!ticket) throw new Error("loop did not start");
  return { ticket, controller, prompt };
}

describe("managed loop lifecycle", () => {
  it("does not run or mutate a loop leased to another live CLI", () => {
    startLoop(scope, "Owned task");
    const file = join(scope.workspaceRoot, ".claude/loops/session.json");
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.current.ownerInstance = "different-cli-instance";
    value.current.ownerPid = process.pid;
    value.current.leaseAt = Date.now();
    writeFileSync(file, JSON.stringify(value));
    resetLoopsForTests();
    expect(takeDueLoop(scope)).toBeNull();
    expect(() => stopLoop(scope)).toThrow("another active CLI");
    expect(() => startLoop(scope, "New task")).toThrow("another active CLI");
    value.current.leaseAt = Date.now() - 61000;
    writeFileSync(file, JSON.stringify(value));
    expect(currentLoop(scope)?.status).toBe("paused");
    resumeLoop(scope);
    expect(takeDueLoop(scope)).toBeTruthy();
  });
  it("replacing multiline completion settings does not accumulate old commands", () => {
    persistLoopConfig(scope.workspaceRoot, "collaborative", { commands: ["old check"] });
    persistLoopConfig(scope.workspaceRoot, "collaborative", { commands: ["new check"] });
    expect(loopConfig(scope.workspaceRoot, "collaborative").commands).toEqual(["new check"]);
    persistLoopConfig(scope.workspaceRoot, "collaborative", { commands: [] });
    expect(loopConfig(scope.workspaceRoot, "collaborative").commands).toEqual([]);
  });
  it("changes notifications without moving the next execution time", () => {
    const record = startLoop(scope, "Work");
    const next = record.nextRunAt;
    updateActiveLoop(scope, { notifications: "all" });
    expect(record.nextRunAt).toBe(next);
  });
  it("starts exactly one iteration and separates convergence from the final wrap-up", () => {
    const record = startLoop(scope, "Finish the task", { ...defaultLoopConfig(), maxRounds: 3 });
    const first = begin();
    expect(loopSystemInstruction(first.ticket)).toContain("CONVERGENCE ROUND");
    expect(takeDueLoop(scope)).toBeNull();
    settleLoopRound(first.ticket, { complete: false, reason: "More work" });
    expect(takeDueLoop(scope)).toBeNull();
    record.nextRunAt = Date.now();
    const second = begin();
    settleLoopRound(second.ticket, { complete: false, reason: "Ready to verify" });
    record.nextRunAt = Date.now();
    const final = begin();
    expect(loopSystemInstruction(final.ticket)).toContain("FINAL WRAP-UP ROUND");
    settleLoopRound(final.ticket, { complete: false, reason: "A check is still failing" });
    expect(record.status).toBe("paused");
    expect(record.reason).toContain("wrap-up saved");
    expect(takeDueLoop(scope, Date.now() + 86400000)).toBeNull();
  });

  it("stops running work and rejects its late rescheduling result", () => {
    const record = startLoop(scope, "Work");
    const { ticket, controller } = begin();
    stopLoop(scope);
    expect(controller.signal.aborted).toBe(true);
    settleLoopRound(ticket, { complete: false, reason: "Continue" });
    expect(record.status).toBe("stopped");
    expect(takeDueLoop(scope, Date.now() + 86400000)).toBeNull();
  });

  it("a soft pause finishes the current iteration, while resume retains counters", () => {
    const record = startLoop(scope, "Work");
    const { ticket, controller } = begin();
    pauseLoop(scope);
    expect(controller.signal.aborted).toBe(false);
    expect(record.pauseRequested).toBe(true);
    settleLoopRound(ticket, { complete: false, reason: "Progress saved" });
    expect(record.status).toBe("paused");
    resumeLoop(scope);
    expect(record.rounds).toBe(1);
    expect(record.status).toBe("waiting");
    expect(takeDueLoop(scope)).toContain(record.id);
  });

  it("does not discard accumulated usage when increasing limits", () => {
    const record = startLoop(scope, "Work", { ...defaultLoopConfig(), maxRounds: 1 });
    record.inputTokens = 100;
    const { ticket } = begin();
    settleLoopRound(ticket, { complete: false, reason: "Incomplete" });
    expect(() => resumeLoop(scope)).toThrow("Increase the limit");
    updateActiveLoop(scope, { maxRounds: 2 });
    resumeLoop(scope);
    expect(record.inputTokens).toBe(100);
    expect(record.rounds).toBe(1);
  });

  it("keeps scheduled checks continuous without a duration or round ceiling", () => {
    const record = startLoop(scope, "Monitor CI", defaultLoopConfig("scheduled"));
    const { ticket } = begin();
    settleLoopRound(ticket, { complete: true, reason: "Currently healthy" });
    expect(record.config.maxRounds).toBeNull();
    expect(record.status).toBe("waiting");
    expect(record.config).not.toHaveProperty("maxDuration");
  });

  it("replaces only the managed loop and ignores results from the old task", () => {
    startLoop(scope, "Old task");
    const old = begin();
    const next = startLoop(scope, "New task", defaultLoopConfig("conservative"));
    settleLoopRound(old.ticket, { complete: true, reason: "Old success" });
    expect(old.controller.signal.aborted).toBe(true);
    expect(currentLoop(scope)?.id).toBe(next.id);
    expect(next.status).toBe("waiting");
  });

  it("restores a waiting task paused for confirmation, without resetting usage", () => {
    const record = startLoop(scope, "Work");
    const { ticket } = begin();
    record.outputTokens = 25;
    settleLoopRound(ticket, { complete: false, reason: "Continue later" });
    resetLoopsForTests();
    const restored = currentLoop(scope);
    expect(restored?.status).toBe("paused");
    expect(restored?.rounds).toBe(1);
    expect(restored?.outputTokens).toBe(25);
    expect(takeDueLoop(scope)).toBeNull();
  });

  it("automatic recovery skips missed iterations instead of replaying a backlog", () => {
    startLoop(scope, "Monitor", {
      ...defaultLoopConfig("scheduled"),
      recovery: "auto",
      missedRun: "skip",
    });
    const { ticket } = begin();
    settleLoopRound(ticket, { complete: false, reason: "Continue" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600000);
    resetLoopsForTests();
    const restored = currentLoop(scope);
    expect(restored?.status).toBe("waiting");
    expect(restored?.nextRunAt).toBeGreaterThan(Date.now());
    vi.restoreAllMocks();
  });

  it("keeps four profiles independent and clamps intervals to 3-30 minutes", () => {
    persistLoopConfig(scope.workspaceRoot, "collaborative", { intervalMinutes: 7 });
    persistLoopConfig(scope.workspaceRoot, "conservative", { intervalMinutes: 15 });
    expect(loopConfig(scope.workspaceRoot, "collaborative").intervalMinutes).toBe(7);
    expect(loopConfig(scope.workspaceRoot, "conservative").intervalMinutes).toBe(15);
    expect(() =>
      persistLoopConfig(scope.workspaceRoot, "collaborative", { intervalMinutes: 2 }),
    ).toThrow();
    expect(() =>
      persistLoopConfig(scope.workspaceRoot, "collaborative", { intervalMinutes: 31 }),
    ).toThrow();
  });

  it("backs off transient failures within the maximum interval and stops after the retry limit", () => {
    const record = startLoop(scope, "Work", { ...defaultLoopConfig(), retryLimit: 1 });
    const first = begin();
    settleLoopRound(first.ticket, {
      complete: false,
      reason: "Temporary",
      error: "network timeout",
      retryable: true,
    });
    expect(record.status).toBe("waiting");
    expect(record.nextRunAt).toBeGreaterThanOrEqual(Date.now() + 350000);
    record.nextRunAt = Date.now();
    const second = begin();
    settleLoopRound(second.ticket, {
      complete: false,
      reason: "Temporary",
      error: "network timeout",
      retryable: true,
    });
    expect(record.status).toBe("failed");
  });

  it("respects time zones, weekdays and overnight work windows", () => {
    const config = {
      ...defaultLoopConfig("scheduled"),
      timezone: "Asia/Shanghai",
      workHours: true,
      startHour: 9,
      endHour: 18,
      weekdaysOnly: true,
    };
    const fridayEvening = Date.parse("2026-10-09T18:00:00+08:00");
    expect(nextAllowedLoopTime(config, fridayEvening)).toBe(
      Date.parse("2026-10-12T09:00:00+08:00"),
    );
    const overnight = { ...config, weekdaysOnly: false, startHour: 22, endHour: 6 };
    const atNight = Date.parse("2026-10-09T23:00:00+08:00");
    expect(nextAllowedLoopTime(overnight, atNight)).toBe(atNight);
  });

  it("handles retryable and fatal errors on the final wrap-up round instead of masking as paused (F5)", () => {
    const record = startLoop(scope, "Work", {
      ...defaultLoopConfig(),
      maxRounds: 1,
      retryLimit: 1,
    });
    const first = begin();
    expect(first.ticket.final).toBe(true);
    settleLoopRound(first.ticket, {
      complete: false,
      reason: "network timeout",
      error: "network timeout",
      retryable: true,
    });
    expect(record.status).toBe("waiting");
    expect(record.rounds).toBe(0);
    record.nextRunAt = Date.now();
    const second = begin();
    expect(second.ticket.final).toBe(true);
    settleLoopRound(second.ticket, {
      complete: false,
      reason: "network timeout",
      error: "network timeout",
      retryable: true,
    });
    expect(record.status).toBe("failed");
  });
});
