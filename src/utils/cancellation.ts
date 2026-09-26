// ============================================================
// Cancellation Tree (M35, kernel §9 / §3)
// ============================================================
// A single AbortController tree threaded through the agent system. A parent
// scope's signal cascades to every descendant, so one Ctrl+C at the top aborts
// the whole subtree — including sub-agents, which previously kept running after
// a parent abort because the Task tool spawned them with no signal at all.
//
// Two cancellation kinds, carried on `signal.reason` (kernel §9):
//   - "interrupt": the user typed a new message mid-turn. The turn should stop,
//     but the new input is queued rather than discarded — a soft stop.
//   - "hard":      an explicit cancel (Ctrl+C, task_stop). Nothing is queued.
//
// Reasons are structured ({ kind, message }) but we also interpret plain-string
// reasons (the pre-M35 convention, e.g. abort("stopped by task_stop")) as hard
// cancels, so existing call sites keep working.
// ============================================================

export type CancelKind = "interrupt" | "hard";

export interface CancelReason {
  kind: CancelKind;
  message?: string;
}

/** Build a structured abort reason. */
export function cancelReason(kind: CancelKind, message?: string): CancelReason {
  return { kind, message };
}

/**
 * Interpret an AbortSignal.reason into a typed kind (kernel §9). Structured
 * reasons are read directly; a plain string (or anything else) is treated as a
 * hard cancel, preserving the message when it's a string. `undefined` (a
 * signal aborted with no reason) is also a hard cancel.
 */
export function interpretCancelReason(reason: unknown): CancelReason {
  if (reason && typeof reason === "object" && "kind" in reason) {
    const r = reason as CancelReason;
    return { kind: r.kind === "interrupt" ? "interrupt" : "hard", message: r.message };
  }
  if (typeof reason === "string") return { kind: "hard", message: reason };
  return { kind: "hard" };
}

/** True when the signal was aborted as a soft "interrupt" (queue, don't discard). */
export function isInterrupt(signal: AbortSignal): boolean {
  return signal.aborted && interpretCancelReason(signal.reason).kind === "interrupt";
}

/**
 * STALL-timeout variant of combineAbortSignals (review follow-up #3): the
 * timer REARMS on every touch(), so it fires only after `stallMs` with no
 * stream activity — not `stallMs` after the request started. A wall-clock
 * cap kills legitimate long turns: with the raised 128K output ceiling
 * (user decision A6), a slow-but-progressing 50 tok/s generation needs ~40
 * minutes and would die at 5:00 mid-stream, then burn the whole transient
 * retry budget dying at 5:00 again each time (no finish_reason:"length", so
 * the M40 continuation never fires either). A hung connection — the thing
 * this guard exists for — produces NO events, so a stall timeout still
 * catches it exactly as fast.
 */
export function createStallController(
  parent: AbortSignal | undefined,
  stallMs: number,
): { signal: AbortSignal; touch: () => void; cleanup: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = () => controller.abort(parent?.reason);
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("Request timed out")), stallMs);
  };
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  if (!controller.signal.aborted) arm();
  return {
    signal: controller.signal,
    touch: () => {
      if (!controller.signal.aborted) arm();
    },
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Compose a caller signal and timeout without relying on AbortSignal.any (Node 18). */
export function combineAbortSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * A node in the cancellation tree. Wraps an AbortController, links to a parent
 * signal (parent abort → this aborts with the same reason), and tracks child
 * scopes so a subtree can be cancelled together (sibling cancellation).
 */
export class CancellationScope {
  readonly controller = new AbortController();
  private readonly children = new Set<CancellationScope>();
  private readonly onParentAbort?: () => void;
  private readonly parentSignal?: AbortSignal;

  constructor(parentSignal?: AbortSignal) {
    this.parentSignal = parentSignal;
    if (!parentSignal) return;
    if (parentSignal.aborted) {
      // Parent already aborted: inherit its reason immediately.
      this.controller.abort(parentSignal.reason);
      return;
    }
    this.onParentAbort = () => this.controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", this.onParentAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** Create a child scope linked to this one. Parent abort cascades to it. */
  fork(): CancellationScope {
    const child = new CancellationScope(this.signal);
    this.children.add(child);
    return child;
  }

  /** Abort this scope (and, via signal cascade, its whole subtree). */
  cancel(kind: CancelKind = "hard", message?: string): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(cancelReason(kind, message));
    }
  }

  /** Abort every child scope (sibling cancellation) without aborting self. */
  cancelChildren(kind: CancelKind = "hard", message?: string): void {
    for (const child of this.children) child.cancel(kind, message);
  }

  /** Detach the parent listener so a long-lived parent signal doesn't leak. */
  dispose(): void {
    if (this.parentSignal && this.onParentAbort) {
      this.parentSignal.removeEventListener("abort", this.onParentAbort);
    }
    this.children.clear();
  }
}
