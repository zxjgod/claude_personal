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
