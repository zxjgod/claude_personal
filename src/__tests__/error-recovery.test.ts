// ============================================================
// Tests: error recovery budgets, backoff, Retry-After (Top10
// follow-ups E1/E2/E3 + second-round low: retryAfter units)
// ============================================================

import { describe, expect, it, vi } from "vitest";
import {
  handleModelError,
  isContextLengthError,
  isFallbackableModelError,
  retryAfterMsFrom,
  sleep,
} from "../error-recovery.js";

function state(overrides: Partial<Parameters<typeof handleModelError>[1]> = {}) {
  return {
    rateLimitRetries: 0,
    contextLengthRetries: 0,
    transientRetries: 0,
    maxRateLimitRetries: 3,
    maxContextLengthRetries: 3,
    maxTransientRetries: 3,
    ...overrides,
  };
}

function httpError(status: number, message: string, headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), { status, headers });
}

describe("retryAfterMsFrom (unit normalization)", () => {
  it("reads the RFC seconds form from headers and normalizes to ms", () => {
    expect(retryAfterMsFrom(httpError(429, "slow down", { "retry-after": "7" }))).toBe(7_000);
    expect(retryAfterMsFrom(httpError(429, "slow down", { "Retry-After": "0.5" }))).toBe(500);
  });

  it("reads headers from a real fetch Headers instance (fourth round)", () => {
    // Both SDKs attach a Headers INSTANCE (data in internal slots) — plain
    // property indexing returned undefined and the Retry-After path was dead
    // in production while plain-object tests kept passing.
    const err = Object.assign(httpError(429, "slow down"), {
      headers: new Headers({ "retry-after": "7" }),
    });
    expect(retryAfterMsFrom(err)).toBe(7_000);
    const absent = Object.assign(httpError(429, "x"), { headers: new Headers({}) });
    expect(retryAfterMsFrom(absent)).toBeNull();
  });

  it("honors an explicit retryAfterMs attached by an adapter", () => {
    const err = Object.assign(httpError(429, "x", { "retry-after": "7" }), { retryAfterMs: 1234 });
    expect(retryAfterMsFrom(err)).toBe(1234);
  });

  it("parses the HTTP-date form", () => {
    const future = new Date(Date.now() + 3_000).toUTCString();
    const ms = retryAfterMsFrom(httpError(503, "x", { "retry-after": future }));
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(1_000);
    expect(ms!).toBeLessThanOrEqual(3_500);
  });

  it("returns null when nothing usable is present (including a legit 0 kept as 0)", () => {
    expect(retryAfterMsFrom(httpError(429, "x"))).toBeNull();
    expect(retryAfterMsFrom(null)).toBeNull();
    expect(retryAfterMsFrom(httpError(429, "x", { "retry-after": "0" }))).toBe(0);
  });
});

describe("sleep abortability (E1)", () => {
  it("resolves immediately for an already-aborted signal", async () => {
    const c = new AbortController();
    c.abort();
    const t0 = Date.now();
    await sleep(60_000, c.signal);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("resolves early when the signal fires mid-sleep", async () => {
    const c = new AbortController();
    const t0 = Date.now();
    const p = sleep(60_000, c.signal);
    setTimeout(() => c.abort(), 20);
    await p;
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("still sleeps the full duration without a signal", async () => {
    const t0 = Date.now();
    await sleep(60);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });
});

describe("handleModelError budgets", () => {
  it("retries 5xx as transient (was: abort → burned the fallback chain, E2)", async () => {
    const notices: number[] = [];
    const r = await handleModelError(
      httpError(500, "server exploded", { "retry-after": "0" }),
      state(),
      (n) => notices.push(n.delayMs),
    );
    expect(r).toBe("retry_transient");
    expect(notices[0]).toBeLessThanOrEqual(150); // retry-after 0 → floor + jitter
  });

  it("retries 529 overloaded as transient", async () => {
    const r = await handleModelError(httpError(529, "overloaded", { "retry-after": "0" }), state());
    expect(r).toBe("retry_transient");
  });

  it("aborts 5xx once the transient budget is exhausted", async () => {
    const r = await handleModelError(
      httpError(500, "still broken"),
      state({ transientRetries: 3 }),
    );
    expect(r).toBe("abort");
  });

  it("429 uses the server Retry-After (seconds→ms), not the dead retryAfter property", async () => {
    const notices: number[] = [];
    const r = await handleModelError(
      httpError(429, "rate limited", { "retry-after": "0" }),
      state(),
      (n) => notices.push(n.delayMs),
    );
    expect(r).toBe("retry");
    // Old code: (err.retryAfter as number) || 5000 → always ≥5000·2ⁿ·0.8.
    // Now: 0s header → MIN_BACKOFF floor + ≤20% jitter.
    expect(notices[0]).toBeLessThanOrEqual(150);
  });

  it("returns abort when the turn was cancelled during the 429 backoff", async () => {
    const c = new AbortController();
    c.abort();
    const r = await handleModelError(httpError(429, "rate limited"), state(), undefined, c.signal);
    // Pre-aborted: the sleep resolves immediately and the decision flips to
    // abort so the loop exits instead of re-calling the model.
    expect(r).toBe("abort");
  });

  it("context overflow in both wordings routes to compact_and_retry and is not fallbackable", async () => {
    const anthropicErr = httpError(400, "prompt is too long: 210000 tokens > 200000 maximum");
    const openaiErr = httpError(400, "context_length_exceeded");
    expect(isContextLengthError(anthropicErr)).toBe(true);
    expect(isContextLengthError(openaiErr)).toBe(true);
    expect(await handleModelError(anthropicErr, state())).toBe("compact_and_retry");
    expect(isFallbackableModelError(anthropicErr)).toBe(false);
    expect(isFallbackableModelError(httpError(500, "boom"))).toBe(true);
  });

  it("classifies abort/timeout message variants case-insensitively (既有 E)", async () => {
    // Provider/SDK wordings vary in case; the old lowercase-only includes()
    // misrouted "Request Aborted" (→ fallbackable, not abort) and
    // "Connection Timeout" (→ abort-ish fallthrough, not transient).
    const aborted = new Error("Request Aborted");
    expect(await handleModelError(aborted, state())).toBe("abort");
    expect(isFallbackableModelError(aborted)).toBe(false);

    // "Connection Timeout" must classify as TRANSIENT (the old lowercase-only
    // includes("timeout") missed it and it fell through to abort/fallback).
    const notices: string[] = [];
    const timeout = new Error("Connection Timeout");
    expect(await handleModelError(timeout, state(), (n) => notices.push(n.kind))).toBe(
      "retry_transient",
    );
    expect(notices).toEqual(["transient"]);
    expect(await handleModelError(new Error("SOCKET HANG UP"), state())).toBe("retry_transient");
  }, 20_000);
});

describe("onRetry notice bookkeeping", () => {
  it("fires exactly one notice per retry decision", async () => {
    const onRetry = vi.fn();
    await handleModelError(httpError(500, "x", { "retry-after": "0" }), state(), onRetry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0].kind).toBe("transient");
  });
});
