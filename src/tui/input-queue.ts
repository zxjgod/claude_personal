// ============================================================
// Input Queue — type-ahead user input (M36, kernel §9)
// ============================================================
// A FIFO of user messages typed while the agent is busy. The kernel queues
// mid-turn input rather than discarding it (an "interrupt" is a soft stop): the
// loop drains the queue at each turn boundary and injects it as follow-up user
// messages, so the agent picks up the new instruction without the user having
// to wait for the turn to end and re-type.
//
// Deliberately tiny and synchronous: the loop calls drain() at safe points; the
// UI calls push() when the user submits while busy. Shared by the CLI/TUI and
// the loop so both sides agree on ordering (FIFO) and emptiness.
// ============================================================

export class InputQueue {
  private items: string[] = [];

  /** Enqueue a user message (ignores empty/whitespace-only input). */
  push(text: string): void {
    const t = text.trim();
    if (t) this.items.push(t);
  }

  /** True when there is queued input waiting to be drained. */
  get hasPending(): boolean {
    return this.items.length > 0;
  }

  get size(): number {
    return this.items.length;
  }

  /** Remove and return all queued items in FIFO order (empties the queue). */
  drain(): string[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  /** B6: a copy of the pending items (newest last) for the store's mirror. */
  snapshot(): string[] {
    return [...this.items];
  }

  /**
   * B6: remove and return the NEWEST queued item (Up-recall takes back what
   * was typed last, official semantics). Null when empty.
   */
  popLast(): string | null {
    return this.items.length > 0 ? this.items.pop()! : null;
  }

  /** Discard everything without returning it. */
  clear(): void {
    this.items = [];
  }
}
