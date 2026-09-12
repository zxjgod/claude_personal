// ============================================================
// Tests: TUI React components (ink-testing-library)
// ============================================================
// Renders components to a virtual terminal and asserts on the frame text.
// Verifies the App shell, tool cards (incl. collapse), and prompt overlays
// render without crashing and show the right content.
// ============================================================

import { render } from "ink-testing-library";
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "../tui/App.js";
import { CommandPicker } from "../tui/CommandPicker.js";
import { EffortPrompt } from "../tui/EffortPrompt.js";
import { setLanguage } from "../tui/i18n.js";
import { PermissionPrompt, QuestionPrompt } from "../tui/Prompts.js";
import { nextOffset, SessionPicker } from "../tui/SessionPicker.js";
import { TuiStore } from "../tui/store.js";
import { CompletedToolCard, isToolExpandable } from "../tui/ToolCard.js";

// Pin the UI language so literal-string assertions hold on zh-locale machines.
beforeAll(() => setLanguage("en"));

import type { ToolExecutionResult } from "../types.js";

const noopSubmit = () => {};
const commands = [{ name: "help", description: "Show help" }];

/**
 * Poll `cond` until it holds or `timeoutMs` elapses. Ink dispatches stdin on a
 * later tick, so asserting straight after `stdin.write` is a bet on scheduling
 * — one that loses under full-suite parallel load (this file alone takes ~14s).
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("App", () => {
  it("renders the official prompt footer fallback hint when idle (default mode)", () => {
    const store = new TuiStore("deepseek/chat");
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    // Official footer: default mode shows no mode badge — the fallback hint
    // "? for shortcuts" owns the left column; model sits on the right.
    expect(lastFrame()).toContain("? for shortcuts");
    expect(lastFrame()).toContain("deepseek/chat");
  });

  it("shows the official mode indicator in the footer for non-default modes", () => {
    const store = new TuiStore("p/m");
    store.setPermissionMode("plan");
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    expect(lastFrame()).toContain("⏸ plan mode on");
    expect(lastFrame()).toContain("(shift+tab to cycle)");
  });

  it("renders committed transcript items", () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("hello there");
    store.appendStreaming("hi back");
    store.commitStreaming();
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("hello there");
    expect(frame).toContain("hi back");
  });

  it("shows a working hint while busy", () => {
    const store = new TuiStore("p/m");
    store.setBusy(true);
    store.setSpinner("thinking");
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    // Official footer hint while loading, plus the thinking-phase verb line.
    expect(lastFrame()).toContain("esc to interrupt");
  });

  it("pins the live todo list under the status line (⎿ connector)", () => {
    const store = new TuiStore("p/m");
    store.setBusy(true);
    store.setSpinner("thinking");
    store.setTodos([
      { content: "研究三大机制", status: "completed" },
      { content: "编写原理文档", status: "in_progress", activeForm: "编写原理文档" },
      { content: "实现 mini-agent", status: "pending" },
    ]);
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    const frame = lastFrame()!;
    // First row hangs off the status line via the ⎿ connector.
    expect(frame).toContain("⎿");
    expect(frame).toContain("☑ 研究三大机制");
    expect(frame).toContain("■ 编写原理文档");
    expect(frame).toContain("□ 实现 mini-agent");
  });

  it("hides the todo region when the list is empty", () => {
    const store = new TuiStore("p/m");
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    expect(lastFrame()).not.toContain("⎿");
  });

  // Regression cover for the frame-leak bug: a live frame taller than the
  // terminal breaks Ink's erase math and leaks the frame's top line into the
  // scrollback on every redraw (the "● line repeated 50×" symptom). The stream
  // regions must window themselves so the frame never exceeds the viewport
  // (ink-testing-library falls back to 80×24, so the budget is 24 rows).
  it("windows a very long streaming reply so the frame stays within 24 rows", () => {
    const store = new TuiStore("p/m");
    store.setBusy(true);
    store.setSpinner("responding");
    // ~60 visual lines at 80 cols — far taller than the 24-row viewport.
    store.appendStreaming(
      "I'll conduct a comprehensive code review. ".repeat(6) +
        "\n" +
        Array.from({ length: 40 }, (_, i) => `finding ${i}: the agent loop handles this path`).join(
          "\n",
        ),
    );
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    const frame = lastFrame()!;
    const lineCount = frame.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(24);
    expect(frame).toContain("lines above elided"); // i18n elision hint (en)
    expect(frame).toContain("finding 39"); // the live tail stays visible
    expect(frame).not.toContain("finding 0"); // scrolled-off head is hidden
  });

  it("windows a very long thinking stream the same way", () => {
    const store = new TuiStore("p/m");
    store.setBusy(true);
    store.setSpinner("thinking");
    store.appendStreaming(""); // keep text empty; thinking is the live region
    store.appendThinking(
      Array.from({ length: 40 }, (_, i) => `reasoning step ${i} about the codebase`).join("\n"),
    );
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    const frame = lastFrame()!;
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
    expect(frame).toContain("earlier thinking lines elided"); // i18n hint (en)
    expect(frame).toContain("reasoning step 39");
    expect(frame).not.toContain("reasoning step 0");
  });

  it("windows a long todo list around the in_progress item (not the head)", () => {
    const store = new TuiStore("p/m");
    // 7 items, the ACTIVE one deep in the list — a head-slice would hide it.
    store.setTodos(
      Array.from({ length: 7 }, (_, i) => ({
        content: `task ${i}`,
        status: (i === 5 ? "in_progress" : "pending") as "in_progress" | "pending",
      })),
    );
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("task 5"); // the active task is always visible
    expect(frame).toContain("■ task 5");
    expect(frame).not.toContain("task 0"); // windowed off
    expect(frame).toContain("↑ "); // overflow indicator above
  });

  it("shows the head of an all-pending todo list with a below-overflow row", () => {
    const store = new TuiStore("p/m");
    store.setTodos(
      Array.from({ length: 7 }, (_, i) => ({
        content: `task ${i}`,
        status: "pending" as const,
      })),
    );
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("task 0");
    expect(frame).toContain("task 3");
    expect(frame).not.toContain("task 4"); // beyond the window
    expect(frame).toMatch(/↓.*3 more/);
  });

  it("caps concurrent active tool cards with an overflow line", () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < 5; i++) store.startTool("read", `file-${i}.ts`, `c${i}`);
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("file-0.ts");
    expect(frame).toContain("file-2.ts");
    expect(frame).not.toContain("file-3.ts"); // beyond the 3-card window
    expect(frame).toContain("+2 more running");
  });

  it("PgUp opens the transcript review pager (and swaps out the input box)", async () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("old question");
    const { stdin, lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\x1b[5~"); // PgUp
    await waitFor(() => store.getSnapshot().reviewing === true);

    expect(store.getSnapshot().reviewing).toBe(true);
    const frame = lastFrame()!;
    expect(frame).toContain("Transcript —");
    expect(frame).toContain("old question");
    // P0-1: verbose viewer footer advertises search/jump/editor/close keys.
    expect(frame).toContain("Showing detailed transcript"); // D6 official footer
  });

  it("keeps the Static transcript MOUNTED while reviewing (no reprint on exit)", async () => {
    // Regression cover for P2: Ink's <Static> restarts its emitted-index at 0
    // on remount — unmounting it while the pager is open would reprint the
    // entire transcript into the terminal when the pager closes. The review
    // body must keep TranscriptRegion mounted alongside the pager.
    const store = new TuiStore("p/m");
    store.addUserMessage("old question");
    const { stdin, lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\x1b[5~"); // PgUp → reviewing
    await new Promise((r) => setTimeout(r, 10));

    // Static region AND pager both render the message → mounted twice.
    const during = lastFrame()!;
    expect(during).toContain("Transcript —");
    expect(during.split("old question").length - 1).toBe(2);

    stdin.write("q"); // close pager
    await new Promise((r) => setTimeout(r, 10));
    const after = lastFrame()!;
    expect(after).not.toContain("Transcript —");
    expect(after.split("old question").length - 1).toBe(1); // single Static copy
  });
});

describe("CompletedToolCard collapse (9.4)", () => {
  const longResult: ToolExecutionResult = {
    toolName: "grep",
    formatted: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    durationMs: 3,
  };

  it("collapses long output with an expand hint", () => {
    const { lastFrame } = render(
      <CompletedToolCard result={longResult} detail="foo" expanded={false} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).not.toContain("line 20"); // beyond preview window
  });

  it("shows all lines when expanded", () => {
    const { lastFrame } = render(
      <CompletedToolCard result={longResult} detail="foo" expanded={true} />,
    );
    expect(lastFrame()).toContain("line 29");
  });

  it("renders errors in the branch", () => {
    const errResult: ToolExecutionResult = {
      toolName: "edit",
      formatted: "",
      error: "old_string not found",
    };
    const { lastFrame } = render(
      <CompletedToolCard result={errResult} detail="a.ts" expanded={false} />,
    );
    expect(lastFrame()).toContain("old_string not found");
  });

  it("isToolExpandable mirrors the collapse rule (expandable-target finding)", () => {
    const shortResult: ToolExecutionResult = { toolName: "bash", formatted: "ok", durationMs: 1 };
    const summaryResult: ToolExecutionResult = {
      toolName: "read",
      formatted: `${"x\n".repeat(40)}file content`,
      durationMs: 2,
      result: { metadata: { summary: "Read 41 lines" } },
    } as unknown as ToolExecutionResult;
    const errResult: ToolExecutionResult = {
      toolName: "edit",
      formatted: "",
      error: "boom",
    };
    expect(isToolExpandable(longResult)).toBe(true); // clipped preview
    expect(isToolExpandable(summaryResult)).toBe(true); // summary-collapsed
    expect(isToolExpandable(shortResult)).toBe(false); // nothing hidden
    expect(isToolExpandable(errResult)).toBe(false); // errors have no content
  });

  it("renders a transcript tool item's own expanded flag (expanded flag copy)", () => {
    // store.expandTool appends an expanded COPY of the collapsed card; the
    // App renders it fully expanded with no expandedId prop involved.
    const store = new TuiStore("p/m");
    store.startTool("grep", "foo", "c1");
    store.finishTool(longResult, "foo", "c1");
    const collapsedId = store.getSnapshot().transcript.at(-1)!.id;
    store.expandTool(collapsedId);
    const { lastFrame } = render(<App store={store} commands={commands} onSubmit={noopSubmit} />);
    const frame = lastFrame()!;
    // Collapsed original (clipped at 12 lines) and the expanded copy (full).
    expect(frame).toContain("ctrl+o to expand");
    expect(frame).toContain("line 29"); // only the expanded copy shows this
  });
});

describe("Prompts", () => {
  it("renders a permission menu", () => {
    const overlay = {
      kind: "permission" as const,
      header: "Bash request",
      detail: "rm -rf /",
      riskHint: "recursive delete",
      resolve: () => {},
    };
    const { lastFrame } = render(<PermissionPrompt overlay={overlay} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Bash request");
    expect(frame).toContain("High Risk");
    expect(frame).toContain("Yes");
  });

  it("renders a multi-select question", () => {
    const overlay = {
      kind: "question" as const,
      header: "Choose",
      question: "Which approach?",
      options: [{ label: "A", description: "first" }, { label: "B" }],
      multiSelect: true,
      resolve: () => {},
    };
    const { lastFrame } = render(<QuestionPrompt overlay={overlay} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Which approach?");
    expect(frame).toContain("[ ]");
    expect(frame).toContain("first");
  });
});

describe("EffortPrompt (M13.7)", () => {
  it("renders the slider with track ends and the active tier", () => {
    const overlay = {
      kind: "effort" as const,
      current: "high" as const,
      resolve: () => {},
    };
    const { lastFrame } = render(<EffortPrompt overlay={overlay} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Effort");
    expect(frame).toContain("Faster");
    expect(frame).toContain("Smarter");
    expect(frame).toContain("ultracode");
    expect(frame).toContain("Thorough reasoning");
    expect(frame).toContain("adjust");
  });

  it("right-arrow advances toward max; left-arrow goes back", async () => {
    const overlay = {
      kind: "effort" as const,
      current: "high" as const,
      resolve: () => {},
    };
    const { stdin, lastFrame } = render(<EffortPrompt overlay={overlay} />);
    stdin.write("[C"); // right arrow → xhigh
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("Extra reasoning");
  });

  it("shows the ultracode sublabel and resolves on Enter", async () => {
    let chosen: string | null = "unset";
    const overlay = {
      kind: "effort" as const,
      current: "ultracode" as const,
      resolve: (l: any) => {
        chosen = l;
      },
    };
    const { stdin, lastFrame } = render(<EffortPrompt overlay={overlay} />);
    expect(lastFrame()).toContain("xhigh + workflows");
    stdin.write("\r"); // Enter
    await new Promise((r) => setTimeout(r, 20));
    expect(chosen).toBe("ultracode");
  });
});

describe("SessionPicker (/resume overlay)", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    sessionId: `id${i.toString().padStart(2, "0")}`,
    label: `id${i.toString().padStart(2, "0")} · ${i} msgs`,
    preview: `preview ${i}`,
  }));

  it("renders the header, a row, and a more-below marker for a long list", () => {
    const { lastFrame } = render(
      <SessionPicker overlay={{ kind: "sessionPicker", sessions: many, resolve: () => {} }} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Resume a session");
    expect(frame).toContain("id00");
    expect(frame).toContain("preview 0");
    expect(frame).toMatch(/↓ \d+ more/); // rows hidden below the window
    expect(frame).not.toContain("id19"); // beyond the visible window
  });

  it("resolves with the highlighted session id on Enter", async () => {
    let chosen: string | null = "unset";
    const { stdin } = render(
      <SessionPicker
        overlay={{
          kind: "sessionPicker",
          sessions: many,
          resolve: (id) => {
            chosen = id;
          },
        }}
      />,
    );
    stdin.write("\r"); // Enter on the first (default-selected) row
    await new Promise((r) => setTimeout(r, 20));
    expect(chosen).toBe("id00");
  });

  it("cancels with null on Esc", async () => {
    let chosen: string | null = "unset";
    const { stdin } = render(
      <SessionPicker
        overlay={{
          kind: "sessionPicker",
          sessions: many,
          resolve: (id) => {
            chosen = id;
          },
        }}
      />,
    );
    stdin.write(""); // Esc
    await new Promise((r) => setTimeout(r, 20));
    expect(chosen).toBeNull();
  });
});

describe("CommandPicker (/help palette)", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    name: `cmd${i.toString().padStart(2, "0")}`,
    description: `does thing ${i}`,
  }));

  it("renders the header, a row, and a more-below marker for a long list", () => {
    const { lastFrame } = render(
      <CommandPicker overlay={{ kind: "commandPicker", commands: many, resolve: () => {} }} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Commands");
    expect(frame).toContain("/cmd00");
    expect(frame).toContain("does thing 0");
    expect(frame).toMatch(/↓ \d+ more/); // rows hidden below the window
    expect(frame).not.toContain("cmd24"); // beyond the visible window
  });

  it("resolves with the highlighted command name on Enter", async () => {
    let chosen: string | null = "unset";
    const { stdin } = render(
      <CommandPicker
        overlay={{
          kind: "commandPicker",
          commands: many,
          resolve: (name) => {
            chosen = name;
          },
        }}
      />,
    );
    stdin.write("\r"); // Enter on the first (default-selected) row
    await new Promise((r) => setTimeout(r, 20));
    expect(chosen).toBe("cmd00");
  });

  it("two arrow keys in ONE stdin chunk move the cursor two steps", async () => {
    // Same-chunk bursts run the same handler closure without a re-render
    // between keypresses — without the synced cursorRef both keys read the
    // same render-time cursor and the selection moved one step total.
    let chosen: string | null = "unset";
    const { stdin } = render(
      <CommandPicker
        overlay={{
          kind: "commandPicker",
          commands: many,
          resolve: (name) => {
            chosen = name;
          },
        }}
      />,
    );
    stdin.write("\x1b[B\x1b[B\r"); // ↓ ↓ Enter — all in one chunk
    await new Promise((r) => setTimeout(r, 20));
    expect(chosen).toBe("cmd02"); // not cmd00 (stale) and not cmd01 (one step)
  });

  it("scrolls the window as the cursor moves down, then selects", async () => {
    let chosen: string | null = "unset";
    const { stdin, lastFrame } = render(
      <CommandPicker
        overlay={{
          kind: "commandPicker",
          commands: many,
          resolve: (name) => {
            chosen = name;
          },
        }}
      />,
    );
    // Step the cursor down past the initial window so it must scroll.
    for (let i = 0; i < 12; i++) {
      stdin.write("\x1B[B"); // down arrow
      await new Promise((r) => setTimeout(r, 30)); // increased from 20ms for stability
    }
    expect(lastFrame()).toMatch(/↑ \d+ more/); // window scrolled off the top
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 100)); // increased from 50ms for stability
    expect(chosen).toBe("cmd12");
  }, 15000); // increased timeout from 10000ms

  it("cancels with null on Esc", async () => {
    let chosen: string | null = "unset";
    const { stdin } = render(
      <CommandPicker
        overlay={{
          kind: "commandPicker",
          commands: many,
          resolve: (name) => {
            chosen = name;
          },
        }}
      />,
    );
    stdin.write("\x1B"); // Esc
    await new Promise((r) => setTimeout(r, 20));
    expect(chosen).toBeNull();
  });
});

describe("nextOffset (scroll window keeps cursor visible)", () => {
  const WINDOW = 8;

  it("keeps the window fixed while the cursor stays inside it", () => {
    expect(nextOffset(3, 0, WINDOW)).toBe(0);
    expect(nextOffset(7, 0, WINDOW)).toBe(0);
  });

  it("slides down by one when the cursor steps past the bottom edge", () => {
    expect(nextOffset(8, 0, WINDOW)).toBe(1);
    expect(nextOffset(9, 1, WINDOW)).toBe(2);
  });

  it("pins to the cursor when it scrolls above the window", () => {
    expect(nextOffset(2, 5, WINDOW)).toBe(2);
  });

  it("invariant: a full top-to-bottom-and-back walk never hides the cursor", () => {
    const total = 30;
    let offset = 0;
    const check = (cursor: number) => {
      offset = nextOffset(cursor, offset, WINDOW);
      expect(cursor).toBeGreaterThanOrEqual(offset);
      expect(cursor).toBeLessThan(offset + WINDOW);
    };
    for (let c = 0; c < total; c++) check(c);
    for (let c = total - 1; c >= 0; c--) check(c);
  });
});
