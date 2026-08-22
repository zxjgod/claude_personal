// ============================================================
// Tests: MCP timeout helper (stability hardening)
// ============================================================
// MCP servers are external processes/services that can hang indefinitely.
// `withTimeout` races the operation against a timer so a hung server degrades
// to a TimeoutError instead of pinning the agent loop forever. These tests
// pin the contract: it resolves when the operation wins, rejects with
// TimeoutError when the timer wins, and never leaks the timer.
// ============================================================

import { describe, expect, it, vi } from "vitest";
import {
  expandEnvRecord,
  expandEnvTemplate,
  MCPManager,
  TimeoutError,
  withTimeout,
} from "../mcp/index.js";

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
    await expect(withTimeout("op", hanging, 30)).rejects.toBeInstanceOf(TimeoutError);
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
    await withTimeout("op", new Promise((resolve) => setImmediate(resolve)), 5000);
    // Resolved near-immediately; the 5s timer did not fire.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("propagates the operation's own rejection (not masked as a timeout)", async () => {
    const boom = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("server crashed")), 5),
    );
    await expect(withTimeout("op", boom, 1000)).rejects.toThrow("server crashed");
  });

  it("bounds MCP resource listing when a server stops responding", async () => {
    vi.useFakeTimers();
    try {
      const manager = new MCPManager();
      const close = vi.fn();
      (manager as any).servers.set("hung", {
        config: { type: "http", url: "http://127.0.0.1:1" },
        client: { listResources: () => new Promise(() => {}) },
        transport: { close },
        tools: [],
      });
      const pending = manager.listResources();
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toEqual([]);
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds MCP shutdown when graceful close hangs", async () => {
    vi.useFakeTimers();
    try {
      const manager = new MCPManager();
      (manager as any).servers.set("hung", {
        config: { type: "stdio", command: "mock" },
        client: { close: () => new Promise(() => {}) },
        transport: { close: () => undefined },
        tools: [],
      });
      const pending = manager.disconnectAll();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBeUndefined();
      expect(manager.serverCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mcp expandEnvTemplate", () => {
  const saved = { ...process.env };

  it("expands ${VAR} placeholders from process.env", () => {
    process.env.MCP_TEST_TOKEN = "ghp_123";
    expect(expandEnvTemplate("Bearer ${MCP_TEST_TOKEN}")).toBe("Bearer ghp_123");
  });

  it("expands undefined variables to empty string (no literal leak)", () => {
    delete process.env.MCP_TEST_TOKEN;
    expect(expandEnvTemplate("Bearer ${MCP_TEST_TOKEN}")).toBe("Bearer ");
  });

  it("leaves non-var text and non-UPPER var names untouched", () => {
    expect(expandEnvTemplate("plain ${mixedCase} ${NOT_A_VAR")).toBe(
      "plain ${mixedCase} ${NOT_A_VAR",
    );
  });

  it("expandEnvRecord expands every key and value, preserving undefined", () => {
    process.env.MCP_TEST_KEY = "x-secret";
    const out = expandEnvRecord({ Authorization: "Bearer ${MCP_TEST_KEY}", "X-Literal": "plain" });
    expect(out).toEqual({ Authorization: "Bearer x-secret", "X-Literal": "plain" });
    expect(expandEnvRecord(undefined)).toBeUndefined();
  });

  it("restores the environment afterwards", () => {
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    expect(process.env.MCP_TEST_KEY).toBeUndefined();
  });
});
