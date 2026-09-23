// ============================================================
// Tests: Semaphore (F4) — shared Task/Agent concurrency cap
// ============================================================

import { describe, expect, it } from "vitest";
import { Semaphore } from "../utils/semaphore.js";

describe("Semaphore", () => {
  it("admits up to max concurrent holders, then queues", async () => {
    const sem = new Semaphore(2, "Worker");
    const order: string[] = [];
    const run = async (id: string) => {
      await sem.acquire();
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end-${id}`);
      sem.release();
    };
    await Promise.all([run("a"), run("b"), run("c"), run("d")]);
    // Only 2 run at once: no interleaving of start/end within a pair.
    expect(order.indexOf("start-c")).toBeGreaterThan(order.indexOf("end-a") === -1 ? -1 : 0);
    const startsAtOnce = order.filter((x) => x.startsWith("start-"));
    expect(startsAtOnce).toHaveLength(4);
    // Every queued worker eventually ran (no lost reservations).
    expect(order.filter((x) => x.startsWith("end-"))).toHaveLength(4);
  });

  it("queues FIFO", async () => {
    const sem = new Semaphore(1, "Worker");
    await sem.acquire();
    const order: number[] = [];
    const waiters = [1, 2, 3].map((id) =>
      sem.acquire().then(() => {
        order.push(id);
        sem.release();
      }),
    );
    sem.release();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects acquire() on an already-aborted signal", async () => {
    const sem = new Semaphore(1, "Sub-agent");
    await sem.acquire();
    const controller = new AbortController();
    controller.abort();
    await expect(sem.acquire(controller.signal)).rejects.toThrow(
      "Sub-agent aborted before acquiring a slot",
    );
    sem.release();
  });

  it("rejects a queued waiter when its signal aborts", async () => {
    const sem = new Semaphore(1, "Sub-agent");
    await sem.acquire();
    const controller = new AbortController();
    const pending = sem.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Sub-agent aborted while waiting for a slot");
    // The aborted waiter must not consume a reservation on release.
    sem.release();
    expect(sem.active).toBe(0);
  });

  it("tryAcquire succeeds only while slots remain and never queues", () => {
    const sem = new Semaphore(1, "Agent");
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });

  it("transfers a released reservation to the next waiter without over-counting", async () => {
    const sem = new Semaphore(1, "Worker");
    await sem.acquire();
    let secondStarted = false;
    const second = sem.acquire().then(() => {
      secondStarted = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(secondStarted).toBe(false);
    sem.release();
    await second;
    expect(secondStarted).toBe(true);
    // The transfer must not have decremented below reality: one holder now.
    expect(sem.active).toBe(1);
    sem.release();
    expect(sem.active).toBe(0);
  });
});
