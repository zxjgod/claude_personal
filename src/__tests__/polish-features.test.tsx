// ============================================================
// Tests: Batch D — polish features (2026-09)
// ============================================================
// D1 spinner tips (rotation + 8s gate + todos suppression), D5 large-paste
// folding (chip build/expand + InputBox fold path), D6 transcript viewer
// completion (official footer, ctrl+e collapse toggle, search badge, q).
// ============================================================

import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { App, TipLine } from "../tui/App.js";
import { InputBox } from "../tui/InputBox.js";
import { setLanguage } from "../tui/i18n.js";
import {
  expandPastedChips,
  makePasteChip,
  PASTE_CHIP_RE,
  PASTE_FOLD_CHARS,
} from "../tui/paste-chip.js";
import { nextTipId, SPINNER_TIP_IDS } from "../tui/spinner-core.js";
import { TuiStore } from "../tui/store.js";

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("D1 — spinner tips", () => {
  beforeEach(() => setLanguage("en"));

  it("nextTipId never repeats within a session and exhausts to null", () => {
    const shown = new Set<string>();
    const seen: string[] = [];
    for (let i = 0; i < SPINNER_TIP_IDS.length; i++) {
      const id = nextTipId(shown);
      expect(id).not.toBeNull();
      seen.push(id!);
    }
    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(nextTipId(shown)).toBeNull(); // exhausted
  });

  it("TipLine stays hidden before 8s / with todos / no turn", async () => {
    const { lastFrame, unmount } = render(<TipLine turnStartedAt={Date.now() - 1000} todos={0} />);
    await flush();
    expect(lastFrame()!).not.toContain("Tip:");
    unmount();

    const todos = render(<TipLine turnStartedAt={Date.now() - 30_000} todos={2} />);
    await flush();
    expect(todos.lastFrame()!).not.toContain("Tip:"); // todos own the slot
    todos.unmount();

    const noTurn = render(<TipLine turnStartedAt={0} todos={0} />);
    await flush();
    expect(noTurn.lastFrame()!).toBe(""); // renders nothing at all
    noTurn.unmount();
  });

  it("TipLine shows a tip after the turn has run 8s+", async () => {
    const { lastFrame, unmount } = render(<TipLine turnStartedAt={Date.now() - 9000} todos={0} />);
    await new Promise((r) => setTimeout(r, 700)); // wait past the 500ms tick
    expect(lastFrame()).toContain("Tip:");
    unmount();
  });
});

describe("D5 — large-paste folding", () => {
  beforeEach(() => setLanguage("en"));

  it("chip helpers: build + expand round-trip, unknown ids stay literal", () => {
    const store = new Map<number, string>([[1, "line one\nline two\nline three"]]);
    const chip = makePasteChip(1, 3);
    expect(chip).toBe("[Pasted text #1 +3 lines]");
    expect(PASTE_CHIP_RE.test(chip)).toBe(true);
    expect(expandPastedChips(`see:\n${chip}`, store)).toBe("see:\nline one\nline two\nline three");
    // Unknown id: literal, never invented.
    expect(expandPastedChips("[Pasted text #99 +5 lines]", store)).toBe(
      "[Pasted text #99 +5 lines]",
    );
  });

  it("InputBox folds an oversized paste into the chip (not the raw text)", async () => {
    const big = `${"x".repeat(PASTE_FOLD_CHARS + 50)}`;
    const chips: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={() => {}}
        onLargePaste={(content) => {
          const chip = makePasteChip(chips.length + 1, content.split("\n").length);
          chips.push(chip);
          return chip;
        }}
      />,
    );
    await flush();
    // Bracketed paste of the oversized payload.
    stdin.write(`\x1b[200~${big}\x1b[201~`);
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("[Pasted text #1 +1 lines]");
    expect(frame).not.toContain("xxxx"); // raw wall never lands in the buffer
    unmount();
  });

  it("pastes below the threshold still land raw", async () => {
    const small = "just a snippet";
    const { lastFrame, stdin, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={() => {}}
        onLargePaste={() => {
          throw new Error("must not fold");
        }}
      />,
    );
    await flush();
    stdin.write(`\x1b[200~${small}\x1b[201~`);
    await flush();
    expect(lastFrame()).toContain("just a snippet");
    unmount();
  });
});

describe("D6 — transcript viewer completion", () => {
  beforeEach(() => setLanguage("en"));

  function reviewingStore() {
    const store = new TuiStore("p/m");
    store.setReviewing(true);
    store.addUserMessage("hello world");
    return store;
  }

  it("footer carries the official phrasing with the dynamic ctrl+e action", async () => {
    const store = reviewingStore();
    const { lastFrame, unmount } = render(
      <App store={store} commands={[]} onSubmit={() => {}} expandedId={null} />,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Showing detailed transcript");
    expect(frame).toContain("ctrl+o to toggle");
    // The action word survives any wrap position: verbose default ⇒ collapse.
    expect(frame).toContain("collapse");
    expect(frame).not.toContain("expand");
    unmount();
  });

  it("ctrl+e flips the footer action to expand", async () => {
    const store = reviewingStore();
    const { lastFrame, stdin, unmount } = render(
      <App store={store} commands={[]} onSubmit={() => {}} expandedId={null} />,
    );
    await flush();
    expect(lastFrame()).toContain("collapse");
    stdin.write("\x05"); // ctrl+e
    await flush();
    const after = lastFrame()!;
    expect(after).toContain("expand");
    expect(after).not.toContain("collapse"); // the action word flipped
    unmount();
  });

  it("search shows the (current/count) badge after Enter", async () => {
    const store = reviewingStore();
    store.addUserMessage("hello again");
    const { lastFrame, stdin, unmount } = render(
      <App store={store} commands={[]} onSubmit={() => {}} expandedId={null} />,
    );
    await flush();
    stdin.write("/");
    await flush();
    stdin.write("hello");
    await flush();
    stdin.write("\r"); // commit the search — jumps to the first match
    await flush();
    expect(lastFrame()!).not.toContain("(1/"); // committed search leaves the
    // editing line; the badge shows while TYPING the query:
    unmount();
    const store2 = reviewingStore();
    store2.addUserMessage("hello again");
    const two = render(<App store={store2} commands={[]} onSubmit={() => {}} expandedId={null} />);
    await flush();
    two.stdin.write("/");
    await flush();
    two.stdin.write("hello");
    await flush();
    expect(two.lastFrame()).toMatch(/\(1\/2\)/); // live badge while typing
    two.unmount();
  });

  it("q still closes the viewer (less-style)", async () => {
    const store = reviewingStore();
    const { lastFrame, stdin, unmount } = render(
      <App store={store} commands={[]} onSubmit={() => {}} expandedId={null} />,
    );
    await flush();
    expect(store.getSnapshot().reviewing).toBe(true);
    stdin.write("q");
    await flush();
    expect(store.getSnapshot().reviewing).toBe(false);
    expect(lastFrame()).toContain("? for shortcuts"); // back to the live UI
    unmount();
  });
});
