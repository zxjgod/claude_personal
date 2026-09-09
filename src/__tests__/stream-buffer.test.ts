// ============================================================
// Tests: StreamBuffer (delta coalescing, M23.6)
// ============================================================
// Uses an injected fake timer so flush cadence is deterministic — no real
// clock. Each "tick()" simulates one flush interval firing.

import { describe, expect, it } from "vitest";
import { StreamBuffer } from "../tui/stream-buffer.js";

/** A controllable interval: tick() fires every registered callback once. */
function fakeTimers() {
  const cbs: Array<() => void> = [];
  return {
    timers: {
      setInterval: (fn: () => void) => {
        cbs.push(fn);
        return cbs.length as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        cbs.length = 0;
      },
    },
    tick: () => {
      for (const fn of [...cbs]) fn();
    },
  };
}

describe("StreamBuffer", () => {
  it("coalesces multiple pushes into one flush per tick", () => {
    const { timers, tick } = fakeTimers();
    const flushes: string[] = [];
    const buf = new StreamBuffer((t) => flushes.push(t), { timers });

    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(flushes).toEqual([]); // nothing emitted until a tick
    tick();
    expect(flushes).toEqual(["abc"]); // one combined emit
  });

  it("emits separate batches across ticks and skips empty ticks", () => {
    const { timers, tick } = fakeTimers();
    const flushes: string[] = [];
    const buf = new StreamBuffer((t) => flushes.push(t), { timers });

    buf.push("one ");
    tick();
    buf.push("two");
    tick();
    tick(); // nothing pending → no emit
    expect(flushes).toEqual(["one ", "two"]);
  });

  it("ignores empty deltas and never starts a clock for them", () => {
    const { timers, tick } = fakeTimers();
    const flushes: string[] = [];
    const buf = new StreamBuffer((t) => flushes.push(t), { timers });

    buf.push("");
    tick();
    expect(flushes).toEqual([]);
    expect(buf.pendingLength).toBe(0);
  });

  it("stop() flushes the remainder and clears the clock", () => {
    const { timers, tick } = fakeTimers();
    const flushes: string[] = [];
    const buf = new StreamBuffer((t) => flushes.push(t), { timers });

    buf.push("tail");
    buf.stop();
    expect(flushes).toEqual(["tail"]); // flushed on stop
    tick(); // clock cleared → no further emits
    expect(flushes).toEqual(["tail"]);
  });

  it("tracks pending length until flushed", () => {
    const { timers, tick } = fakeTimers();
    const buf = new StreamBuffer(() => {}, { timers });
    buf.push("hello");
    expect(buf.pendingLength).toBe(5);
    tick();
    expect(buf.pendingLength).toBe(0);
  });

  it("discard() drops pending text without emitting, keeping the clock alive", () => {
    // S1: at a model_retry boundary the buffered tail of the FAILED attempt
    // must never reach the store; the retry's deltas keep flowing on the same
    // buffer instance.
    const { timers, tick } = fakeTimers();
    const flushes: string[] = [];
    const buf = new StreamBuffer((t) => flushes.push(t), { timers });

    buf.push("doomed");
    buf.discard();
    tick();
    expect(flushes).toEqual([]); // nothing emitted for the discarded attempt
    expect(buf.pendingLength).toBe(0);

    buf.push("retry text");
    tick();
    expect(flushes).toEqual(["retry text"]); // clock survived the discard
  });
});
