// ============================================================
// Integration tests: TUI long-session regression (M21.5)
// ============================================================
// The TUI store is the seam between the imperative agent loop and Ink/React.
// A long session pushes hundreds of mutations through it; this suite drives 30+
// full rounds (user → streamed assistant → tool → usage) and asserts the store
// invariants that keep the UI correct over a long run:
//   - the transcript only grows, every item keeps a unique id;
//   - no active tool ever leaks (every start is matched by a finish, even out
//     of order);
//   - token totals accumulate exactly;
//   - overlays open and resolve cleanly mid-session without disturbing history.
// It also renders the real <App> under ink-testing-library at load and after a
// /resume replay, proving the component survives a large transcript.
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../tui/App.js";
import { messagesToTranscript } from "../tui/history-replay.js";
import { TuiStore } from "../tui/store.js";
import type { Message, ToolExecutionResult } from "../types.js";

const commands = [{ name: "help", description: "Show help" }];
const noop = () => {};

function fakeResult(name: string, formatted = "ok"): ToolExecutionResult {
  return { toolName: name, formatted, durationMs: 4 };
}

/** Run one full agent round through the store. */
function round(store: TuiStore, i: number): void {
  store.addUserMessage(`question ${i}`);
  store.setBusy(true);
  store.setSpinner("thinking");
  store.appendStreaming(`answer `);
  store.appendStreaming(`number ${i}`);
  store.commitStreaming();
  store.startTool("read", `file-${i}.ts`, `call-${i}`);
  store.finishTool(fakeResult("read", `content ${i}`), `file-${i}.ts`, `call-${i}`);
  store.addUsage(10, 5);
  store.setSpinner("idle");
  store.setBusy(false);
}

const ROUNDS = 30;

describe("TUI store over a long session", () => {
  it("grows the transcript by exactly 3 items per round, all ids unique", () => {
    const store = new TuiStore("deepseek/chat");
    for (let i = 0; i < ROUNDS; i++) round(store, i);
    const t = store.getSnapshot().transcript;
    expect(t).toHaveLength(ROUNDS * 3); // user + assistant + tool each round
    expect(new Set(t.map((x) => x.id)).size).toBe(ROUNDS * 3);
  });

  it("leaks no active tools after a long run", () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < ROUNDS; i++) round(store, i);
    expect(store.getSnapshot().activeTools).toEqual([]);
    expect(store.getSnapshot().busy).toBe(false);
    expect(store.getSnapshot().spinner).toBe("idle");
  });

  it("accumulates token totals exactly across the run", () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < ROUNDS; i++) round(store, i);
    expect(store.getSnapshot().tokensIn).toBe(ROUNDS * 10);
    expect(store.getSnapshot().tokensOut).toBe(ROUNDS * 5);
  });

  it("preserves transcript order (rounds appear in sequence)", () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < ROUNDS; i++) round(store, i);
    const users = store.getSnapshot().transcript.filter((x) => x.kind === "user");
    expect(users).toHaveLength(ROUNDS);
    expect((users[0] as any).text).toBe("question 0");
    expect((users.at(-1) as any).text).toBe(`question ${ROUNDS - 1}`);
  });

  it("interleaves concurrent tools across rounds without leaking", () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < ROUNDS; i++) {
      store.startTool("grep", `pat-${i}`, `g-${i}`);
      store.startTool("read", `f-${i}`, `r-${i}`);
      // Finish the second-started tool first (out of order).
      store.finishTool(fakeResult("read"), `f-${i}`, `r-${i}`);
      store.finishTool(fakeResult("grep"), `pat-${i}`, `g-${i}`);
    }
    expect(store.getSnapshot().activeTools).toEqual([]);
    expect(store.getSnapshot().transcript.filter((x) => x.kind === "tool")).toHaveLength(
      ROUNDS * 2,
    );
  });

  it("ignores empty streaming commits over the run", () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < ROUNDS; i++) {
      store.appendStreaming("   "); // whitespace only
      store.commitStreaming();
    }
    expect(store.getSnapshot().transcript).toHaveLength(0);
  });

  it("opens and resolves a permission overlay mid-session without losing history", async () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < 10; i++) round(store, i);
    const lenBefore = store.getSnapshot().transcript.length;

    const p = store.askPermission("Run bash?", "rm -rf ./build", "deletes the build dir");
    expect(store.getSnapshot().overlay?.kind).toBe("permission");
    const ov = store.getSnapshot().overlay!;
    if (ov.kind === "permission") ov.resolve("yes");
    await expect(p).resolves.toBe("yes");
    expect(store.getSnapshot().overlay).toBeNull();
    // History is untouched; the session can continue.
    expect(store.getSnapshot().transcript).toHaveLength(lenBefore);
    round(store, 99);
    expect(store.getSnapshot().transcript).toHaveLength(lenBefore + 3);
  });

  it("keeps ids unique across live rounds + a /resume replay", () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < 15; i++) round(store, i);
    store.loadTranscript([
      { kind: "user", text: "older question" } as any,
      { kind: "assistant", text: "older answer" } as any,
    ]);
    for (let i = 15; i < ROUNDS; i++) round(store, i);
    const ids = store.getSnapshot().transcript.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("notices and logs render alongside the round items", () => {
    const store = new TuiStore("p/m");
    round(store, 0);
    store.addNotice("sub-agent reading file…");
    store.addLog(["line 1", "line 2"]);
    const kinds = store.getSnapshot().transcript.map((x) => x.kind);
    expect(kinds).toContain("notice");
    expect(kinds).toContain("log");
  });
});

describe("App renders a long / resumed session", () => {
  it("renders a 30-round transcript without crashing and shows the latest turn", () => {
    const store = new TuiStore("deepseek/chat");
    for (let i = 0; i < ROUNDS; i++) round(store, i);
    const { lastFrame } = render(<App store={store} commands={commands} onSubmit={noop} />);
    const frame = lastFrame()!;
    // Check for content from the latest turn (model name may not be visible in frame)
    expect(frame).toContain(`question ${ROUNDS - 1}`);
    expect(frame).toContain(`answer number ${ROUNDS - 1}`);
  });

  it("renders a resumed conversation folded from saved messages", () => {
    // Build a 20-message saved conversation (10 user + 10 assistant turns).
    const convo: Message[] = [];
    for (let i = 0; i < 10; i++) {
      convo.push({ role: "user", content: [{ type: "text", text: `saved q${i}` }] });
      convo.push({ role: "assistant", content: `saved a${i}` });
    }
    const items = messagesToTranscript(convo);
    expect(items).toHaveLength(20);

    const store = new TuiStore("p/m");
    store.loadTranscript(items);
    expect(store.getSnapshot().transcript).toHaveLength(20);

    const { lastFrame } = render(<App store={store} commands={commands} onSubmit={noop} />);
    const frame = lastFrame()!;
    expect(frame).toContain("saved q0");
    expect(frame).toContain("saved a9");
  });

  it("clips a long tool result behind the ctrl+o hint (#45: no expandedId path)", () => {
    const store = new TuiStore("p/m");
    // A tool result long enough to be collapsed by default.
    const long = Array.from({ length: 40 }, (_, i) => `out ${i}`).join("\n");
    store.startTool("grep", "needle", "call-x");
    store.finishTool({ toolName: "grep", formatted: long, durationMs: 3 }, "needle", "call-x");
    const { lastFrame } = render(<App store={store} commands={commands} onSubmit={noop} />);
    // Collapsed preview: deep lines are hidden; the viewer hint points at
    // ctrl+o (the only full-output path since the dead expand mechanism went).
    expect(lastFrame()).not.toContain("out 39");
    expect(lastFrame()).toContain("ctrl+o to expand");
  });
});
