// ============================================================
// Tests: FS listing cache (M3) — TTL memoization for grep/glob
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedFileListing,
  clearFileListingCache,
  invalidateWorkspaceFiles,
  TTLCache,
} from "../utils/fs-cache.js";

beforeEach(() => {
  clearFileListingCache();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("TTLCache", () => {
  it("stores and expires entries", () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string>(1000);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    vi.advanceTimersByTime(1500);
    expect(cache.get("k")).toBeUndefined();
  });

  it("deletePrefix removes only matching keys", () => {
    const cache = new TTLCache<number>(10_000);
    cache.set("/ws/a", 1);
    cache.set("/ws/a/sub", 2);
    cache.set("/other", 3);
    expect(cache.deletePrefix("/ws/a")).toBe(2);
    expect(cache.get("/other")).toBe(3);
    expect(cache.get("/ws/a")).toBeUndefined();
  });

  it("set is a no-op when disabled (ttl 0)", () => {
    const cache = new TTLCache<number>(0);
    cache.set("k", 1);
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("cachedFileListing", () => {
  it("memoizes the producer — the second hit does not re-run it", async () => {
    let produced = 0;
    const produce = async () => {
      produced++;
      return ["a.ts", "b.ts"];
    };
    const first = await cachedFileListing("/ws", "rgfiles|", produce);
    const second = await cachedFileListing("/ws", "rgfiles|", produce);
    expect(first).toEqual(["a.ts", "b.ts"]);
    expect(second).toBe(first); // same array reference — cached, not recomputed
    expect(produced).toBe(1);
  });

  it("different detail keys run their own producers", async () => {
    let produced = 0;
    const produce = async () => {
      produced++;
      return [];
    };
    await cachedFileListing("/ws", "rgfiles|ts|", produce);
    await cachedFileListing("/ws", "rgfiles||*.md", produce);
    expect(produced).toBe(2);
  });

  it("a rejected producer is not cached — the retry re-runs it", async () => {
    let attempts = 0;
    const failing = async () => {
      attempts++;
      if (attempts === 1) throw new Error("rg spawn failed");
      return ["ok"];
    };
    await expect(cachedFileListing("/ws", "bad", failing)).rejects.toThrow("rg spawn failed");
    const second = await cachedFileListing("/ws", "bad", async () => ["ok"]);
    expect(second).toEqual(["ok"]);
    expect(attempts).toBe(1);
  });

  it("invalidateWorkspaceFiles drops entries under the root only", async () => {
    await cachedFileListing("/ws-one", "glob|**", async () => ["one"]);
    await cachedFileListing("/ws-two", "glob|**", async () => ["two"]);
    invalidateWorkspaceFiles("/ws-one");
    let reruns = 0;
    const again = await cachedFileListing("/ws-one", "glob|**", async () => {
      reruns++;
      return ["one-again"];
    });
    expect(again).toEqual(["one-again"]);
    expect(reruns).toBe(1); // /ws-one was invalidated so the producer re-ran
    const two = await cachedFileListing("/ws-two", "glob|**", async () => {
      throw new Error("must not re-run");
    });
    expect(two).toEqual(["two"]); // /ws-two still cached
  });

  it("CCR_FS_CACHE_TTL_MS=0 disables caching entirely", async () => {
    vi.stubEnv("CCR_FS_CACHE_TTL_MS", "0");
    let produced = 0;
    const produce = async () => {
      produced++;
      return [];
    };
    await cachedFileListing("/ws", "off", produce);
    await cachedFileListing("/ws", "off", produce);
    expect(produced).toBe(2);
  });
});
