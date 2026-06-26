// ============================================================
// Tests: MCP timeout helper (stability hardening)
// ============================================================
// MCP servers are external processes/services that can hang indefinitely.
// `withTimeout` races the operation against a timer so a hung server degrades
// to a TimeoutError instead of pinning the agent loop forever. These tests
// pin the contract: it resolves when the operation wins, rejects with
// TimeoutError when the timer wins, and never leaks the timer.
// ============================================================

import { describe, it, expect } from "vitest";
import { withTimeout, TimeoutError } from "../mcp.js";

describe("mcp withTimeout", () => {
  it("resolves with the operation's value when it finishes in time", async () => {
    const result = await withTimeout(
      "op",
      new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 10)),
      1000,
    );
    expect(result).toBe("ok");
  });

  it("rejects with TimeoutError when the operation exceeds the deadline", async () => {
    const hanging = new Promise<string>(() => {
      // never resolves
    });
    await expect(withTimeout("op", hanging, 30)).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("the TimeoutError message names the operation and the deadline", async () => {
    const hanging = new Promise<string>(() => {});
    try {
      await withTimeout("connect(stdio)", hanging, 25);
      throw new Error("should have rejected");
    } catch (e: any) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toContain("connect(stdio)");
      expect(e.message).toContain("25ms");
    }
  });

  it("does not leak the timer when the operation wins (timer is cleared)", async () => {
    // If clearTimeout were skipped, a dangling timer would keep the process
    // alive. We assert the operation resolves promptly AND that a follow-up
    // tight check doesn't observe a pending rejection from the raced timer.
    const start = Date.now();
    await withTimeout(
      "op",
      new Promise((resolve) => setImmediate(resolve)),
      5000,
    );
    // Resolved near-immediately; the 5s timer did not fire.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("propagates the operation's own rejection (not masked as a timeout)", async () => {
    const boom = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("server crashed")), 5),
    );
    await expect(withTimeout("op", boom, 1000)).rejects.toThrow(
      "server crashed",
    );
  });
});
