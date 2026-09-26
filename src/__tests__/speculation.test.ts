// ============================================================
// Tests: speculation — predictive tool prefetch (12.2)
// ============================================================

import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { HookRegistry } from "../hooks.js";
import {
  effectiveCap,
  formatSpeculationLine,
  predictReads,
  rankPaths,
  SpeculationCache,
  specKey,
} from "../speculation.js";
import type { HookRunner, Tool, ToolContext, ToolResult } from "../types.js";

const ctx: ToolContext = {
  workspaceRoot: "/ws",
  sessionId: "s",
  permissionMode: "default",
  modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "k" },
};

function fakeReadTool(calls: string[]): Tool {
  return {
    name: "read",
    description: "",
    promptDescription: "",
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input: Record<string, unknown>): Promise<ToolResult> {
      calls.push(String(input.filePath));
      return { content: `content of ${input.filePath}` };
    },
    formatResult: (r) => r.content,
    async checkPermissions() {
      return { allowed: true };
    },
  } as Tool;
}

describe("predictReads", () => {
  it("predicts Read calls from glob output (one path per line)", () => {
    const preds = predictReads("glob", { content: "src/a.ts\nsrc/b.ts" });
    expect(preds).toHaveLength(2);
    expect(preds[0]).toEqual({ toolName: "read", input: { filePath: "src/a.ts" } });
  });

  it("extracts paths from ripgrep-style grep output", () => {
    const preds = predictReads("grep", {
      content: "src/a.ts:12:  const x = 1\nsrc/a.ts:40:  return x\nsrc/b.ts:3:  foo",
    });
    // Dedupes a.ts → two distinct files.
    expect(preds.map((p) => p.input.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("extracts Windows drive-letter absolute paths without splitting at the drive colon", () => {
    // Review follow-up: the generic `^([^:]+):` fallback used to yield "C"
    // as the filename for "C:\proj\a.ts:12: ...", prefetching a file named C.
    const preds = predictReads("grep", {
      content: "C:\\proj\\a.ts:12:  const x = 1\nD:/other/b.ts:3:  y",
    });
    expect(preds.map((p) => p.input.filePath)).toEqual(["C:\\proj\\a.ts", "D:/other/b.ts"]);
  });

  it("returns nothing for non-search tools or errors", () => {
    expect(predictReads("write", { content: "x" })).toEqual([]);
    expect(predictReads("glob", { content: "", error: "boom" })).toEqual([]);
    expect(predictReads("glob", { content: "No files found matching pattern." })).toEqual([]);
  });

  it("caps the number of predictions", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join("\n");
    const preds = predictReads("glob", { content: many }, { maxPrefetch: 3 });
    // M15.2: cap scales DOWN with candidate count. 20 files, baseMax 3 →
    // effectiveCap = round(3*6/(20+5)) = round(0.72) = 1, clamped to ≥1.
    expect(preds).toHaveLength(1);
    expect(preds[0]).toEqual({ toolName: "read", input: { filePath: "f0.ts" } });
  });

  it("ranks grep hits by multiplicity (multi-hit file first)", () => {
    const preds = predictReads("grep", {
      content: "src/a.ts:1: x\nsrc/b.ts:2: y\nsrc/a.ts:3: z",
    });
    // a.ts appears twice, b.ts once → a.ts ranked first despite being listed
    // first anyway; the point is the ordering reflects multiplicity.
    expect(preds.map((p) => p.input.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("rankPaths", () => {
  it("tallies grep occurrences and breaks ties by first-seen order", () => {
    const ranked = rankPaths("grep", ["b", "a", "a", "b", "a"]);
    // a:3, b:2; a first.
    expect(ranked.map((r) => r.path)).toEqual(["a", "b"]);
    expect(ranked[0].score).toBe(3);
    expect(ranked[1].score).toBe(2);
  });

  it("preserves glob input order (no multiplicity signal)", () => {
    const ranked = rankPaths("glob", ["x", "y", "z"]);
    expect(ranked.map((r) => r.path)).toEqual(["x", "y", "z"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe("effectiveCap", () => {
  it("returns 0 for an empty candidate set", () => {
    expect(effectiveCap(0, 5)).toBe(0);
  });

  it("prefetches at least 1 for any non-empty set (the top file is cheap)", () => {
    expect(effectiveCap(2, 5)).toBeGreaterThanOrEqual(1);
    expect(effectiveCap(100, 5)).toBe(1);
  });

  it("never exceeds baseMax", () => {
    expect(effectiveCap(1, 5)).toBeLessThanOrEqual(5);
    expect(effectiveCap(2, 5)).toBeLessThanOrEqual(5);
  });

  it("scales down as the candidate set grows", () => {
    expect(effectiveCap(5, 5)).toBe(3); // round(5*6/10)
    expect(effectiveCap(20, 5)).toBe(1); // round(5*6/25)
  });
});

describe("predictReads alreadyRead filter", () => {
  it("drops paths already read this session", () => {
    const preds = predictReads("glob", { content: "a.ts\nb.ts" }, {}, new Set(["a.ts"]));
    expect(preds.map((p) => p.input.filePath)).toEqual(["b.ts"]);
  });

  it("returns [] when every candidate was already read", () => {
    const preds = predictReads("glob", { content: "a.ts" }, {}, new Set(["a.ts"]));
    expect(preds).toEqual([]);
  });
});

describe("specKey", () => {
  it("is stable regardless of key order", () => {
    expect(specKey("read", { a: 1, b: 2 })).toBe(specKey("read", { b: 2, a: 1 }));
  });

  // Review follow-up M5: the old array-replacer form whitelisted TOP-level
  // key names across the whole tree, so different nested objects collapsed
  // onto one key — a poisoned-hit bug for any future nested tool input.
  it("distinguishes different nested inputs", () => {
    expect(specKey("read", { a: { b: 1 } })).not.toBe(specKey("read", { a: { c: 2 } }));
    expect(specKey("read", { a: { b: 1 } })).not.toBe(specKey("read", { a: { b: 2 } }));
  });

  it("is stable for nested keys regardless of insertion order", () => {
    expect(specKey("read", { z: 2, a: { b: 1, c: 3 } })).toBe(
      specKey("read", { a: { c: 3, b: 1 }, z: 2 }),
    );
  });
});

describe("SpeculationCache", () => {
  it("is a no-op when disabled", async () => {
    const calls: string[] = [];
    const cache = new SpeculationCache(false);
    cache.prefetch([{ toolName: "read", input: { filePath: "x" } }], [fakeReadTool(calls)], ctx);
    expect(calls).toHaveLength(0);
    expect(await cache.take("read", { filePath: "x" })).toBeNull();
  });

  it("prefetches read-only tools and serves a hit once", async () => {
    const calls: string[] = [];
    const tool = fakeReadTool(calls);
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: "a.ts" } }], [tool], ctx);
    // The prefetch ran the tool exactly once.
    const hit = await cache.take("read", { filePath: "a.ts" });
    expect(hit?.content).toBe("content of a.ts");
    expect(cache.hits).toBe(1);
    expect(calls).toEqual(["a.ts"]);
    // Second take for the same key misses (single-use).
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull();
    expect(cache.misses).toBe(1);
  });

  it("skips non-read-only tools", async () => {
    const calls: string[] = [];
    const writeTool = { ...fakeReadTool(calls), name: "write", isReadOnly: () => false } as Tool;
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "write", input: { filePath: "x" } }], [writeTool], ctx);
    expect(cache.prefetched).toBe(0);
    expect(await cache.take("write", { filePath: "x" })).toBeNull();
  });

  it("counts a miss for an unprefetched key", async () => {
    const cache = new SpeculationCache(true);
    expect(await cache.take("read", { filePath: "never" })).toBeNull();
    expect(cache.misses).toBe(1);
  });

  it("getStats reports hits, prefetched, wasted, and hitRate (M15.2)", async () => {
    const calls: string[] = [];
    const tool = fakeReadTool(calls);
    const cache = new SpeculationCache(true);
    cache.prefetch(
      [
        { toolName: "read", input: { filePath: "hit.ts" } },
        { toolName: "read", input: { filePath: "waste.ts" } },
      ],
      [tool],
      ctx,
    );
    // Consume one; the other goes wasted.
    await cache.take("read", { filePath: "hit.ts" });

    const stats = cache.getStats();
    expect(stats.prefetched).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.wasted).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it("getStats hitRate is 0 when nothing was prefetched", () => {
    const cache = new SpeculationCache(true);
    const stats = cache.getStats();
    expect(stats.prefetched).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(stats.wasted).toBe(0);
  });

  // ============================================================
  // Top10 #6: freshness guards — TTL, path invalidation, clear,
  // hook gating, and the speculative context flag.
  // ============================================================

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function hookStub(runPre: HookRunner["runPre"]): HookRunner {
    return { runPre, runPost: async () => ({}) };
  }

  it("expires entries past the TTL (staleness window is bounded)", async () => {
    const calls: string[] = [];
    const cache = new SpeculationCache(true, { ttlMs: 20 });
    cache.prefetch([{ toolName: "read", input: { filePath: "a.ts" } }], [fakeReadTool(calls)], ctx);
    await sleep(45);
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull();
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(0);
  });

  it("serves entries inside the TTL", async () => {
    const cache = new SpeculationCache(true, { ttlMs: 5_000 });
    cache.prefetch([{ toolName: "read", input: { filePath: "a.ts" } }], [fakeReadTool([])], ctx);
    expect((await cache.take("read", { filePath: "a.ts" }))?.content).toBe("content of a.ts");
  });

  it("invalidatePath drops only the matching path's entry", async () => {
    const cache = new SpeculationCache(true);
    cache.prefetch(
      [
        { toolName: "read", input: { filePath: "a.ts" } },
        { toolName: "read", input: { filePath: "b.ts" } },
      ],
      [fakeReadTool([])],
      ctx,
    );
    cache.invalidatePath(nodePath.resolve(ctx.workspaceRoot, "a.ts"));
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull(); // invalidated
    expect((await cache.take("read", { filePath: "b.ts" }))?.content).toBe("content of b.ts");
  });

  it("clear drops every pending entry", async () => {
    const cache = new SpeculationCache(true);
    cache.prefetch(
      [
        { toolName: "read", input: { filePath: "a.ts" } },
        { toolName: "read", input: { filePath: "b.ts" } },
      ],
      [fakeReadTool([])],
      ctx,
    );
    cache.clear();
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull();
    expect(await cache.take("read", { filePath: "b.ts" })).toBeNull();
  });

  it("an expired unconsumed entry does not block re-prefetch (review follow-up)", async () => {
    // The old `pending.has(key) → skip` check let a stale entry shadow the
    // file for the whole run: TTL expired at take() time, but the entry was
    // never re-prefetchable either.
    const calls: string[] = [];
    const cache = new SpeculationCache(true, { ttlMs: 20 });
    cache.prefetch([{ toolName: "read", input: { filePath: "a.ts" } }], [fakeReadTool(calls)], ctx);
    await sleep(45); // first entry expires unconsumed
    cache.prefetch([{ toolName: "read", input: { filePath: "a.ts" } }], [fakeReadTool(calls)], ctx);
    expect((await cache.take("read", { filePath: "a.ts" }))?.content).toBe("content of a.ts");
    expect(calls).toEqual(["a.ts", "a.ts"]); // both prefetches actually ran
    expect(cache.hits).toBe(1);
  });

  it("a PreToolUse hook block drops the prefetch (tool never runs, take misses)", async () => {
    const calls: string[] = [];
    const cache = new SpeculationCache(true);
    const hooks = hookStub(async () => ({ block: true, reason: "policy" }));
    cache.prefetch(
      [{ toolName: "read", input: { filePath: "a.ts" } }],
      [fakeReadTool(calls)],
      ctx,
      hooks,
    );
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull();
    expect(cache.misses).toBe(1);
    expect(calls).toEqual([]); // the speculative read itself was gated
  });

  it("a hook input rewrite drops the entry (rewritten call ≠ predicted call)", async () => {
    const calls: string[] = [];
    const cache = new SpeculationCache(true);
    const hooks = hookStub(async () => ({ input: { filePath: "other.ts" } }));
    cache.prefetch(
      [{ toolName: "read", input: { filePath: "a.ts" } }],
      [fakeReadTool(calls)],
      ctx,
      hooks,
    );
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a throwing hook fails closed (no speculative read behind it)", async () => {
    const calls: string[] = [];
    const cache = new SpeculationCache(true);
    const hooks = hookStub(async () => {
      throw new Error("hook infra down");
    });
    cache.prefetch(
      [{ toolName: "read", input: { filePath: "a.ts" } }],
      [fakeReadTool(calls)],
      ctx,
      hooks,
    );
    expect(await cache.take("read", { filePath: "a.ts" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a pass-through hook keeps the prefetch working", async () => {
    const cache = new SpeculationCache(true);
    const hooks = hookStub(async () => ({}));
    cache.prefetch(
      [{ toolName: "read", input: { filePath: "a.ts" } }],
      [fakeReadTool([])],
      ctx,
      hooks,
    );
    expect((await cache.take("read", { filePath: "a.ts" }))?.content).toBe("content of a.ts");
  });

  it("survives a real HookRegistry echoing the input unchanged (identity, not truthiness)", async () => {
    // HookRegistry.runPre ALWAYS returns { input } — the same reference when
    // nothing rewrote it. Treating a merely-present `input` as a rewrite
    // would drop every prefetch whenever hooks are wired (i.e. always, in
    // production) — speculation would be silently dead. The rewrite check
    // must compare identity against the predicted input.
    const registry = new HookRegistry();
    registry.register({ matcher: "*" }); // matches everything, no pre/post → pure pass-through
    const cache = new SpeculationCache(true);
    cache.prefetch(
      [{ toolName: "read", input: { filePath: "a.ts" } }],
      [fakeReadTool([])],
      ctx,
      registry,
    );
    expect((await cache.take("read", { filePath: "a.ts" }))?.content).toBe("content of a.ts");
    expect(cache.hits).toBe(1);
  });

  it("flags the prefetch runPre payload with speculative:true (review M5)", async () => {
    // Side-effectful hooks (audit/notifications) must be able to tell a
    // phantom prefetch from a model-issued call — while block policy still
    // applies to both.
    const seen: Array<{ toolName: string; speculative?: boolean }> = [];
    const hooks = hookStub(async (payload) => {
      seen.push({ toolName: payload.toolName, speculative: payload.speculative });
      return {};
    });
    const cache = new SpeculationCache(true);
    cache.prefetch(
      [{ toolName: "read", input: { filePath: "a.ts" } }],
      [fakeReadTool([])],
      ctx,
      hooks,
    );
    await cache.take("read", { filePath: "a.ts" });
    expect(seen).toEqual([{ toolName: "read", speculative: true }]);
  });

  it("runs the prefetch with context.speculative = true (read-tracker stays clean)", async () => {
    let seenSpeculative: boolean | undefined;
    const tool = fakeReadTool([]);
    const origCall = tool.call.bind(tool);
    tool.call = async (input, context) => {
      seenSpeculative = context.speculative;
      return origCall(input, context);
    };
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: "a.ts" } }], [tool], ctx);
    await cache.take("read", { filePath: "a.ts" });
    expect(seenSpeculative).toBe(true);
  });
});

describe("formatSpeculationLine", () => {
  it("formats H/P hits (RR%), W wasted", () => {
    expect(
      formatSpeculationLine({ hits: 3, misses: 2, prefetched: 5, wasted: 2, hitRate: 0.6 }),
    ).toBe("[speculation: 3/5 hits (60%), 2 wasted]");
  });

  it("returns '' when nothing was prefetched", () => {
    expect(
      formatSpeculationLine({ hits: 0, misses: 0, prefetched: 0, wasted: 0, hitRate: 0 }),
    ).toBe("");
  });
});
