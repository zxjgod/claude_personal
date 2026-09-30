// ============================================================
// Sub-agent concurrency caps
// ------------------------------------------------------------
// Task and Agent each capped their fan-out with a Semaphore. Team did
// NOT: N `send_message` calls in one turn opened N concurrent
// agentLoops straight at the provider. This suite pins the cap and
// the Semaphore.reset() teardown that keeps a module-level singleton
// from stranding slots between test cases.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the factory closure can mutate the counters, and so the mock
// applies to team.ts's static import of createModelCaller (a doMock inside
// the test body would be too late — team.ts is already evaluated).
//
// The mock holds each call open for a tick so overlapping turns are actually
// observable: without a hold, a turn can complete before the next one reaches
// the model and the cap would never be exercised. `hold` is a real timer
// rather than a manual gate — a parked generator that never receives `done`
// keeps its agentLoop suspended, which deadlocks any drain loop that waits on
// the very gates it is trying to open.
const inflight = vi.hoisted(() => ({
  current: 0,
  peak: 0,
  hold: true,
}));

vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () =>
    async function* () {
      inflight.current++;
      inflight.peak = Math.max(inflight.peak, inflight.current);
      if (inflight.hold) await new Promise((r) => setTimeout(r, 25));
      inflight.current--;
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    },
}));

import * as subagents from "../subagents.js";
import {
  createAgents,
  getAgent,
  resetTeams,
  runAgentTurn,
  type TeamRunContext,
  teamConcurrencyLimit,
} from "../team.js";
import { Semaphore } from "../utils/semaphore.js";

describe("Semaphore", () => {
  it("admits up to max, then queues", async () => {
    const sem = new Semaphore(2, "T");
    expect(sem.active).toBe(0);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);

    let queued = false;
    const pending = sem.acquire().then(() => {
      queued = true;
    });
    expect(queued).toBe(false);
    expect(sem.queued).toBe(1);

    sem.release();
    await pending;
    expect(queued).toBe(true);
    sem.reset();
  });

  it("transfers a reservation on release rather than double-counting", async () => {
    const sem = new Semaphore(1, "T");
    await sem.acquire();
    const pending = sem.acquire();
    sem.release();
    await pending;
    // The waiter took over the single slot — still 1, not 2.
    expect(sem.active).toBe(1);
    sem.reset();
  });

  it("tryAcquire never waits", () => {
    const sem = new Semaphore(1, "T");
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.reset();
  });

  it("rejects a waiter whose signal aborts, and frees the queue", async () => {
    const sem = new Semaphore(1, "T");
    await sem.acquire();
    const ac = new AbortController();
    const pending = sem.acquire(ac.signal);
    expect(sem.queued).toBe(1);
    ac.abort();
    await expect(pending).rejects.toThrow(/aborted while waiting/);
    expect(sem.queued).toBe(0);
    sem.reset();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const sem = new Semaphore(1, "T");
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire(ac.signal)).rejects.toThrow(/aborted before acquiring/);
    expect(sem.active).toBe(0);
  });

  it("reset() clears held slots and rejects parked waiters", async () => {
    // The teardown contract: reset must ZERO the count. Draining via
    // release() would hand each slot to the next waiter and leave the
    // semaphore full — the exact leak this method exists to prevent.
    const sem = new Semaphore(2, "T");
    await sem.acquire();
    await sem.acquire();
    const parked = sem.acquire();
    const assertion = expect(parked).rejects.toThrow(/semaphore reset/);
    sem.reset();
    await assertion;
    expect(sem.active).toBe(0);
    expect(sem.queued).toBe(0);
    // Fully usable again afterwards.
    await sem.acquire();
    expect(sem.active).toBe(1);
    sem.reset();
  });
});

describe("team concurrency cap", () => {
  beforeEach(() => {
    inflight.current = 0;
    inflight.peak = 0;
    inflight.hold = true;
    resetTeams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    inflight.hold = false;
    resetTeams();
  });

  const runCtx = (sessionId: string): TeamRunContext => ({
    modelConfig: { provider: "deepseek", model: "deepseek-chat", apiKey: "k" },
    workspaceRoot: process.cwd(),
    sessionId,
    permissionMode: "default",
  });

  it("exposes a finite default and honors TEAM_MAX_CONCURRENCY", () => {
    const limit = teamConcurrencyLimit();
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThan(0);
    // Default is 3, matching Task/Agent; the env override is the documented
    // escape hatch.
    const raw = Number(process.env.TEAM_MAX_CONCURRENCY);
    expect(limit).toBe(Number.isInteger(raw) && raw > 0 ? raw : 3);
  });

  it("caps concurrent member turns and queues the rest", async () => {
    const limit = teamConcurrencyLimit();
    const ids = ["a", "b", "c", "d", "e", "f"];
    createAgents(
      "cap-sess",
      ids.map((name) => ({ role: "general", name })),
    );
    const ctx = runCtx("cap-sess");

    // Six turns against a cap of `limit`. Without the cap every turn would
    // reach the model at once; with it, at most `limit` are ever in flight.
    const results = await Promise.all(ids.map((id) => runAgentTurn(ctx, id, "hi")));

    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(inflight.peak).toBe(limit);
    expect(inflight.current).toBe(0);
  });

  it("frees every slot so a later turn is never starved", async () => {
    // A leaked slot would make later send_message calls queue forever (or,
    // once every slot leaked, hang outright) — the failure mode that makes a
    // concurrency cap worse than no cap at all.
    const limit = teamConcurrencyLimit();
    const ids = Array.from({ length: limit + 2 }, (_, i) => `m${i}`);
    createAgents(
      "stop-sess",
      ids.map((name) => ({ role: "general", name })),
    );
    const ctx = runCtx("stop-sess");

    const results = await Promise.all(ids.map((id) => runAgentTurn(ctx, id, "hi")));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(inflight.current).toBe(0);

    // A second wave must acquire immediately — proving the semaphore drained
    // rather than merely staying under its cap.
    const again = await Promise.all(ids.slice(0, 2).map((id) => runAgentTurn(ctx, id, "again")));
    expect(again.every((r) => r.error === undefined)).toBe(true);
    expect(inflight.peak).toBeLessThanOrEqual(limit);
  });

  it("releases slots and clears scopes when prompt initialization fails", async () => {
    const limit = teamConcurrencyLimit();
    const ids = Array.from({ length: limit }, (_, index) => `broken-${index}`);
    createAgents(
      "setup-error-sess",
      [...ids, "healthy"].map((name) => ({ role: "general", name })),
    );
    const promptBuilder = vi.spyOn(subagents, "buildSubagentSystemPrompt");
    promptBuilder.mockImplementation(() => {
      throw new Error("Prompt initialization failed");
    });
    const ctx = runCtx("setup-error-sess");
    const results = await Promise.all(ids.map((id) => runAgentTurn(ctx, id, "hi")));

    expect(results.every((result) => result.error === "Prompt initialization failed")).toBe(true);
    for (const id of ids) {
      expect(getAgent(ctx.sessionId, id)?.status).toBe("error");
      expect(getAgent(ctx.sessionId, id)?.scope).toBeUndefined();
    }

    promptBuilder.mockRestore();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const result = await runAgentTurn(
        { ...ctx, parentSignal: controller.signal },
        "healthy",
        "hi",
      );
      expect(result.error).toBeUndefined();
      expect(getAgent(ctx.sessionId, "healthy")?.status).toBe("done");
    } finally {
      clearTimeout(timer);
    }
  });
});
