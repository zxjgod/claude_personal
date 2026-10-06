import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLoopBudget } from "../loop-budget.js";
import { withLoopExecution } from "../loop-execution-context.js";
import {
  beginLoopRound,
  type LoopScope,
  resetLoopsForTests,
  startLoop,
  stopLoop,
  takeDueLoop,
} from "../loop-runtime.js";
import { defaultLoopConfig } from "../loop-settings.js";
import type { ModelCaller, ModelConfig } from "../types.js";

let scope: LoopScope;
beforeEach(() => {
  scope = { workspaceRoot: mkdtempSync(join(tmpdir(), "ccr-loop-budget-")), sessionId: "budget" };
  resetLoopsForTests();
});
afterEach(() => {
  resetLoopsForTests();
  rmSync(scope.workspaceRoot, { recursive: true, force: true });
});
const config: ModelConfig = {
  provider: "openai",
  model: "unknown-model",
  apiKey: "test",
  maxTokens: 100,
};
const caller: ModelCaller = async function* () {
  yield { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "stop" };
};
function prepare(partial = {}) {
  const record = startLoop(scope, "Work", { ...defaultLoopConfig(), ...partial });
  const controller = new AbortController();
  const ticket = beginLoopRound(scope, takeDueLoop(scope) ?? "", controller);
  if (!ticket) throw new Error("Missing ticket");
  return { record, ticket, controller };
}

describe("shared loop budgets", () => {
  it("reserves a shared token pool for concurrent model requests", async () => {
    const { record, ticket } = prepare({ tokenBudget: 160 });
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ModelCaller = async function* () {
      await waiting;
      yield { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "stop" };
    };
    const guarded = withLoopBudget(slow);
    const callConfig = { ...config, options: { ccrLoopExecution: ticket } };
    const first = guarded([], [], "", callConfig);
    const pending = first.next();
    expect(record.reservedTokens).toBe(160);
    const second = guarded([], [], "", callConfig);
    await expect(second.next()).rejects.toThrow("Loop budget");
    release();
    await pending;
    await first.return(undefined);
    expect(record.reservedTokens).toBe(0);
  });
  it("accounts descendant callers exactly once and releases reservations", async () => {
    const { record, ticket } = prepare();
    await withLoopExecution(ticket, async () => {
      for await (const _event of withLoopBudget(withLoopBudget(caller))([], [], "test", config)) {
      }
    });
    expect(record.inputTokens).toBe(10);
    expect(record.outputTokens).toBe(5);
    expect(record.reservedTokens).toBe(0);
    expect(record.costKnown).toBe(false);
  });
  it("refuses requests that exceed the remaining token budget", async () => {
    const { ticket } = prepare({ tokenBudget: 1 });
    const actual = vi.fn(caller);
    await expect(
      withLoopExecution(ticket, async () => {
        for await (const _event of withLoopBudget(actual)([], [], "large prompt", config)) {
        }
      }),
    ).rejects.toThrow("Loop budget:");
    expect(actual).not.toHaveBeenCalled();
  });
  it("requires prices before enforcing a USD budget on an unknown model", async () => {
    const { ticket } = prepare({ usdBudget: 1 });
    await expect(
      withLoopExecution(ticket, async () => {
        for await (const _event of withLoopBudget(caller)([], [], "test", config)) {
        }
      }),
    ).rejects.toThrow("requires model prices");
  });
  it("supports explicit third-party prices and accumulates estimated cost", async () => {
    const { record, ticket } = prepare({ usdBudget: 1, inputPrice: 2, outputPrice: 4 });
    await withLoopExecution(ticket, async () => {
      for await (const _event of withLoopBudget(caller)([], [], "test", config)) {
      }
    });
    expect(record.estimatedUsd).toBeCloseTo(0.00004);
  });
  it("rejects stale calls after stopping without making another API request", async () => {
    const { ticket } = prepare();
    stopLoop(scope);
    const actual = vi.fn(caller);
    await expect(
      withLoopExecution(ticket, async () => {
        for await (const _event of withLoopBudget(actual)([], [], "", config)) {
        }
      }),
    ).rejects.toThrow("no longer active");
    expect(actual).not.toHaveBeenCalled();
  });
});
