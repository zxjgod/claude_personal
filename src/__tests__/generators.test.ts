// ============================================================
// Tests: bounded-concurrency generator merge (M29)
// ============================================================

import { describe, expect, it } from "vitest";
import { all, maxToolConcurrency } from "../utils/generators.js";

/** A generator that yields `values` with an optional per-step delay. */
async function* delayed<T>(values: T[], delayMs = 0): AsyncGenerator<T> {
  for (const v of values) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield v;
  }
}

describe("all() (M29)", () => {
  it("yields every value from every generator", async () => {
    const out: number[] = [];
    for await (const v of all([delayed([1, 2]), delayed([3, 4]), delayed([5])])) {
      out.push(v);
    }
    expect(out.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("surfaces values in completion order, not launch order", async () => {
    // gen A is slow, gen B is fast — B's value should appear first.
    const out: string[] = [];
    for await (const v of all([delayed(["slow"], 30), delayed(["fast"], 1)])) {
      out.push(v);
    }
    expect(out[0]).toBe("fast");
    expect(out[1]).toBe("slow");
  });

  it("never runs more than maxConcurrency generators at once", async () => {
    let active = 0;
    let peak = 0;
    const make = () =>
      (async function* () {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        yield 1;
      })();
    const gens = [make(), make(), make(), make(), make()];
    const out: number[] = [];
    for await (const v of all(gens, 2)) out.push(v);
    expect(out).toHaveLength(5);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("handles an empty generator list", async () => {
    const out: number[] = [];
    for await (const v of all<number>([])) out.push(v);
    expect(out).toEqual([]);
  });

  it("drains a multi-value generator fully before finishing", async () => {
    const out: number[] = [];
    for await (const v of all([delayed([1, 2, 3, 4, 5], 1)], 1)) out.push(v);
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("maxToolConcurrency() (M29)", () => {
  const KEY = "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY";
  it("defaults to 10", () => {
    const prev = process.env[KEY];
    delete process.env[KEY];
    expect(maxToolConcurrency()).toBe(10);
    if (prev !== undefined) process.env[KEY] = prev;
  });
  it("honors a valid override", () => {
    const prev = process.env[KEY];
    process.env[KEY] = "3";
    expect(maxToolConcurrency()).toBe(3);
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });
  it("ignores a non-positive / non-integer override", () => {
    const prev = process.env[KEY];
    process.env[KEY] = "0";
    expect(maxToolConcurrency()).toBe(10);
    process.env[KEY] = "abc";
    expect(maxToolConcurrency()).toBe(10);
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });
});
