// ============================================================
// Semaphore — bounded concurrency with abort-aware queueing
// ============================================================
// Shared by the Task and Agent tools to cap concurrent sub-agent loops.
// acquire() queues abort-aware waiters (FIFO); release() transfers the
// reservation directly to the next waiter. tryAcquire() never waits — use it
// where queueing could deadlock (e.g. a nested agent whose parent already
// holds a slot and is waiting on the child's result).
// ============================================================

interface SlotWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Semaphore {
  private activeCount = 0;
  private readonly waitQueue: SlotWaiter[] = [];

  constructor(
    private readonly max: number,
    private readonly label = "Worker",
  ) {}

  /** Slots currently held. */
  get active(): number {
    return this.activeCount;
  }

  /** Waiters parked on the queue. */
  get queued(): number {
    return this.waitQueue.length;
  }

  /**
   * Acquire a slot, queueing (FIFO) when all are busy. Rejects if the signal
   * aborts while waiting. The reservation transfers on release(): a waiter
   * handed a slot does not re-increment the count.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error(`${this.label} aborted before acquiring a slot`);
    if (this.activeCount < this.max) {
      this.activeCount++;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waitQueue.indexOf(waiter);
          if (index >= 0) this.waitQueue.splice(index, 1);
          reject(new Error(`${this.label} aborted while waiting for a slot`));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waitQueue.push(waiter);
    });
  }

  /** Take a slot without waiting. Returns false when all slots are busy. */
  tryAcquire(): boolean {
    if (this.activeCount < this.max) {
      this.activeCount++;
      return true;
    }
    return false;
  }

  /**
   * Release a slot. If waiters are parked, the reservation transfers to the
   * first live one (aborted waiters are rejected and skipped); only an empty
   * queue decrements the active count.
   */
  release(): void {
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      if (next.signal?.aborted) {
        if (next.onAbort && next.signal) next.signal.removeEventListener("abort", next.onAbort);
        next.reject(new Error(`${this.label} aborted while waiting for a slot`));
        continue;
      }
      if (next.onAbort && next.signal) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve();
      return;
    }
    this.activeCount--;
  }
}
