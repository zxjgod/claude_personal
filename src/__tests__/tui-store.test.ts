// ============================================================
// Tests: TUI store (agent-loop ↔ React bridge)
// ============================================================

import { describe, it, expect } from "vitest";
import { TuiStore } from "../tui/store.js";
import type { ToolExecutionResult } from "../types.js";

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

  it("ignores empty streaming commits", () => {
    const store = new TuiStore("p/m");
    store.appendStreaming("   ");
    store.commitStreaming();
    expect(store.getSnapshot().transcript).toHaveLength(0);
  });

  it("tracks active tool then commits the result", () => {
    const store = new TuiStore("p/m");
    store.startTool("read", "a.ts", "call_1");
    expect(store.getSnapshot().activeTools).toEqual([
      { id: "call_1", name: "read", detail: "a.ts" },
    ]);
    store.finishTool(fakeResult("read"), "a.ts", "call_1");
    const snap = store.getSnapshot();
    expect(snap.activeTools).toEqual([]);
    expect(snap.transcript.at(-1)).toMatchObject({ kind: "tool", name: "read" });
  });

  it("tracks several concurrent tools and finishes them out of order", () => {
    const store = new TuiStore("p/m");
    store.startTool("read", "a.ts", "c1");
    store.startTool("grep", "foo", "c2");
    expect(store.getSnapshot().activeTools).toHaveLength(2);
    // Finish the second one first — the first must remain active.
    store.finishTool(fakeResult("grep"), "foo", "c2");
    expect(store.getSnapshot().activeTools).toEqual([
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
});
