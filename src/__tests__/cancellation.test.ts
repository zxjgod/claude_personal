// ============================================================
// Tests: Cancellation Tree (M35)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  CancellationScope,
  cancelReason,
  interpretCancelReason,
  isInterrupt,
} from "../utils/cancellation.js";

describe("interpretCancelReason", () => {
  it("reads a structured interrupt reason", () => {
    expect(interpretCancelReason(cancelReason("interrupt", "new msg"))).toEqual({
      kind: "interrupt",
      message: "new msg",
    });
  });

  it("treats a plain string reason as a hard cancel, keeping the message", () => {
    expect(interpretCancelReason("stopped by task_stop")).toEqual({
      kind: "hard",
      message: "stopped by task_stop",
    });
  });

  it("treats an undefined reason as a hard cancel", () => {
    expect(interpretCancelReason(undefined)).toEqual({ kind: "hard" });
  });
});

describe("CancellationScope", () => {
  it("cascades a parent abort to a child scope with the same reason", () => {
    const root = new CancellationScope();
    const child = root.fork();
    expect(child.aborted).toBe(false);
    root.cancel("interrupt", "ctrl-c");
    expect(child.aborted).toBe(true);
    expect(isInterrupt(child.signal)).toBe(true);
  });

  it("cascades through multiple levels", () => {
    const root = new CancellationScope();
    const child = root.fork();
    const grandchild = child.fork();
    root.cancel();
    expect(grandchild.aborted).toBe(true);
  });

  it("a child created from an already-aborted parent is born aborted", () => {
    const root = new CancellationScope();
    root.cancel("hard", "already gone");
    const child = root.fork();
    expect(child.aborted).toBe(true);
    expect(interpretCancelReason(child.signal.reason).message).toBe("already gone");
  });

  it("cancelChildren aborts children but not the parent (sibling cancel)", () => {
    const root = new CancellationScope();
    const a = root.fork();
    const b = root.fork();
    root.cancelChildren("hard", "siblings down");
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
    expect(root.aborted).toBe(false);
  });

  it("links to a raw parent AbortSignal", () => {
    const parent = new AbortController();
    const scope = new CancellationScope(parent.signal);
    parent.abort(cancelReason("interrupt"));
    expect(scope.aborted).toBe(true);
    expect(isInterrupt(scope.signal)).toBe(true);
  });

  it("cancel is idempotent (does not overwrite the first reason)", () => {
    const root = new CancellationScope();
    root.cancel("interrupt", "first");
    root.cancel("hard", "second");
    expect(interpretCancelReason(root.signal.reason)).toEqual({
      kind: "interrupt",
      message: "first",
    });
  });
});

// ============================================================
// createStallController (review follow-up #3)
// ============================================================
// The stream watchdog both adapters now use: fires only after stallMs with NO
// activity (touch rearms), so a slow-but-progressing long turn is never
// killed — the old wall-clock combineAbortSignals cap died at 5:00 sharp on
// 128K-output generations.
// ============================================================

import { createStallController } from "../utils/cancellation.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createStallController (#3)", () => {
  it("fires after the stall window with no activity", async () => {
    const c = createStallController(undefined, 40);
    await sleep(120);
    expect(c.signal.aborted).toBe(true);
    expect((c.signal.reason as Error).message).toBe("Request timed out");
    c.cleanup();
  });

  it("touch() rearms — steady activity never aborts", async () => {
    const c = createStallController(undefined, 80);
    for (let i = 0; i < 8; i++) {
      await sleep(25);
      c.touch();
    }
    // ~200ms elapsed — twice the stall window — but every 25ms touch rearmed.
    expect(c.signal.aborted).toBe(false);
    // Going silent for longer than the window fires it.
    await sleep(140);
    expect(c.signal.aborted).toBe(true);
    c.cleanup();
  });

  it("propagates a parent abort with its reason", async () => {
    const parent = new AbortController();
    const c = createStallController(parent.signal, 5_000);
    parent.abort(cancelReason("interrupt", "user"));
    expect(c.signal.aborted).toBe(true);
    expect(interpretCancelReason(c.signal.reason)).toEqual({
      kind: "interrupt",
      message: "user",
    });
    c.cleanup();
  });

  it("an already-aborted parent aborts immediately", () => {
    const parent = new AbortController();
    parent.abort("gone");
    const c = createStallController(parent.signal, 5_000);
    expect(c.signal.aborted).toBe(true);
    c.cleanup();
  });

  it("cleanup disarms the stall timer", async () => {
    const c = createStallController(undefined, 40);
    c.cleanup();
    await sleep(100);
    expect(c.signal.aborted).toBe(false);
  });

  it("touch after abort is a no-op (no re-armed timers)", async () => {
    const c = createStallController(undefined, 30);
    await sleep(80);
    expect(c.signal.aborted).toBe(true);
    c.touch(); // must not throw or re-arm
    expect(c.signal.aborted).toBe(true);
    c.cleanup();
  });
});
