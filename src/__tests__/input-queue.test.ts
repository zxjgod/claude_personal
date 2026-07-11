// ============================================================
// Tests: Input Queue (M36, kernel §9)
// ============================================================

import { describe, expect, it } from "vitest";
import { InputQueue } from "../tui/input-queue.js";

describe("InputQueue", () => {
  it("starts empty", () => {
    const q = new InputQueue();
    expect(q.hasPending).toBe(false);
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it("pushes and drains in FIFO order", () => {
    const q = new InputQueue();
    q.push("first");
    q.push("second");
    expect(q.hasPending).toBe(true);
    expect(q.size).toBe(2);
    expect(q.drain()).toEqual(["first", "second"]);
    // Draining empties the queue.
    expect(q.hasPending).toBe(false);
    expect(q.drain()).toEqual([]);
  });

  it("ignores empty / whitespace-only input", () => {
    const q = new InputQueue();
    q.push("   ");
    q.push("");
    q.push("\n\t");
    expect(q.hasPending).toBe(false);
    q.push("  real  ");
    expect(q.drain()).toEqual(["real"]); // trimmed
  });

  it("clear discards without returning", () => {
    const q = new InputQueue();
    q.push("a");
    q.clear();
    expect(q.hasPending).toBe(false);
  });
});
