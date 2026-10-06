import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopCommand } from "../commands/loop.js";
import type { CommandContext } from "../commands/types.js";
import { currentLoop, pauseLoop, resetLoopsForTests, startLoop } from "../loop-runtime.js";
import { defaultLoopConfig } from "../loop-settings.js";
import {
  cancelWakeup,
  listWakeupJobs,
  resetWakeupJobs,
  scheduleWakeup,
} from "../tools/extended/schedule-wakeup.js";

let root: string;
let ctx: CommandContext;
function output() {
  return vi.mocked(console.log).mock.calls.flat().join("\n");
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccr-loop-command-"));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ loop: {} }));
  vi.stubEnv("CCR_USER_CONFIG_DIR", join(root, "user"));
  ctx = {
    workspaceRoot: root,
    sessionId: "loop-command",
    messages: [],
    modelConfig: { provider: "openai", model: "test", apiKey: "test" },
    callModel: async function* () {},
  };
  resetLoopsForTests();
  resetWakeupJobs();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  resetLoopsForTests();
  resetWakeupJobs();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("managed /loop commands", () => {
  it("starts a task with a runtime-owned iteration instead of a model-owned timer", async () => {
    const result = await loopCommand.run("keep the build green", ctx);
    expect(result?.prompt).toContain("[Managed loop ");
    expect(result?.prompt).toContain("keep the build green");
    expect(currentLoop(ctx)?.status).toBe("waiting");
    expect(listWakeupJobs()).toEqual([]);
  });
  it("supports status, pause and resume without resetting state", async () => {
    await loopCommand.run("work", ctx);
    await loopCommand.run("pause", ctx);
    expect(currentLoop(ctx)?.status).toBe("paused");
    await loopCommand.run("status", ctx);
    expect(output()).toContain("Rounds: 0/10");
    await loopCommand.run("resume", ctx);
    expect(currentLoop(ctx)?.status).toBe("waiting");
  });
  it("stops the managed loop without deleting an unrelated wakeup", async () => {
    await loopCommand.run("work", ctx);
    const unrelated = scheduleWakeup(180, "unrelated", "test", ctx);
    await loopCommand.run("stop", ctx);
    expect(currentLoop(ctx)?.status).toBe("stopped");
    expect(listWakeupJobs()).toHaveLength(1);
    cancelWakeup(unrelated.id);
  });
  it("keeps legacy cancellation available when no managed loop exists", async () => {
    scheduleWakeup(180, "legacy", "test", ctx);
    await loopCommand.run("stop", ctx);
    expect(listWakeupJobs()).toEqual([]);
  });
  it("replaces a previous managed task and retains its history", async () => {
    const previous = startLoop(ctx, "first", defaultLoopConfig("conservative"));
    pauseLoop(ctx);
    await loopCommand.run("second", ctx);
    expect(currentLoop(ctx)?.objective).toBe("second");
    expect(currentLoop(ctx)?.id).not.toBe(previous.id);
    await loopCommand.run("history", ctx);
    expect(output()).toContain("1 previous loop(s)");
  });
  it("bare /loop prints status for the line-based interface", async () => {
    await loopCommand.run("", ctx);
    expect(output()).toContain("No managed loop");
    expect(output()).toContain("/loop pause");
  });
});
