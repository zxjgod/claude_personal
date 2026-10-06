// ============================================================
// Tests: ScrollView windowing + full-screen layout (M25.2)
// ============================================================

import { render } from "ink-testing-library";
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "../tui/App.js";
import { BLACK_CIRCLE } from "../tui/figures.js";
import { setLanguage, t } from "../tui/i18n.js";
import { bottomScrollTop, clampScrollTop, ScrollView, visibleWindow } from "../tui/ScrollView.js";
import type { TranscriptItem } from "../tui/store.js";
import { TuiStore } from "../tui/store.js";
import { terminalColumns, visualWidth } from "../tui/terminal-width.js";
import { transcriptToLines } from "../tui/transcript-lines.js";

// Pin the UI language so literal-string assertions hold on zh-locale machines.
beforeAll(() => setLanguage("en"));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

describe("ScrollView windowing math", () => {
  it("visibleWindow returns the slice for a given scrollTop", () => {
    // 100 lines, viewport 10, scrolled to 30 → rows [30, 40).
    expect(visibleWindow(100, 10, 30)).toEqual({ start: 30, end: 40 });
  });

  it("visibleWindow clamps scrollTop past the bottom", () => {
    // 100 lines, viewport 10 → max top is 90. Asking for 200 clamps to 90.
    expect(visibleWindow(100, 10, 200)).toEqual({ start: 90, end: 100 });
  });

  it("visibleWindow handles content shorter than the viewport", () => {
    expect(visibleWindow(3, 10, 0)).toEqual({ start: 0, end: 3 });
  });

  it("clampScrollTop bounds into [0, maxTop]", () => {
    expect(clampScrollTop(100, 10, -5)).toBe(0);
    expect(clampScrollTop(100, 10, 50)).toBe(50);
    expect(clampScrollTop(100, 10, 999)).toBe(90);
  });

  it("bottomScrollTop pins to the last viewport-height of content", () => {
    expect(bottomScrollTop(100, 10)).toBe(90);
    expect(bottomScrollTop(5, 10)).toBe(0); // fits → no scroll
  });
});

describe("ScrollView rendering", () => {
  it("renders only the visible window of lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<ScrollView lines={lines} fallbackHeight={5} scrollTop={10} />);
    const frame = lastFrame()!;
    expect(frame).toContain("line-10");
    expect(frame).toContain("line-14");
    expect(frame).not.toContain("line-9");
    expect(frame).not.toContain("line-15");
  });

  it("pads short content to the fixed viewport height", () => {
    const { lastFrame } = render(<ScrollView lines={["only"]} fallbackHeight={5} scrollTop={0} />);
    // 5 rows tall even with one line of content (4 padding rows).
    expect(lastFrame()!.split("\n").length).toBe(5);
  });
});

describe("transcriptToLines", () => {
  it("wraps long user messages into full-width background rows without losing text", () => {
    const columns = process.stdout.columns;
    try {
      process.stdout.columns = 24;
      const text = "中文测试😀".repeat(8);
      const lines = transcriptToLines([{ kind: "user", id: 1, text }], "");
      const rows = lines.filter((line) => line.backgroundColor);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((line) => visualWidth(line.text) === 23)).toBe(true);
      expect(rows.map((line) => line.text.slice(2).trimEnd()).join("")).toBe(text);
      expect(rows.filter((line) => line.role === "user")).toHaveLength(1);
    } finally {
      process.stdout.columns = columns;
    }
  });

  it("uses the same bullet and body indent for committed and streamed replies", () => {
    const text = "first line\nsecond line";
    const committed = transcriptToLines([{ kind: "assistant", id: 1, text }], "");
    const streaming = transcriptToLines([], text);
    expect(committed.slice(0, -1)).toEqual(streaming);
    expect(streaming.map((line) => line.text)).toEqual([
      `${BLACK_CIRCLE} first line`,
      "  second line",
    ]);
  });

  it("flattens user / assistant / tool items to text rows", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: 1, text: "hello" },
      { kind: "assistant", id: 2, text: "hi there" },
      {
        kind: "tool",
        id: 3,
        name: "read",
        detail: "a.ts",
        result: { toolName: "read", formatted: "file body", error: undefined } as never,
      },
    ];
    const lines = transcriptToLines(items, "");
    expect(lines[0]!.text.trimEnd()).toBe("> hello");
    expect(visualWidth(lines[0]!.text)).toBe(terminalColumns() - 1);
    expect(lines.some((l) => l.text.includes("hi there"))).toBe(true);
    expect(lines.some((l) => l.text.includes("Read") && l.text.includes("a.ts"))).toBe(true);
    expect(lines.some((l) => l.text.includes("file body"))).toBe(true);
  });

  it("appends the in-flight streaming text as an assistant block", () => {
    const lines = transcriptToLines([], "streaming now");
    expect(lines.some((l) => l.text.includes("streaming now"))).toBe(true);
  });

  it("styles rows by role: white user on gray, neutral tool body, muted notices", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: 1, text: "hello" },
      {
        kind: "tool",
        id: 2,
        name: "read",
        detail: "a.ts",
        result: { toolName: "read", formatted: "file body", error: undefined } as never,
      },
      { kind: "notice", id: 3, text: "system note" },
    ];
    const lines = transcriptToLines(items, "thinking…", "reasoning line");
    const user = lines.find((l) => l.text.trimEnd() === "> hello")!;
    expect(user.dim).toBeUndefined();
    expect(user.color).toBe("#ffffff");
    expect(user.backgroundColor).toBe("#383838");
    const head = lines.find((l) => l.text.startsWith(`${BLACK_CIRCLE} Read`))!;
    expect(head.color).toBeUndefined(); // official: no accent tint on the head
    const body = lines.find((l) => l.text.includes("file body"))!;
    expect(body.color).toBe("#d4d4d4");
    expect(body.dim).toBeUndefined();
    const notice = lines.find((l) => l.text === "system note")!;
    expect(notice.dim).toBe(true);
    const think = lines.find((l) => l.text.includes("reasoning line"))!;
    expect(think.dim).toBe(true);
  });

  it("colors tool errors red", () => {
    const items: TranscriptItem[] = [
      {
        kind: "tool",
        id: 1,
        name: "bash",
        detail: "npm test",
        result: { toolName: "bash", formatted: "", error: "exit 1" } as never,
      },
    ];
    const lines = transcriptToLines(items, "");
    const err = lines.find((l) => l.text.includes("exit 1"))!;
    expect(err.color).toBe("#f7768e"); // palette.error
  });
});

describe("full-screen App scrolling (M25.2 fix)", () => {
  function bigStore(): TuiStore {
    const store = new TuiStore("test/model");
    // Push enough rows to overflow the default 24-row test viewport.
    for (let i = 0; i < 40; i++) {
      store.addUserMessage(`line ${i}`);
    }
    return store;
  }

  it("starts pinned to the bottom (latest content visible)", async () => {
    const store = bigStore();
    const { lastFrame } = render(
      <App
        store={store}
        commands={[{ name: "help", description: "h" }]}
        onSubmit={() => {}}
        fullscreen
      />,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("line 39"); // newest visible
    expect(frame).not.toContain("line 0"); // oldest scrolled off
  });

  it("renders the input prompt as the LAST line (cursor must not drift below it)", async () => {
    const store = bigStore();
    const { lastFrame } = render(
      <App
        store={store}
        commands={[{ name: "help", description: "h" }]}
        onSubmit={() => {}}
        fullscreen
      />,
    );
    await flush();
    const rows = lastFrame()!.split("\n");
    // The terminal parks the real cursor at the end of the final rendered row,
    // so the prompt ("❯ …" under the rounded top border) must be that row —
    // otherwise the cursor blinks one line too low (the original bug).
    const last = rows[rows.length - 1]!;
    expect(last.trimStart().startsWith(">")).toBe(true);
  });

  it("PgUp scrolls up to reveal earlier lines; PgDn returns toward bottom", async () => {
    const store = bigStore();
    const { stdin, lastFrame } = render(
      <App
        store={store}
        commands={[{ name: "help", description: "h" }]}
        onSubmit={() => {}}
        fullscreen
      />,
    );
    await flush();
    // Scroll up several half-pages — earlier lines should appear, newest leaves.
    // (PgUp/PgDn, not ↑↓/Ctrl+U/D: those belong to the InputBox's history /
    // delete-to-line-start, and binding them here too made one keypress both
    // scroll and edit the buffer.)
    for (let i = 0; i < 6; i++) {
      stdin.write(PAGE_UP);
      await flush();
    }
    const scrolled = lastFrame()!;
    expect(scrolled).toContain("line 0"); // earlier content now visible
    expect(scrolled).not.toContain("line 39"); // newest scrolled off
    // The "scrolled" hint replaces the live status line.
    expect(scrolled).toContain(t("ui.fs.scrolled"));

    // Scroll back down to the bottom — newest content returns.
    for (let i = 0; i < 8; i++) {
      stdin.write(PAGE_DOWN);
      await flush();
    }
    expect(lastFrame()!).toContain("line 39");
  });
});
