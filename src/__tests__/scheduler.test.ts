// ============================================================
// Tests: Scheduler — the firing loop for cron/sleep/wakeup jobs (M41)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getScheduledJob,
  loadDurableJobs,
  persistDurableJobs,
  registerScheduledJob,
  resetScheduledJobs,
} from "../tools/extended/cron-shared.js";
import {
  cancelAllWakeupJobs,
  listWakeupJobs,
  resetWakeupJobs,
  scheduleWakeup,
} from "../tools/extended/schedule-wakeup.js";
import {
  type ScheduledPrompt,
  type SchedulerHost,
  schedulerTick,
  startScheduler,
} from "../tools/extended/scheduler.js";
import {
  drainNotifications,
  pushTaskNotification,
  resetNotifications,
} from "../tools/notifications.js";

describe("schedulerTick", () => {
  beforeEach(() => {
    resetScheduledJobs();
    resetWakeupJobs();
    resetNotifications();
  });

  it("fires a due '+N' sleep-style job, returns the prompt, and removes the one-shot", () => {
    const job = registerScheduledJob({
      cron: "+1",
      prompt: "wake up now",
      recurring: false,
      durable: false,
    });
    if (!job) throw new Error("registerScheduledJob returned null");

    const prompts = schedulerTick(new Date(Date.now() + 2000));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.jobId).toBe(job.id);
    expect(prompts[0]?.prompt).toContain("[Sleep elapsed");
    expect(prompts[0]?.prompt).toContain("wake up now");
    // One-shot consumed: no longer registered, and a second tick finds nothing.
    expect(getScheduledJob(job.id)).toBeUndefined();
    expect(schedulerTick(new Date(Date.now() + 3000))).toEqual([]);
  });

  it("fires a due wakeup once and removes it (the /loop reschedules itself)", () => {
    scheduleWakeup(0, "Loop iteration: check CI", "test");
    const prompts = schedulerTick(new Date());
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.source).toBe("wakeup");
    expect(prompts[0]?.prompt).toBe("[Scheduled wakeup] Loop iteration: check CI");
    expect(listWakeupJobs()).toHaveLength(0);
  });

  it("does not fire jobs whose delay has not elapsed", () => {
    registerScheduledJob({ cron: "+3600", prompt: "later", recurring: false, durable: false });
    scheduleWakeup(3600, "much later", "test");
    expect(schedulerTick(new Date())).toEqual([]);
    expect(listWakeupJobs()).toHaveLength(1);
  });
});

describe("startScheduler", () => {
  let dir: string;
  let stop: (() => void) | undefined;

  interface FakeHost extends SchedulerHost {
    delivered: string[];
    parkedNotices: ScheduledPrompt[];
    shown: number;
  }

  function makeHost(busyRef: { busy: boolean }): FakeHost {
    const host: FakeHost = {
      sessionId: "sched-test",
      workspaceRoot: dir,
      delivered: [],
      parkedNotices: [],
      shown: 0,
      isBusy: () => busyRef.busy,
      deliver(prompt) {
        host.delivered.push(prompt);
      },
      displayNotifications(items) {
        host.shown += items.length;
      },
      displayParked(p) {
        host.parkedNotices.push(p);
      },
    };
    return host;
  }

  beforeEach(() => {
    resetScheduledJobs();
    resetWakeupJobs();
    resetNotifications();
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-test-"));
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parks due prompts while busy (no delivery, parked notice shown)", () => {
    const busy = { busy: true };
    const host = makeHost(busy);
    registerScheduledJob({
      cron: "+1",
      prompt: "parked one",
      recurring: false,
      durable: false,
      workspaceRoot: dir,
      sessionId: "sched-test",
    });
    stop = startScheduler(host);

    vi.advanceTimersByTime(1100);
    expect(host.delivered).toEqual([]);
    expect(host.parkedNotices).toHaveLength(1);
    expect(host.parkedNotices[0]?.prompt).toContain("parked one");
  });
  it("cancels a due wakeup already parked while the session is busy", () => {
    const busy = { busy: true };
    const host = makeHost(busy);
    scheduleWakeup(0, "cancel this loop", "test", { workspaceRoot: dir, sessionId: "sched-test" });
    stop = startScheduler(host);
    vi.advanceTimersByTime(1100);
    expect(host.parkedNotices).toHaveLength(1);
    expect(cancelAllWakeupJobs()).toBe(1);
    busy.busy = false;
    vi.advanceTimersByTime(1100);
    expect(host.delivered).toEqual([]);
  });

  it("drains the parked buffer FIFO at the busy→idle flip, even with nothing newly due", () => {
    const busy = { busy: true };
    const host = makeHost(busy);
    registerScheduledJob({
      cron: "+1",
      prompt: "first",
      recurring: false,
      durable: false,
      workspaceRoot: dir,
      sessionId: "sched-test",
    });
    registerScheduledJob({
      cron: "+1",
      prompt: "second",
      recurring: false,
      durable: false,
      workspaceRoot: dir,
      sessionId: "sched-test",
    });
    stop = startScheduler(host);

    // Both fall due mid-turn: parked, nothing delivered.
    vi.advanceTimersByTime(1100);
    expect(host.delivered).toEqual([]);
    expect(host.parkedNotices).toHaveLength(2);

    // Idle flip: a bare tick with no new due jobs still drains the buffer in order.
    busy.busy = false;
    vi.advanceTimersByTime(1000);
    expect(host.delivered).toHaveLength(2);
    expect(host.delivered[0]).toContain("first");
    expect(host.delivered[1]).toContain("second");
  });

  it("surfaces unseen notifications via displayNotifications without draining the queue", () => {
    const busy = { busy: false };
    const host = makeHost(busy);
    stop = startScheduler(host);

    pushTaskNotification("sched-test", {
      id: "job-7",
      kind: "bash",
      status: "done",
      summary: "tests finished",
    });
    vi.advanceTimersByTime(1000);
    expect(host.shown).toBe(1);

    // Peek-only: the model-visible copy is still queued for the next delivery point.
    expect(drainNotifications("sched-test")).toHaveLength(1);

    // Already displayed: no repeat on later ticks.
    vi.advanceTimersByTime(3000);
    expect(host.shown).toBe(1);
  });

  it("supports workspaceRoot as a function when persisting after a cron firing", () => {
    const busy = { busy: false };
    const host = makeHost(busy);
    host.workspaceRoot = () => dir; // function form
    // A real cron expression fires with source "cron" → durable file is rewritten.
    const job = registerScheduledJob({
      cron: "* * * * *",
      prompt: "every minute",
      recurring: true,
      durable: true,
    });
    if (!job) throw new Error("registerScheduledJob returned null");
    stop = startScheduler(host);

    vi.advanceTimersByTime(1000);
    expect(host.delivered.some((p) => p.includes("every minute"))).toBe(true);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, ".claude", "scheduled_tasks.json"), "utf8"),
    );
    expect(saved.jobs.some((j: { id: string }) => j.id === job.id)).toBe(true);
  });

  it("stop() ends the loop — no more ticks fire", () => {
    const busy = { busy: false };
    const host = makeHost(busy);
    registerScheduledJob({ cron: "+1", prompt: "never", recurring: false, durable: false });
    stop = startScheduler(host);
    stop();

    vi.advanceTimersByTime(10_000);
    expect(host.delivered).toEqual([]);
    // The due job was never even collected.
    expect(listWakeupJobs()).toHaveLength(0);
  });

  it("displays completions for the resumed session without consuming another session's queue", () => {
    const host = makeHost({ busy: false });
    let sessionId = "original";
    host.sessionId = () => sessionId;
    stop = startScheduler(host);
    sessionId = "resumed";
    for (const id of ["original", "resumed"]) {
      pushTaskNotification(id, { id, kind: "bash", status: "done", summary: id });
    }
    vi.advanceTimersByTime(1000);
    expect(host.shown).toBe(1);
    expect(drainNotifications("resumed")).toHaveLength(1);
    sessionId = "original";
    vi.advanceTimersByTime(1000);
    expect(host.shown).toBe(2);
  });
  it("keeps a parked session-only cron input out of another resumed session", () => {
    const busy = { busy: true };
    const host = makeHost(busy);
    let sessionId = "original";
    host.sessionId = () => sessionId;
    registerScheduledJob({
      cron: "+1",
      prompt: "original session only",
      recurring: false,
      durable: false,
      workspaceRoot: dir,
      sessionId,
    });
    stop = startScheduler(host);
    vi.advanceTimersByTime(1100);
    sessionId = "resumed";
    busy.busy = false;
    vi.advanceTimersByTime(1100);
    expect(host.delivered).toEqual([]);
    sessionId = "original";
    vi.advanceTimersByTime(1100);
    expect(host.delivered).toHaveLength(1);
    expect(host.delivered[0]).toContain("original session only");
  });
  it("leaves another session's not-yet-due wakeup untouched", () => {
    const host = makeHost({ busy: false });
    let sessionId = "original";
    host.sessionId = () => sessionId;
    scheduleWakeup(0, "original wakeup", "test", { workspaceRoot: dir, sessionId });
    stop = startScheduler(host);
    sessionId = "resumed";
    vi.advanceTimersByTime(1100);
    expect(host.delivered).toEqual([]);
    expect(listWakeupJobs()).toHaveLength(1);
    sessionId = "original";
    vi.advanceTimersByTime(1100);
    expect(host.delivered).toHaveLength(1);
  });

  it("does not reload a completed durable relative delay after restart", () => {
    const host = makeHost({ busy: false });
    registerScheduledJob({ cron: "+1", prompt: "once", recurring: false, durable: true });
    persistDurableJobs(dir);
    stop = startScheduler(host);
    vi.advanceTimersByTime(1100);
    expect(host.delivered).toHaveLength(1);
    stop();
    resetScheduledJobs();
    expect(loadDurableJobs(dir).loaded).toBe(0);
  });
  it("does not overwrite another workspace's durable tasks after /cd", () => {
    const other = path.join(dir, "other");
    fs.mkdirSync(path.join(other, ".claude"), { recursive: true });
    const file = path.join(other, ".claude", "scheduled_tasks.json");
    const original = JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "existing-b",
          cron: "* * * * *",
          prompt: "B original",
          recurring: true,
          createdAtMs: Date.now(),
        },
      ],
    });
    fs.writeFileSync(file, original);
    const host = makeHost({ busy: false });
    registerScheduledJob({ cron: "* * * * *", prompt: "A job", recurring: true, durable: true });
    persistDurableJobs(dir);
    host.workspaceRoot = () => other;
    stop = startScheduler(host);
    vi.advanceTimersByTime(1100);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.jobs.map((j: { prompt: string }) => j.prompt)).toEqual(["B original"]);
    expect(host.delivered.some((p) => p.includes("A job"))).toBe(false);
  });
});
