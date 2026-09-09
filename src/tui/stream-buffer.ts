// ============================================================
// StreamBuffer — coalesce high-frequency stream deltas (M23.6)
// ============================================================
// The model streams text in many small deltas (sometimes one per token). If
// each delta triggered a store mutation → full Ink re-render, a fast stream
// would thrash the terminal. StreamBuffer batches deltas and flushes them on a
// fixed cadence (~30fps), so the live region repaints at a steady frame rate
// regardless of how fast tokens arrive.
//
// It's intentionally framework-free and timer-injectable so it can be unit
// tested deterministically (no real clock).
// ============================================================

/** ~30fps: one repaint every ~33ms is smooth without thrashing. */
export const FLUSH_INTERVAL_MS = 33;

type Timers = {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (h: ReturnType<typeof setInterval>) => void;
};

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

export class StreamBuffer {
  private pending = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onFlush: (text: string) => void;
  private readonly intervalMs: number;
  private readonly timers: Timers;

  constructor(
    onFlush: (text: string) => void,
    opts: { intervalMs?: number; timers?: Timers } = {},
  ) {
    this.onFlush = onFlush;
    this.intervalMs = opts.intervalMs ?? FLUSH_INTERVAL_MS;
    this.timers = opts.timers ?? realTimers;
  }

  /** Queue a delta. Starts the flush clock lazily on the first push. */
  push(delta: string): void {
    if (delta.length === 0) return;
    this.pending += delta;
    if (this.timer === null) {
      this.timer = this.timers.setInterval(() => this.flush(), this.intervalMs);
      // Don't keep the process alive solely for the flush clock.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Emit whatever is buffered now (no-op when empty). */
  flush(): void {
    if (this.pending.length === 0) return;
    const text = this.pending;
    this.pending = "";
    this.onFlush(text);
  }

  /** Flush any remainder and stop the clock. Call at end of a turn. */
  stop(): void {
    this.flush();
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Throw away buffered deltas WITHOUT emitting them, keeping the flush clock
   * running. Used at a model-retry boundary: the pending text belongs to the
   * failed attempt and must never reach the store.
   */
  discard(): void {
    this.pending = "";
  }

  /** Buffered characters not yet flushed (for tests/inspection). */
  get pendingLength(): number {
    return this.pending.length;
  }
}
