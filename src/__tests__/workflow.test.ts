// ============================================================
// Tests: Workflow orchestration runtime + DSL
// ------------------------------------------------------------
// The runtime used to evaluate MODEL-WRITTEN JAVASCRIPT in a
// `node:vm` context. That was not a security boundary — a context
// escapes with `this.constructor.constructor("return process")()`,
// which we confirmed reaches the real `process` and therefore every
// credential in the environment. The runtime now interprets a
// DECLARATIVE plan (src/workflow-dsl.ts); nothing is evaluated.
//
// These tests cover the interpreter's semantics, the guard rails that
// replace what the sandbox used to provide, and the invariants that
// were already covered (timeout, abort propagation, concurrency cap).
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { __workerSlots, resetWorkflows, runWorkflow } from "../workflow.js";
import {
  collectText,
  parseWorkflowPlan,
  runWorkflowPlan,
  WorkflowDslError,
} from "../workflow-dsl.js";

const ctx: ToolContext = {
  workspaceRoot: process.cwd(),
  sessionId: "wf-test",
  permissionMode: "default",
};

// A fake worker runner so the orchestration is testable without a live model.
const fakeAgent = async (prompt: string): Promise<string> => `result:${prompt}`;

/** Build a plan object literal for readability in the tests below. */
const plan = (steps: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ steps, ...extra });

afterEach(() => {
  resetWorkflows();
  __workerSlots.reset();
});

describe("runWorkflow", () => {
  it("runs a single agent and returns its result", async () => {
    const record = await runWorkflow(plan([{ agent: "find X" }]), ctx, {
      agentRunner: fakeAgent,
    });
    expect(record.status).toBe("completed");
    expect(record.result).toBe("result:find X");
  });

  it("fans out with parallel and preserves result order", async () => {
    const record = await runWorkflow(
      plan([{ parallel: [{ agent: "a" }, { agent: "b" }, { agent: "c" }] }]),
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("result:a\n\n---\n\nresult:b\n\n---\n\nresult:c");
  });

  it("threads each item through every pipeline stage via {input}", async () => {
    const record = await runWorkflow(
      plan([
        {
          pipeline: {
            items: ["alpha", "beta"],
            stages: ["review {input}", "condense {input}"],
          },
        },
      ]),
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    // Each stage's output feeds the next, per item.
    expect(record.result).toContain("result:condense result:review alpha");
    expect(record.result).toContain("result:condense result:review beta");
  });

  it("captures log/phase lines and records args", async () => {
    const record = await runWorkflow(
      plan([{ phase: "scan" }, { log: "halfway" }], { phase: "overall" }),
      ctx,
      { agentRunner: fakeAgent, args: "hello" },
    );
    expect(record.logs).toContain("[phase] overall");
    expect(record.logs).toContain("[phase] scan");
    expect(record.logs).toContain("halfway");
    expect(record.logs.some((l) => l.includes("hello"))).toBe(true);
  });

  it.each([
    "$&",
    "$$",
    "$`",
    "$'",
    "price $& and literal $$",
  ])("preserves literal pipeline input and reports: %s", async (input) => {
    const prompts: string[] = [];
    const record = await runWorkflow(
      plan([{ pipeline: { items: [input], stages: ["review {input}", "condense {input}"] } }]),
      ctx,
      {
        agentRunner: async (prompt) => {
          prompts.push(prompt);
          return `report:${prompt}`;
        },
      },
    );
    expect(record.status).toBe("completed");
    expect(prompts).toEqual([`review ${input}`, `condense report:review ${input}`]);
    expect(record.result).toBe(`report:condense report:review ${input}`);
  });

  it.each([
    "resolve",
    "reject",
  ])("fails a cancelled final pipeline on worker %s", async (outcome) => {
    const controller = new AbortController();
    const record = await runWorkflow(
      plan([{ pipeline: { items: ["item"], stages: ["review {input}"] } }]),
      { ...ctx, abortSignal: controller.signal },
      {
        agentRunner: async () => {
          controller.abort();
          if (outcome === "reject") throw new Error("worker aborted");
          return "partial report";
        },
      },
    );
    expect(record.status).toBe("failed");
    expect(record.result).toBeUndefined();
    expect(record.logs.some((line) => /aborted/i.test(line))).toBe(true);
  });

  it("preserves per-item failure tolerance when the workflow is not cancelled", async () => {
    const record = await runWorkflow(
      plan([{ pipeline: { items: ["bad", "good"], stages: ["review {input}"] } }]),
      ctx,
      {
        agentRunner: async (prompt) => {
          if (prompt === "review bad") throw new Error("worker failed");
          return "good report";
        },
      },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("[failed at stage 1: worker failed]\n\n---\n\ngood report");
  });

  it("synthesizes a final answer from earlier steps", async () => {
    const record = await runWorkflow(
      plan([
        { parallel: [{ agent: "audit auth" }, { agent: "audit db" }] },
        { synthesize: { from: [0], prompt: "Write the combined security report." } },
      ]),
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    // The synthesize worker receives BOTH reports plus the instruction.
    expect(record.result).toContain("Write the combined security report.");
    expect(record.result).toContain("result:audit auth");
    expect(record.result).toContain("result:audit db");
  });

  it("rejects a malformed plan with a precise message instead of running it", async () => {
    const record = await runWorkflow("{ not json", ctx, { agentRunner: fakeAgent });
    expect(record.status).toBe("failed");
    expect(record.logs.some((l) => /not valid JSON/i.test(l))).toBe(true);
  });

  it("rejects code where a plan is expected", async () => {
    // The old runtime would have happily executed this.
    const record = await runWorkflow(`const a = await agent("x"); return a;`, ctx, {
      agentRunner: fakeAgent,
    });
    expect(record.status).toBe("failed");
    expect(record.logs.some((l) => /not valid JSON/i.test(l))).toBe(true);
  });

  it("wall-clock timeout fails the run and revokes pending agent calls", async () => {
    const neverAgent = (): Promise<string> => new Promise<string>(() => {});
    const record = await runWorkflow(plan([{ agent: "hang" }]), ctx, {
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
      // Intentionally never resolves: the worker hangs until the abort rejects it.
      await new Promise<void>((_resolve, reject) => {
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
      plan([{ agent: "hang" }]),
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
    expect(__workerSlots.active).toBe(0);
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

describe("parseWorkflowPlan validation", () => {
  const bad = (json: string, pattern: RegExp): void => {
    expect(() => parseWorkflowPlan(json)).toThrow(pattern);
  };

  it("rejects a non-string plan", () => {
    expect(() => parseWorkflowPlan({ steps: [] })).toThrow(/must be a JSON string/);
  });

  it("rejects a missing or empty steps array", () => {
    bad("{}", /requires a "steps" array/);
    bad('{"steps":[]}', /must not be empty/);
  });

  it("rejects a step with zero or multiple kind keys", () => {
    bad('{"steps":[{"agent":"a","log":"b"}]}', /exactly one kind key/);
    bad('{"steps":[{}]}', /exactly one kind key/);
  });

  it("allows `label` only on an agent step", () => {
    // `label` is the one permitted modifier; on any other kind it is
    // ambiguous input rather than something to silently ignore.
    expect(parseWorkflowPlan('{"steps":[{"agent":"a","label":"L"}]}').steps).toEqual([
      { agent: "a", label: "L" },
    ]);
    bad('{"steps":[{"log":"x","label":"L"}]}', /only valid on an agent step/);
  });

  it("rejects an unknown step kind", () => {
    bad('{"steps":[{"exec":"rm -rf /"}]}', /unknown step kind "exec"/);
  });

  it("rejects an empty or oversized prompt", () => {
    bad('{"steps":[{"agent":"   "}]}', /must not be empty/);
    bad(`{"steps":[{"agent":"${"x".repeat(9000)}"}]}`, /over the 8000 limit/);
  });

  it("rejects malformed synthesize indexes", () => {
    bad('{"steps":[{"synthesize":{"from":[],"prompt":"p"}}]}', /non-empty array/);
    bad('{"steps":[{"synthesize":{"from":["0"],"prompt":"p"}}]}', /non-negative integers/);
    bad('{"steps":[{"synthesize":{"from":[-1],"prompt":"p"}}]}', /non-negative integers/);
  });

  it("rejects nesting deeper than the depth limit", () => {
    // Build {"parallel":[{"parallel":[...{"agent":"x"}...]}]} 10 levels deep.
    let node: unknown = { agent: "x" };
    for (let i = 0; i < 10; i++) node = { parallel: [node] };
    expect(() => parseWorkflowPlan(JSON.stringify({ steps: [node] }))).toThrow(/nesting deeper/);
  });

  it("rejects a plan with too many steps", () => {
    const steps = Array.from({ length: 100 }, () => ({ agent: "x" }));
    expect(() => parseWorkflowPlan(JSON.stringify({ steps }))).toThrow(/more than 64 steps/);
  });

  it("accepts a well-formed plan", () => {
    const parsed = parseWorkflowPlan(
      plan([
        { phase: "survey" },
        { parallel: [{ agent: "a" }, { pipeline: { items: ["x"], stages: ["do {input}"] } }] },
        { synthesize: { from: [0, 1], prompt: "combine" } },
      ]),
    );
    expect(parsed.steps).toHaveLength(3);
  });
});

describe("DSL escape resistance", () => {
  /**
   * The regression this whole refactor exists for. Under the old vm sandbox
   * each of these reached the real `process`; the interpreter has no code
   * evaluation path at all, so they must fail as DATA errors.
   */
  it("cannot execute JavaScript in a prompt", async () => {
    const escapePayload = `this.constructor.constructor("return process.env")()`;
    const record = await runWorkflow(plan([{ agent: escapePayload }]), ctx, {
      // If anything tried to evaluate, this runner would be reached with the
      // real environment. It only ever receives the literal prompt string.
      agentRunner: async (prompt) => `saw:${prompt}`,
      timeoutMs: 2000,
    });
    expect(record.status).toBe("completed");
    // The payload stayed an inert string; it was never evaluated.
    expect(record.result).toContain(escapePayload);
    expect(record.result).not.toContain("PATH");
  });

  it("rejects a non-string label rather than stringifying it", () => {
    // A malformed modifier must fail loudly; coercing it would hide the
    // model's mistake and hand the host an "[object Object]".
    expect(() => parseWorkflowPlan('{"steps":[{"agent":"x","label":{}}]}')).toThrow(
      /label must be a string/,
    );
  });

  it("does not execute step objects that are not plain data", async () => {
    // Prototype-pollution style key must not become a step kind.
    expect(() => parseWorkflowPlan('{"steps":[{"__proto__":{"agent":"x"}}]}')).toThrow(
      WorkflowDslError,
    );
  });

  it("collectText flattens nested results without invoking anything", () => {
    expect(collectText(["a", ["b", null], "c"])).toBe("a\n\n---\n\nb\n\n---\n\nc");
    expect(collectText(null)).toBe("");
  });
});

describe("runWorkflowPlan abort handling", () => {
  it("rejects cancellation between pipeline stages instead of returning an aborted marker", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const parsed = parseWorkflowPlan(
      plan([{ pipeline: { items: ["item"], stages: ["first {input}", "second {input}"] } }]),
    );
    await expect(
      runWorkflowPlan(parsed, {
        agent: async (prompt) => {
          started.push(prompt);
          controller.abort();
          return "partial report";
        },
        log: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(started).toEqual(["first item"]);
  });

  it("stops before starting the next step once aborted", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const parsed = parseWorkflowPlan(plan([{ agent: "first" }, { agent: "second" }]));
    await expect(
      runWorkflowPlan(parsed, {
        agent: async (prompt) => {
          started.push(prompt);
          controller.abort();
          return "ok";
        },
        log: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(started).toEqual(["first"]);
  });
});
