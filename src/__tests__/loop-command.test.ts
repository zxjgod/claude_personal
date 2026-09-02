// ============================================================
// Tests: /loop command — dynamic self-paced loop mode (M41)
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopCommand } from "../commands/loop.js";
import type { CommandContext } from "../commands/types.js";
import {
  listWakeupJobs,
  resetWakeupJobs,
  scheduleWakeup,
} from "../tools/extended/schedule-wakeup.js";

const ctx = {} as CommandContext;

function consoleOutput(): string {
  return (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
}

describe("/loop", () => {
  beforeEach(() => {
    resetWakeupJobs();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetWakeupJobs();
  });

  it("/loop <task> returns a prompt embedding the task and the ScheduleWakeup protocol", async () => {
    const r = await loopCommand.run("keep the build green", ctx);
    expect(r?.prompt).toBeTruthy();
    expect(r?.prompt).toContain("[Loop mode]");
    expect(r?.prompt).toContain("keep the build green");
    expect(r?.prompt).toContain("ScheduleWakeup");
    expect(r?.prompt).toContain("delaySeconds (60-3600)");
  });

  it("/loop stop cancels every pending wakeup and reports the count", async () => {
    scheduleWakeup(120, "Loop iteration: one", "test");
    scheduleWakeup(240, "Loop iteration: two", "test");
    expect(listWakeupJobs()).toHaveLength(2);

    const r = await loopCommand.run("stop", ctx);
    expect(r?.prompt).toBeUndefined();
    expect(listWakeupJobs()).toHaveLength(0);
    expect(consoleOutput()).toContain("cancelled 2 pending wakeup(s)");
  });

  it("bare /loop prints usage and lists pending wakeups", async () => {
    const job = scheduleWakeup(120, "Loop iteration: check CI", "test");
    const r = await loopCommand.run("", ctx);
    expect(r?.prompt).toBeUndefined();
    const out = consoleOutput();
    expect(out).toContain("Usage: /loop <task>");
    expect(out).toContain("/loop stop");
    expect(out).toContain("Pending wakeups (1)");
    expect(out).toContain(job.id);
    expect(out).toContain("Loop iteration: check CI");
  });

  it("bare /loop with no pending wakeups prints usage only", async () => {
    await loopCommand.run("   ", ctx);
    const out = consoleOutput();
    expect(out).toContain("Usage: /loop <task>");
    expect(out).not.toContain("Pending wakeups");
  });
});
