// ============================================================
// Tests: Batch B — official input behaviors (2026-09)
// ============================================================
// Covers the B1–B8 surface at the component/store level: bash & memory
// echo markers, inline reverse-i-search, stash round-trip, queue recall +
// dim queue list, the exit-hint footer priority, todos collapse with the
// "Next:" line, the model-picker overlay, and the inputAction dispatch
// pipeline.
// ============================================================

import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputBox } from "../tui/InputBox.js";
import { setLanguage } from "../tui/i18n.js";
import { InputQueue } from "../tui/input-queue.js";
import { ModelPicker } from "../tui/ModelPicker.js";
import { PromptFooter } from "../tui/PromptFooter.js";
import { QueuedMessages } from "../tui/QueuedMessages.js";
import { TuiStore } from "../tui/store.js";
import { TodoList } from "../tui/TodoList.js";

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("Batch B — inputAction dispatch pipeline", () => {
  beforeEach(() => setLanguage("en"));

  it("clear action empties the buffer via pendingAction", async () => {
    const submitted: string[] = [];
    const { lastFrame, rerender, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={(v) => submitted.push(v)}
        initialDraft={{ text: "draft text", cursor: 10 }}
      />,
    );
    await flush();
    expect(lastFrame()).toContain("draft text");
    rerender(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={(v) => submitted.push(v)}
        initialDraft={{ text: "draft text", cursor: 10 }}
        pendingAction={{ kind: "clear", seq: 1 }}
      />,
    );
    await flush();
    expect(lastFrame()!).not.toContain("draft text");
    unmount();
  });

  it("stash saves the draft, second press on empty restores it", async () => {
    const submitted: string[] = [];
    const props = {
      commands: [] as never[],
      disabled: false,
      onSubmit: (v: string) => submitted.push(v),
    };
    const { lastFrame, rerender, unmount } = render(
      <InputBox {...props} initialDraft={{ text: "keep me", cursor: 7 }} />,
    );
    await flush();
    rerender(
      <InputBox
        {...props}
        initialDraft={{ text: "keep me", cursor: 7 }}
        pendingAction={{ kind: "stash", seq: 1 }}
      />,
    );
    await flush();
    expect(lastFrame()).toContain("stashed");
    expect(lastFrame()!).not.toContain("keep me");
    // The paste note clears on next keypress; stash#2 with an empty buffer restores.
    rerender(<InputBox {...props} pendingAction={{ kind: "stash", seq: 2 }} />);
    await flush();
    expect(lastFrame()).toContain("keep me");
    expect(lastFrame()).toContain("restored");
    unmount();
  });
});

describe("Batch B — inline reverse-i-search (ctrl+r)", () => {
  beforeEach(() => setLanguage("en"));

  it("types a query, matches newest-first, Enter runs the match", async () => {
    const submitted: string[] = [];
    const history = ["npm test", "npm run build", "git status"];
    // Ctrl+R arrives as a hotkey → store.dispatchInputAction; drive the same
    // entry point the hotkey uses (pendingAction prop) directly. The action
    // must arrive AFTER mount — a mount-time pendingAction is deliberately
    // ignored (remounts must not replay the store's last consumed action).
    const baseProps = {
      commands: [] as never[],
      disabled: false,
      onSubmit: (v: string) => submitted.push(v),
      history,
    };
    const two = render(<InputBox {...baseProps} />);
    await flush();
    two.rerender(<InputBox {...baseProps} pendingAction={{ kind: "historySearch", seq: 1 }} />);
    await flush();
    expect(two.lastFrame()).toContain("reverse-i-search");
    two.stdin.write("npm");
    await flush();
    // Newest npm-* entry first.
    expect(two.lastFrame()).toContain("npm run build");
    two.stdin.write("\r"); // Enter accepts AND runs
    await flush();
    expect(submitted).toEqual(["npm run build"]);
    two.unmount();
  });

  it("Esc accepts the match into the buffer without submitting", async () => {
    const submitted: string[] = [];
    const baseProps = {
      commands: [] as never[],
      disabled: false,
      onSubmit: (v: string) => submitted.push(v),
      history: ["alpha", "beta gamma"],
    };
    const { lastFrame, stdin, rerender, unmount } = render(<InputBox {...baseProps} />);
    await flush();
    rerender(<InputBox {...baseProps} pendingAction={{ kind: "historySearch", seq: 1 }} />);
    await flush();
    stdin.write("beta");
    await flush();
    stdin.write("\x1b"); // Esc
    await flush();
    expect(submitted).toEqual([]); // not run
    expect(lastFrame()).toContain("beta gamma"); // accepted into the buffer
    unmount();
  });

  it("reports empty history without opening", async () => {
    const baseProps = {
      commands: [] as never[],
      disabled: false,
      onSubmit: () => {},
      history: [] as string[],
    };
    const { lastFrame, rerender, unmount } = render(<InputBox {...baseProps} />);
    await flush();
    rerender(<InputBox {...baseProps} pendingAction={{ kind: "historySearch", seq: 1 }} />);
    await flush();
    expect(lastFrame()).toContain("nothing to search");
    unmount();
  });
});

describe("Review fixes — ghost actions & ↑↓ priority (2026-09-07)", () => {
  beforeEach(() => setLanguage("en"));

  it("a mount-time pendingAction is NOT replayed (ghost-action regression)", async () => {
    // Production: the store's inputAction survives across overlay open/close,
    // which unmounts/remounts InputBox. A mount-time pendingAction is residue,
    // not a fresh dispatch — the component must ignore it.
    const props = {
      commands: [] as never[],
      disabled: false,
      onSubmit: () => {},
      initialDraft: { text: "keep this draft", cursor: 15 },
    };
    const first = render(<InputBox {...props} />);
    await flush();
    // Dispatch the clear action post-mount (as the hotkey would): fires once.
    first.rerender(<InputBox {...props} pendingAction={{ kind: "clear", seq: 1 }} />);
    await flush();
    expect(first.lastFrame()!).not.toContain("keep this draft");
    first.unmount();
    // Re-edit, then remount with the SAME residue still sitting in the prop —
    // the old bug re-ran `clear` here and wiped the new draft.
    const second = render(
      <InputBox
        {...props}
        initialDraft={{ text: "second draft", cursor: 12 }}
        pendingAction={{ kind: "clear", seq: 1 }}
      />,
    );
    await flush();
    expect(second.lastFrame()).toContain("second draft");
    second.unmount();
  });

  it("↑ stays in a multi-line draft even at the first row", async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={onSubmit}
        history={["old-command"]}
        initialDraft={{ text: "first line\nsecond line", cursor: 22 }}
      />,
    );
    await flush();
    stdin.write("\x1b[A"); // ↑ — cursor is on row 1, must stay in the draft
    await flush();
    expect(lastFrame()).toContain("second line");
    expect(lastFrame()).not.toContain("old-command");
    // At row 0, another Up must leave the draft and cursor intact.
    stdin.write("\x1b[A");
    await flush();
    expect(lastFrame()).not.toContain("old-command");
    stdin.write("X");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("first lineX\nsecond line");
    unmount();
  });

  it("↓ moves a recalled multi-line message's cursor and stops at the last row", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={onSubmit}
        history={["older", "abc\ndef"]}
      />,
    );
    await flush();
    stdin.write("\x1b[A");
    await flush();
    stdin.write("\x1b[A");
    await flush();
    stdin.write("\x1b[B");
    await flush();
    stdin.write("\x1b[B");
    await flush();
    stdin.write("X");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("abc\ndefX");
    unmount();
  });

  it("mid-search ctrl+r cycles instead of resetting the query", async () => {
    const baseProps = {
      commands: [] as never[],
      disabled: false,
      onSubmit: () => {},
      history: ["npm test", "npm run build", "npm run lint"],
    };
    const { lastFrame, stdin, rerender, unmount } = render(<InputBox {...baseProps} />);
    await flush();
    rerender(<InputBox {...baseProps} pendingAction={{ kind: "historySearch", seq: 1 }} />);
    await flush();
    stdin.write("npm run");
    await flush();
    expect(lastFrame()).toContain("npm run lint"); // newest match first
    // The hotkey re-dispatch (seq 2) arrives as the in-search ctrl+r cycles.
    stdin.write("\x12"); // ctrl+r inside the search box
    rerender(<InputBox {...baseProps} pendingAction={{ kind: "historySearch", seq: 2 }} />);
    await flush();
    // Query must survive the re-dispatch; idx advanced to the older match.
    expect(lastFrame()).toContain("npm run build");
    unmount();
  });
});

describe("Batch B — bash & memory echo markers", () => {
  beforeEach(() => setLanguage("en"));

  it("store flags ride the user transcript item", () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("npm test", { bash: true });
    store.addUserMessage("prefer tabs", { memory: true });
    const items = store.getSnapshot().transcript;
    expect(items[0]).toMatchObject({ kind: "user", bash: true });
    expect(items[1]).toMatchObject({ kind: "user", memory: true });
  });

  it("bash-mode prompt shows the pink ! marker and hides the raw prefix", async () => {
    const { lastFrame, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={() => {}}
        initialDraft={{ text: "!echo hi", cursor: 8 }}
      />,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("! echo hi");
    expect(frame).not.toContain("! !echo");
    unmount();
  });

  it("memory-mode prompt shows the blue # marker", async () => {
    const { lastFrame, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={() => {}}
        initialDraft={{ text: "#remember this", cursor: 14 }}
      />,
    );
    await flush();
    expect(lastFrame()).toContain("# remember this");
    unmount();
  });
});

describe("Batch B — queue visualization (B6)", () => {
  beforeEach(() => setLanguage("en"));

  it("QueuedMessages renders dim messages with the ! marker for bash lines", () => {
    const { lastFrame, unmount } = render(
      <QueuedMessages messages={["first", "!ls -la", "third", "fourth"]} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("> first");
    expect(frame).toContain("! ls -la");
    expect(frame).toContain("+1"); // overflow beyond MAX_SHOWN=3
    unmount();
  });

  it("Up from an empty buffer recalls the newest queued message", async () => {
    const submitted: string[] = [];
    const pop = vi.fn(() => "queued line");
    const { lastFrame, stdin, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        busy
        onSubmit={(v) => submitted.push(v)}
        onQueuePop={pop}
      />,
    );
    await flush();
    stdin.write("\x1b[A"); // ↑
    await flush();
    expect(pop).toHaveBeenCalled();
    expect(lastFrame()).toContain("queued line");
    unmount();
  });

  it("InputQueue.popLast removes the newest item; snapshot mirrors contents", () => {
    const q = new InputQueue();
    q.push("a");
    q.push("b");
    q.push("c");
    expect(q.snapshot()).toEqual(["a", "b", "c"]);
    expect(q.popLast()).toBe("c");
    expect(q.snapshot()).toEqual(["a", "b"]);
    expect(q.popLast()).toBe("b");
    expect(q.popLast()).toBe("a");
    expect(q.popLast()).toBeNull();
  });
});

describe("Batch B — exit hint & todos collapse (B4/B5)", () => {
  beforeEach(() => setLanguage("en"));

  it("footer shows 'Press ctrl+c again to exit' above all other hints", async () => {
    const store = new TuiStore("p/m");
    store.setPermissionMode("plan");
    store.setBusy(true);
    store.armExitHint();
    const { lastFrame, unmount } = render(<PromptFooter store={store} />);
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Press ctrl+c again to exit");
    expect(frame).not.toContain("esc to interrupt");
    expect(frame).not.toContain("plan mode on");
    unmount();
  });

  it("todosCollapsed hides the list and the store toggles it", () => {
    const store = new TuiStore("p/m");
    expect(store.getSnapshot().todosCollapsed).toBe(false);
    store.toggleTodosCollapsed();
    expect(store.getSnapshot().todosCollapsed).toBe(true);
  });

  it("TodoList still renders when not collapsed (regression)", () => {
    const { lastFrame, unmount } = render(
      <TodoList todos={[{ content: "task a", status: "pending" }]} />,
    );
    expect(lastFrame()).toContain("task a");
    unmount();
  });
});

describe("Batch B — model picker overlay (B8)", () => {
  beforeEach(() => setLanguage("en"));

  function makeOverlay() {
    let resolve: (m: string | null) => void = () => {};
    const done = new Promise<string | null>((r) => (resolve = r));
    return {
      overlay: {
        kind: "modelPicker" as const,
        items: [
          { name: "m-current", label: "prov/m-current", current: true },
          { name: "m-alt", label: "prov/m-alt", current: false },
        ],
        resolve,
      },
      done,
    };
  }

  it("lists models with the current one marked, Enter resolves the selection", async () => {
    const { overlay, done } = makeOverlay();
    const { lastFrame, stdin, unmount } = render(<ModelPicker overlay={overlay} />);
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("m-current");
    expect(frame).toContain("m-alt");
    stdin.write("\x1b[B"); // ↓ to the second row
    await flush();
    stdin.write("\r");
    await expect(done).resolves.toBe("m-alt");
    unmount();
  });

  it("Esc resolves null (cancel)", async () => {
    const { overlay, done } = makeOverlay();
    const { stdin, unmount } = render(<ModelPicker overlay={overlay} />);
    await flush();
    stdin.write("\x1b");
    await expect(done).resolves.toBeNull();
    unmount();
  });

  it("askModelPicker threads through the store's overlay pipeline", async () => {
    const store = new TuiStore("p/m");
    const p = store.askModelPicker([{ name: "x", label: "p/x", current: false }]);
    expect(store.getSnapshot().overlay?.kind).toBe("modelPicker");
    store.getSnapshot().overlay?.kind === "modelPicker" &&
      (
        store.getSnapshot().overlay as Extract<
          { kind: "modelPicker"; resolve: (m: string | null) => void },
          { kind: "modelPicker" }
        >
      ).resolve("x");
    await expect(p).resolves.toBe("x");
    expect(store.getSnapshot().overlay).toBeNull();
  });
});
