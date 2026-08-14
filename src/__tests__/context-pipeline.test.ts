// ============================================================
// Tests: Context Pipeline (M31)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  applyToolResultBudget,
  COMPACT_BOUNDARY_MARKER,
  CollapseStore,
  getMessagesAfterCompactBoundary,
  microcompact,
  prepareCheapLayers,
} from "../context-pipeline.js";
import type { Message } from "../types.js";

/** Build an assistant(tool_call) + tool(result) pair. */
function pair(id: string, resultChars: number): Message[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: id, name: "read", content: "x".repeat(resultChars) },
  ];
}

function history(pairs: number, resultChars: number): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  for (let i = 0; i < pairs; i++) msgs.push(...pair(`call_${i}`, resultChars));
  return msgs;
}

const estTokens = (m: Message[]): number => {
  let chars = 0;
  for (const msg of m) {
    if (msg.role === "tool") chars += msg.content.length;
    else if (msg.role === "system") chars += msg.content.length;
    else if (msg.role === "assistant" && msg.content) chars += msg.content.length;
    else if (msg.role === "user")
      for (const b of msg.content) if (b.type === "text") chars += b.text.length;
  }
  return Math.ceil(chars / 4);
};

describe("getMessagesAfterCompactBoundary (M31 layer 1)", () => {
  it("returns the same array when there is no boundary", () => {
    const msgs = history(3, 100);
    expect(getMessagesAfterCompactBoundary(msgs)).toBe(msgs);
  });

  it("drops everything before the last boundary", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "old1" }] },
      { role: "assistant", content: "old reply" },
      { role: "system", content: `${COMPACT_BOUNDARY_MARKER}\nsummary here` },
      { role: "user", content: [{ type: "text", text: "new1" }] },
    ];
    const out = getMessagesAfterCompactBoundary(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    expect((out[1] as any).content[0].text).toBe("new1");
  });

  it("uses the LAST boundary when several exist", () => {
    const msgs: Message[] = [
      { role: "system", content: `${COMPACT_BOUNDARY_MARKER}\nfirst` },
      { role: "user", content: [{ type: "text", text: "mid" }] },
      { role: "system", content: `${COMPACT_BOUNDARY_MARKER}\nsecond` },
      { role: "user", content: [{ type: "text", text: "tail" }] },
    ];
    const out = getMessagesAfterCompactBoundary(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain("second");
  });
});

describe("applyToolResultBudget (M31 layer 2)", () => {
  it("is a no-op under budget", () => {
    const msgs = history(3, 100);
    const r = applyToolResultBudget(msgs, { maxTotalChars: 1_000_000 });
    expect(r.changed).toBe(0);
    expect(r.messages).toBe(msgs);
  });

  it("trims oldest oversized results first and protects recent ones", () => {
    const msgs = history(10, 5000); // 50k tool chars total
    const store = new CollapseStore();
    const r = applyToolResultBudget(msgs, { maxTotalChars: 20_000, keepRecent: 4, store });
    expect(r.changed).toBeGreaterThan(0);
    expect(r.charsSaved).toBeGreaterThan(0);

    // The 4 most recent tool results are untouched (full length).
    const toolMsgs = r.messages.filter((m) => m.role === "tool") as Extract<
      Message,
      { role: "tool" }
    >[];
    const recent = toolMsgs.slice(-4);
    expect(recent.every((m) => m.content.length === 5000)).toBe(true);

    // Trimmed originals are recoverable.
    expect(store.size).toBe(r.changed);
  });

  it("preserves tool_call_id pairing after trimming", () => {
    const msgs = history(10, 5000);
    const r = applyToolResultBudget(msgs, { maxTotalChars: 10_000, keepRecent: 2 });
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i];
      if (m.role !== "tool") continue;
      const prev = r.messages[i - 1];
      expect(prev.role === "assistant" && Array.isArray(prev.tool_calls)).toBe(true);
    }
  });
});

describe("microcompact (M31 layer 3)", () => {
  it("evicts old tool-result bodies but keeps recent ones intact", () => {
    const msgs = history(12, 3000);
    const store = new CollapseStore();
    const r = microcompact(msgs, { keepRecentToolResults: 4, store });
    expect(r.changed).toBe(8); // 12 - 4 recent kept

    const toolMsgs = r.messages.filter((m) => m.role === "tool") as Extract<
      Message,
      { role: "tool" }
    >[];
    // Evicted ones are short stubs; recent 4 are full.
    expect(toolMsgs.slice(0, 8).every((m) => m.content.startsWith("[evicted:"))).toBe(true);
    expect(toolMsgs.slice(-4).every((m) => m.content.length === 3000)).toBe(true);
    // Originals recoverable.
    expect(store.restore("call_0")).toBe("x".repeat(3000));
  });

  it("is idempotent (does not re-evict a stub)", () => {
    const msgs = history(10, 3000);
    const once = microcompact(msgs, { keepRecentToolResults: 2 });
    const twice = microcompact(once.messages, { keepRecentToolResults: 2 });
    expect(twice.changed).toBe(0);
  });

  it("skips results below minEvictChars", () => {
    const msgs = history(10, 50); // tiny results
    const r = microcompact(msgs, { keepRecentToolResults: 2, minEvictChars: 1000 });
    expect(r.changed).toBe(0);
  });
});

describe("tool-type-aware eviction (COMPACTABLE_TOOLS)", () => {
  function toolMsg(id: string, name: string, chars: number): Message[] {
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: id, name, content: "z".repeat(chars) },
    ];
  }

  it("microcompact protects semantic tool results (task) but evicts bulk (read)", () => {
    const msgs = [...toolMsg("task_0", "task", 3000), ...toolMsg("read_0", "read", 3000)];
    const r = microcompact(msgs, { keepRecentToolResults: 0, minEvictChars: 1000 });
    const taskResult = r.messages.find((m) => m.role === "tool" && m.name === "task") as Extract<
      Message,
      { role: "tool" }
    >;
    const readResult = r.messages.find((m) => m.role === "tool" && m.name === "read") as Extract<
      Message,
      { role: "tool" }
    >;
    expect(taskResult.content).not.toContain("[evicted:");
    expect(readResult.content).toContain("[evicted:");
  });

  it("applyToolResultBudget protects semantic tool results too", () => {
    const msgs = [...toolMsg("task_0", "task", 3000), ...toolMsg("read_0", "read", 3000)];
    const r = applyToolResultBudget(msgs, { maxTotalChars: 2000, keepRecent: 0 });
    const taskResult = r.messages.find((m) => m.role === "tool" && m.name === "task") as Extract<
      Message,
      { role: "tool" }
    >;
    const readResult = r.messages.find((m) => m.role === "tool" && m.name === "read") as Extract<
      Message,
      { role: "tool" }
    >;
    expect(taskResult.content.length).toBe(3000); // untouched
    expect(readResult.content.length).toBeLessThan(3000); // trimmed
  });
});

describe("prepareCheapLayers orchestrator (M31)", () => {
  it("runs nothing under threshold and reports no autoCompact need", () => {
    const msgs = history(2, 100);
    const r = prepareCheapLayers(msgs, { estimateTokens: estTokens, threshold: 1_000_000 });
    expect(r.messages).toBe(msgs);
    expect(r.notes).toHaveLength(0);
    expect(r.needsAutoCompact).toBe(false);
  });

  it("trims/evicts when over threshold and reports notes", () => {
    const msgs = history(30, 4000); // ~120k tool chars → ~30k tokens
    const r = prepareCheapLayers(msgs, { estimateTokens: estTokens, threshold: 5000 });
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.messages).not.toBe(msgs);
  });

  it("flags needsAutoCompact when the cheap layers cannot get under threshold", () => {
    // A huge recent window the cheap layers must leave intact → still over.
    const msgs = history(40, 8000);
    const r = prepareCheapLayers(msgs, { estimateTokens: estTokens, threshold: 1000 });
    expect(r.needsAutoCompact).toBe(true);
  });
});

describe("CollapseStore (M31 layer 4)", () => {
  it("stashes first write and restores it; ignores overwrites", () => {
    const store = new CollapseStore();
    store.collapse("a", "original");
    store.collapse("a", "second"); // ignored
    expect(store.restore("a")).toBe("original");
    expect(store.restore("missing")).toBeUndefined();
    expect(store.size).toBe(1);
  });
});
