// ============================================================
// Tests: TUI store (agent-loop ↔ React bridge)
// ============================================================

import { beforeAll, describe, expect, it } from "vitest";
import { setLanguage } from "../tui/i18n.js";
import { TuiStore } from "../tui/store.js";
import { selectionEqual } from "../tui/useStoreSelector.js";
import type { ToolExecutionResult } from "../types.js";

// Pin the UI language so literal-string assertions hold on zh-locale machines.
beforeAll(() => setLanguage("en"));

function fakeResult(name: string, formatted = "ok"): ToolExecutionResult {
  return { toolName: name, formatted, durationMs: 5 };
}

describe("TuiStore", () => {
  it("notifies subscribers on mutation", () => {
    const store = new TuiStore("deepseek/x");
    let count = 0;
    const unsub = store.subscribe(() => count++);
    store.addUserMessage("hi");
    expect(count).toBe(1);
    unsub();
    store.addUserMessage("again");
    expect(count).toBe(1); // unsubscribed
  });

  it("commits streaming text to an assistant transcript item", () => {
    const store = new TuiStore("p/m");
    store.appendStreaming("Hello ");
    store.appendStreaming("world");
    expect(store.getSnapshot().streamingText).toBe("Hello world");
    store.commitStreaming();
    const snap = store.getSnapshot();
    expect(snap.streamingText).toBe("");
    const last = snap.transcript.at(-1);
    expect(last).toMatchObject({ kind: "assistant", text: "Hello world" });
  });

  it("discardStreaming drops a failed attempt without committing it", () => {
    // S1: at a model_retry boundary the partial stream of the FAILED attempt
    // must vanish — committing it would fork the transcript from model history.
    const store = new TuiStore("p/m");
    store.appendStreamingWithTokens("partial from doomed attempt", 42);
    store.appendThinking("doomed reasoning");
    store.discardStreaming();
    const snap = store.getSnapshot();
    expect(snap.streamingText).toBe("");
    expect(snap.streamingThinking).toBe("");
    expect(snap.spinnerTokens).toBe(0);
    expect(snap.transcript.some((i) => i.kind === "assistant")).toBe(false);
    expect(snap.transcript.some((i) => i.kind === "thinking_text")).toBe(false);
  });

  it("ignores empty streaming commits", () => {
    const store = new TuiStore("p/m");
    store.appendStreaming("   ");
    store.commitStreaming();
    expect(store.getSnapshot().transcript).toHaveLength(0);
  });

  it("tracks active tool then commits the result", () => {
    const store = new TuiStore("p/m");
    store.startTool("read", "a.ts", "call_1");
    expect(store.getSnapshot().activeTools).toMatchObject([
      { id: "call_1", name: "read", detail: "a.ts", startedAt: expect.any(Number) },
    ]);
    store.finishTool(fakeResult("read"), "a.ts", "call_1");
    const snap = store.getSnapshot();
    expect(snap.activeTools).toEqual([]);
    expect(snap.transcript.at(-1)).toMatchObject({ kind: "tool", name: "read" });
  });

  it("tracks and clears nested-agent activity", () => {
    const store = new TuiStore("p/m");
    store.setActivityLabel("[code-reviewer] Read(src/app.ts)");
    expect(store.getSnapshot().activityLabel).toContain("code-reviewer");
    store.setActivityLabel(null);
    expect(store.getSnapshot().activityLabel).toBeNull();
  });

  it("clears stale active tools after a turn abort", () => {
    const store = new TuiStore("p/m");
    store.startTool("read", "a.ts", "c1");
    store.setActivityLabel("[agent] Read(a.ts)");
    store.clearActiveTools();
    store.setActivityLabel(null);
    expect(store.getSnapshot().activeTools).toEqual([]);
    expect(store.getSnapshot().activityLabel).toBeNull();
  });

  it("tracks several concurrent tools and finishes them out of order", () => {
    const store = new TuiStore("p/m");
    store.startTool("read", "a.ts", "c1");
    store.startTool("grep", "foo", "c2");
    expect(store.getSnapshot().activeTools).toHaveLength(2);
    // Finish the second one first — the first must remain active.
    store.finishTool(fakeResult("grep"), "foo", "c2");
    expect(store.getSnapshot().activeTools).toMatchObject([
      { id: "c1", name: "read", detail: "a.ts" },
    ]);
    store.finishTool(fakeResult("read"), "a.ts", "c1");
    expect(store.getSnapshot().activeTools).toEqual([]);
  });

  it("accumulates token usage", () => {
    const store = new TuiStore("p/m");
    store.addUsage(100, 50);
    store.addUsage(20, 30);
    const snap = store.getSnapshot();
    expect(snap.tokensIn).toBe(120);
    expect(snap.tokensOut).toBe(80);
  });

  it("accumulates cache-read tokens and tracks the live context estimate", () => {
    const store = new TuiStore("p/m");
    store.addUsage(100, 50, { read: 800, creation: 100 }, 1050);
    store.addUsage(200, 60, { read: 900 }, 1160);
    const snap = store.getSnapshot();
    expect(snap.tokensIn).toBe(300);
    expect(snap.tokensOut).toBe(110);
    expect(snap.cacheReadTokens).toBe(1700); // cumulative across calls
    expect(snap.contextUsed).toBe(1160); // LAST call's window, not cumulative
  });

  it("falls back to split-reporting context math when no explicit estimate is given", () => {
    const store = new TuiStore("p/m");
    store.addUsage(100, 50, { read: 800, creation: 100 });
    expect(store.getSnapshot().contextUsed).toBe(1050); // in+out+read+creation
  });

  it("context threshold crossings stay silent (C4: the persistent line replaced the toast)", () => {
    const store = new TuiStore("p/m");
    store.setContextLimit(1000);
    store.addUsage(500, 0, undefined, 600); // 60% — below warn, silent
    expect(store.getSnapshot().toast).toBeNull();
    store.addUsage(100, 0, undefined, 800); // crosses 75% — the App's
    store.addUsage(100, 0, undefined, 850); // Context-low line takes over;
    expect(store.getSnapshot().toast).toBeNull(); // no popup anymore
  });

  it("setModel updates id and label together", () => {
    const store = new TuiStore("p/m", { modelId: "model-a" });
    store.setModel("model-b", "prov/model-b");
    const snap = store.getSnapshot();
    expect(snap.modelId).toBe("model-b");
    expect(snap.modelLabel).toBe("prov/model-b");
  });

  it("assigns unique ids to transcript items", () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("a");
    store.addNotice("b");
    store.addLog(["c"]);
    const ids = store.getSnapshot().transcript.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("resolves a permission overlay with the chosen value", async () => {
    const store = new TuiStore("p/m");
    const p = store.askPermission("Edit request", "a.ts");
    const overlay = store.getSnapshot().overlay;
    expect(overlay?.kind).toBe("permission");
    overlay!.kind === "permission" && overlay!.resolve("always");
    await expect(p).resolves.toBe("always");
    expect(store.getSnapshot().overlay).toBeNull();
  });

  it("resolves a question overlay with selected labels", async () => {
    const store = new TuiStore("p/m");
    const p = store.askQuestion("Pick", "which?", [{ label: "A" }, { label: "B" }], true);
    const overlay = store.getSnapshot().overlay;
    expect(overlay?.kind).toBe("question");
    overlay!.kind === "question" && overlay!.resolve(["A", "B"]);
    await expect(p).resolves.toEqual(["A", "B"]);
    expect(store.getSnapshot().overlay).toBeNull();
  });

  it("resolves a session-picker overlay with the chosen id", async () => {
    const store = new TuiStore("p/m");
    const p = store.pickSession([
      { sessionId: "abc123", label: "abc123 · 4 msgs" },
      { sessionId: "def456", label: "def456 · 2 msgs" },
    ]);
    const overlay = store.getSnapshot().overlay;
    expect(overlay?.kind).toBe("sessionPicker");
    overlay!.kind === "sessionPicker" && overlay!.resolve("def456");
    await expect(p).resolves.toBe("def456");
    expect(store.getSnapshot().overlay).toBeNull();
  });

  it("resolves the picker with null when cancelled", async () => {
    const store = new TuiStore("p/m");
    const p = store.pickSession([{ sessionId: "abc", label: "abc" }]);
    const overlay = store.getSnapshot().overlay;
    overlay!.kind === "sessionPicker" && overlay!.resolve(null);
    await expect(p).resolves.toBeNull();
  });

  it("resolves a command-picker overlay with the chosen command name", async () => {
    const store = new TuiStore("p/m");
    const p = store.pickCommand([
      { name: "help", description: "Show help" },
      { name: "effort", description: "Set effort" },
    ]);
    const overlay = store.getSnapshot().overlay;
    expect(overlay?.kind).toBe("commandPicker");
    overlay!.kind === "commandPicker" && overlay!.resolve("effort");
    await expect(p).resolves.toBe("effort");
    expect(store.getSnapshot().overlay).toBeNull();
  });

  it("resolves the command picker with null when cancelled", async () => {
    const store = new TuiStore("p/m");
    const p = store.pickCommand([{ name: "help", description: "Show help" }]);
    const overlay = store.getSnapshot().overlay;
    overlay!.kind === "commandPicker" && overlay!.resolve(null);
    await expect(p).resolves.toBeNull();
  });

  it("loadTranscript appends replayed items with fresh unique ids", () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("/resume");
    store.loadTranscript([
      { kind: "user", text: "earlier question" } as any,
      { kind: "assistant", text: "earlier answer" } as any,
    ]);
    const t = store.getSnapshot().transcript;
    expect(t).toHaveLength(3);
    expect(t.at(-1)).toMatchObject({ kind: "assistant", text: "earlier answer" });
    expect(new Set(t.map((i) => i.id)).size).toBe(3); // ids stay unique
  });

  it("loadTranscript is a no-op for an empty batch", () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("x");
    const before = store.getSnapshot().transcript;
    store.loadTranscript([]);
    expect(store.getSnapshot().transcript).toBe(before); // same reference, no emit
  });

  it("toggles busy and spinner state", () => {
    const store = new TuiStore("p/m");
    store.setBusy(true);
    store.setSpinner("thinking");
    store.setSpinnerTokens(42);
    const snap = store.getSnapshot();
    expect(snap.busy).toBe(true);
    expect(snap.spinner).toBe("thinking");
    expect(snap.spinnerTokens).toBe(42);
  });

  it("starts and stops the turn clock", () => {
    const store = new TuiStore("p/m");
    expect(store.getSnapshot().turnStartedAt).toBe(0);
    store.startTurnClock();
    expect(store.getSnapshot().turnStartedAt).toBeGreaterThan(0);
    store.stopTurnClock();
    expect(store.getSnapshot().turnStartedAt).toBe(0);
  });

  it("toggles transcript review mode", () => {
    const store = new TuiStore("p/m");
    expect(store.getSnapshot().reviewing).toBe(false);
    store.setReviewing(true);
    expect(store.getSnapshot().reviewing).toBe(true);
    store.setReviewing(false);
    expect(store.getSnapshot().reviewing).toBe(false);
  });

  it("setTodos replaces the live todo list (projection of Todo tool state)", () => {
    const store = new TuiStore("p/m");
    expect(store.getSnapshot().todos).toEqual([]);

    const todos = [
      { content: "First", status: "completed" as const },
      { content: "Second", status: "in_progress" as const, activeForm: "Doing second" },
      { content: "Third", status: "pending" as const },
    ];
    store.setTodos(todos);
    expect(store.getSnapshot().todos).toEqual(todos);

    // Complete replacement (the tool sends the FULL list each time).
    store.setTodos([{ content: "Only", status: "pending" }]);
    expect(store.getSnapshot().todos).toEqual([{ content: "Only", status: "pending" }]);
  });

  it("cycles permission modes in the Shift+Tab order", () => {
    const store = new TuiStore("p/m", { permissionMode: "default" });
    expect(store.getPermissionMode()).toBe("default");
    // Official order (batch C): default → acceptEdits → plan → bypass.
    expect(store.cyclePermissionMode()).toBe("acceptEdits");
    expect(store.cyclePermissionMode()).toBe("plan");
    expect(store.cyclePermissionMode()).toBe("bypassPermissions");
    expect(store.cyclePermissionMode()).toBe("default");
  });

  it("sets permission mode directly", () => {
    const store = new TuiStore("p/m");
    store.setPermissionMode("bypassPermissions");
    expect(store.getSnapshot().permissionMode).toBe("bypassPermissions");
  });

  it("appendStreamingWithTokens appends text and keeps tokens monotonic", () => {
    const store = new TuiStore("p/m");
    store.appendStreamingWithTokens("Hello ", 10);
    store.appendStreamingWithTokens("world", 25);
    store.appendStreamingWithTokens("!", 5); // lower token value ignored
    const snap = store.getSnapshot();
    expect(snap.streamingText).toBe("Hello world!");
    expect(snap.spinnerTokens).toBe(25);
  });
});

describe("TuiStore frame batching (M24.1)", () => {
  it("notifies synchronously by default (batching off)", () => {
    const store = new TuiStore("p/m");
    let count = 0;
    store.subscribe(() => count++);
    store.appendStreaming("a");
    store.appendStreaming("b");
    expect(count).toBe(2); // one notify per mutation
  });

  it("coalesces a burst of mutations into a single notify when batching", () => {
    const store = new TuiStore("p/m", { batching: true });
    let count = 0;
    store.subscribe(() => count++);
    store.appendStreaming("a");
    store.appendStreaming("b");
    store.appendStreaming("c");
    // State is written synchronously regardless of batching.
    expect(store.getSnapshot().streamingText).toBe("abc");
    // …but the notify is deferred and coalesced — no sync emit yet.
    expect(count).toBe(0);
    // flush() drains the pending frame synchronously into one notify.
    store.flush();
    expect(count).toBe(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const store = new TuiStore("p/m", { batching: true });
    let count = 0;
    store.subscribe(() => count++);
    store.flush();
    expect(count).toBe(0);
  });

  it("eventually emits on its own frame timer when batching", async () => {
    const store = new TuiStore("p/m", { batching: true });
    let count = 0;
    store.subscribe(() => count++);
    store.appendStreaming("x");
    expect(count).toBe(0);
    await new Promise((r) => setTimeout(r, 40)); // > FRAME_MS
    expect(count).toBe(1);
  });

  it("setBatching(false) flushes pending work and restores sync notifies", () => {
    const store = new TuiStore("p/m", { batching: true });
    let count = 0;
    store.subscribe(() => count++);
    store.appendStreaming("pending");
    expect(count).toBe(0);
    store.setBatching(false);
    expect(count).toBe(1); // pending notify flushed by the switch
    store.appendStreaming("more");
    expect(count).toBe(2); // now synchronous again
  });
});

describe("selectionEqual (selector memoization compare)", () => {
  it("treats same-length equal arrays as equal, different lengths as NOT equal", () => {
    // Regression: a shallow compare must check key COUNT first, otherwise
    // [1,2] would be wrongly judged equal to [1,2,3] (prefix match).
    expect(selectionEqual([1, 2], [1, 2])).toBe(true);
    expect(selectionEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(selectionEqual([1, 2, 3], [1, 2])).toBe(false);
  });

  it("compares primitives with Object.is and objects shallowly", () => {
    expect(selectionEqual(0, 0)).toBe(true);
    expect(selectionEqual(0, -0)).toBe(false);
    expect(selectionEqual(NaN, NaN)).toBe(true);
    expect(selectionEqual("a", "b")).toBe(false);
    expect(selectionEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(selectionEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(selectionEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(selectionEqual(null, {})).toBe(false);
    expect(selectionEqual(null, null)).toBe(true);
  });
});
