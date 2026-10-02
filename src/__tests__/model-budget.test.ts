import { expect, it } from "vitest";
import { type ModelBudget, withModelBudget } from "../model-budget.js";
import type { ModelCaller } from "../types.js";

it("reserves shared budget across concurrent callers and reconciles actual usage", async () => {
  const budget: ModelBudget = { limit: 0.005, spent: 0, reserved: 0 };
  const config = {
    provider: "openai" as const,
    model: "gpt-4o",
    apiKey: "unused",
    options: { ccrBudget: budget },
  };
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const caller: ModelCaller = async function* () {
    await wait;
    yield { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "stop" };
  };
  const guarded = withModelBudget(caller);
  const iterator = guarded([], [], "", config);
  const first = iterator.next();
  expect(budget.reserved).toBeGreaterThan(0);
  const second = guarded([], [], "", config);
  await expect(second.next()).rejects.toThrow("budget");
  release();
  await first;
  // The yielded usage event is charged; closing the generator releases the reservation.
  expect(budget.spent).toBeGreaterThan(0);
  await iterator.return(undefined);
  expect(budget.reserved).toBe(0);
});
it("does not charge an already-budgeted underlying caller twice", async () => {
  const budget: ModelBudget = { limit: 1, spent: 0, reserved: 0 };
  const caller: ModelCaller = async function* () {
    yield { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "stop" };
  };
  for await (const _event of withModelBudget(withModelBudget(caller))([], [], "", {
    provider: "openai",
    model: "gpt-4o",
    apiKey: "unused",
    options: { ccrBudget: budget },
  })) {
    /* drain */
  }
  expect(budget.reserved).toBe(0);
  expect(budget.spent).toBeLessThan(0.001);
});
