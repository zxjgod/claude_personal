// ============================================================
// Tests: Workflow orchestration runtime (Phase 3)
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { __workerSlots, resetWorkflows, runWorkflow } from "../workflow.js";

const ctx: ToolContext = {
  workspaceRoot: process.cwd(),
  sessionId: "wf-test",
  permissionMode: "default",
};

// A fake worker runner so the orchestration is testable without a live model.
const fakeAgent = async (prompt: string): Promise<string> => `result:${prompt}`;

afterEach(() => {
  resetWorkflows();
});

describe("runWorkflow", () => {
  it("runs a single agent and returns its result", async () => {
    const record = await runWorkflow(
      `const a = await agent("find X");
       return a;`,
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("result:find X");
  });

  it("runs agents in parallel via parallel()", async () => {
    const record = await runWorkflow(
      `const r = await parallel([
         () => agent("a"),
         () => agent("b"),
         () => agent("c"),
       ]);
       return r.join(",");`,
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("result:a,result:b,result:c");
  });

  it("pipes items through pipeline stages", async () => {
    const record = await runWorkflow(
      `const r = await pipeline(["a","b"], (x) => agent("stage1:" + x));
       return r.length;`,
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("2");
  });

  it("captures log/phase lines and args", async () => {
    const record = await runWorkflow(
      `phase("scan");
       log("args = " + args);
       return "done";`,
      ctx,
      { agentRunner: fakeAgent, args: "hello" },
    );
    expect(record.logs).toContain("[phase] scan");
    expect(record.logs).toContain("args = hello");
    expect(record.result).toBe("done");
  });

  it("marks a throwing script as failed", async () => {
    const record = await runWorkflow(`throw new Error("boom")`, ctx, {
      agentRunner: fakeAgent,
    });
    expect(record.status).toBe("failed");
    expect(record.logs.some((l) => l.includes("boom"))).toBe(true);
  });

  it("a synchronous infinite loop fails instead of freezing the process", async () => {
    // Regression: vm.runInContext previously ran WITHOUT its timeout option,
    // so a bare `while (true) {}` blocked the event loop forever and the
    // Promise.race timeout never got a chance to fire.
    const record = await runWorkflow(`while (true) {}`, ctx, {
      agentRunner: fakeAgent,
      timeoutMs: 500,
    });
    expect(record.status).toBe("failed");
    expect(record.logs.some((l) => /timed out/i.test(l))).toBe(true);
  });

  it("terminates a synchronous infinite loop after an await", async () => {
    const started = Date.now();
    const record = await runWorkflow("await Promise.resolve(); while (true) {}", ctx, {
      agentRunner: fakeAgent,
      timeoutMs: 100,
    });
    expect(record.status).toBe("failed");
    expect(record.logs.some((l) => /timed out/i.test(l))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("wall-clock timeout fails the run and revokes pending agent calls", async () => {
    const neverAgent = (): Promise<string> => new Promise<string>(() => {});
    const record = await runWorkflow(`return await agent("hang")`, ctx, {
      agentRunner: neverAgent,
      timeoutMs: 100,
    });
    expect(record.status).toBe("failed");
    expect(record.result).toBeUndefined();
    expect(record.logs.some((l) => /timed out/i.test(l))).toBe(true);
  });

  it("aborts an active worker when the workflow times out", async () => {
    let aborted = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blockingAgent = async (
      _prompt: string,
      _context: ToolContext,
      signal?: AbortSignal,
    ): Promise<string> => {
      markStarted();
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
        if (signal?.aborted) reject(new Error("aborted"));
      });
      return "unreachable";
    };
    const controller = new AbortController();
    const run = runWorkflow(
      `return await agent("hang")`,
      { ...ctx, abortSignal: controller.signal },
      {
        agentRunner: blockingAgent,
        timeoutMs: 10_000,
      },
    );
    await started;
    controller.abort();
    const record = await run;
    expect(record.status).toBe("failed");
    expect(aborted).toBe(true);
  });

  it("never exceeds the worker concurrency cap", async () => {
    // Regression for the semaphore race: release() used to hand a slot to a
    // waiter AND let a newcomer take it too, overshooting the cap. The
    // semaphore lives inside runWorkerAgent (agentRunner injection bypasses
    // it), so exercise the slot primitives directly.
    const { acquire, release, max } = __workerSlots;
    let active = 0;
    let maxActive = 0;
    const worker = async (): Promise<void> => {
      await acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 12 }, () => worker()));
    expect(maxActive).toBeLessThanOrEqual(max);
    expect(maxActive).toBeGreaterThan(1); // sanity: work actually overlapped
  });

  it("removes an aborted waiter from the worker queue", async () => {
    const { acquire, release, max } = __workerSlots;
    await Promise.all(Array.from({ length: max }, () => acquire()));
    const controller = new AbortController();
    const waiting = acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/i);
    for (let i = 0; i < max; i++) release();
    await acquire();
    release();
  });
});
