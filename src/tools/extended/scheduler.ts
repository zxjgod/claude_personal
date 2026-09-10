// ============================================================
// Scheduler — the firing loop for cron jobs, sleeps and wakeups (M41)
// ============================================================
// Owns the 1-second tick that turns registered schedules into delivered
// prompts:
//   1. cron jobs / relative "+N" sleeps fire via collectDueCronJobs()
//      (minute dedup + one-shot removal live there);
//   2. ScheduleWakeup jobs (the /loop dynamic mode) fire once their delay
//      elapsed and are removed (each wakeup reschedules itself);
//   3. unseen background-task notifications are surfaced to the user.
//
// Delivery policy: prompts fire ONLY while the REPL is idle. When a schedule
// falls due mid-turn, it is parked in a pending buffer and delivered at the
// busy→idle transition, in order. Hosts (line REPL, raw REPL, TUI) provide
// `deliver` (synthetic user input) and `displayNotifications` (idle UI line).
// ============================================================

import { type TaskNotificationInput, takeUnseenForDisplay } from "../notifications.js";
import { collectDueCronJobs, persistDurableJobs } from "./cron-shared.js";
import { cancelWakeup, listWakeupJobs } from "./schedule-wakeup.js";

export interface ScheduledPrompt {
  source: "cron" | "wakeup";
  jobId: string;
  /** Full text to inject as synthetic user input. */
  prompt: string;
  /** Short human label for the "queued while busy" notice. */
  label: string;
}

export interface SchedulerHost {
  /** Session whose background completions are surfaced in the idle UI. */
  sessionId: string | (() => string);
  /** Workspace containing .claude/scheduled_tasks.json. */
  workspaceRoot: string | (() => string);
  /** True while an agent turn is in progress (delivery is deferred). */
  isBusy(): boolean;
  /** Deliver a scheduled prompt as synthetic user input (REPL is idle). */
  deliver(prompt: string): void;
  /** Surface a background completion to the user (idle UI line). */
  displayNotifications(items: TaskNotificationInput[]): void;
  /** Surface a "parked until idle" notice. Optional (no-op default). */
  displayParked?(prompt: ScheduledPrompt): void;
}

/**
 * One scheduler pass, exported for tests. Fires due schedules and returns
 * the prompts to deliver now. Mutates the cron/wakeup registries (marks
 * fired, removes one-shots) exactly like the live loop does.
 */
export function schedulerTick(now: Date): ScheduledPrompt[] {
  const prompts: ScheduledPrompt[] = [];
  for (const { job, prompt } of collectDueCronJobs(now)) {
    prompts.push({
      source: job.cron.startsWith("+") ? "wakeup" : "cron",
      jobId: job.id,
      prompt,
      label: `定时任务 ${job.id} 触发`,
    });
  }
  // Wakeups: due when the hrtime delay elapsed; fire once and remove — the
  // /loop protocol is that the agent reschedules the next iteration itself.
  const nowHr = process.hrtime.bigint();
  for (const job of listWakeupJobs()) {
    if (nowHr >= job.fireAt) {
      cancelWakeup(job.id);
      prompts.push({
        source: "wakeup",
        jobId: job.id,
        prompt: `[Scheduled wakeup] ${job.prompt}`,
        label: `唤醒任务触发`,
      });
    }
  }
  return prompts;
}

/**
 * Start the scheduler loop. Returns a stop() function (clears the interval).
 * The interval is unref'd so it never keeps the process alive on its own.
 */
export function startScheduler(host: SchedulerHost): () => void {
  let stopped = false;
  /** Schedules that fell due mid-turn, delivered at the busy→idle flip. */
  const parked: string[] = [];
  const timer = setInterval(() => {
    if (stopped) return;
    // Surface background completions to the user first (peek-only; the model
    // still receives the queued copy at the next delivery point).
    const sessionId = typeof host.sessionId === "function" ? host.sessionId() : host.sessionId;
    const unseen = takeUnseenForDisplay(sessionId);
    if (unseen.length > 0) host.displayNotifications(unseen);

    const prompts = schedulerTick(new Date());
    // collectDueCronJobs removes one-shot durable entries as they fire. Rewrite
    // the durable file after every firing pass so a consumed one-shot never
    // resurrects on restart. Recurring entries are emitted unchanged.
    if (prompts.length > 0) {
      const root =
        typeof host.workspaceRoot === "function" ? host.workspaceRoot() : host.workspaceRoot;
      persistDurableJobs(root);
    }

    if (host.isBusy()) {
      for (const p of prompts) {
        parked.push(p.prompt);
        host.displayParked?.(p);
      }
      return;
    }
    // Idle: deliver parked schedules first (FIFO), even on a tick where no new
    // schedule became due. This is what closes the busy→idle delivery edge.
    while (parked.length > 0) host.deliver(parked.shift()!);
    for (const p of prompts) host.deliver(p.prompt);
  }, 1000);
  // Hygiene: the timer must not hold the event loop open at shutdown.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
