// ============================================================
// Tests: TUI React components (ink-testing-library)
// ============================================================
// Renders components to a virtual terminal and asserts on the frame text.
// Verifies the App shell, tool cards (incl. collapse), and prompt overlays
// render without crashing and show the right content.
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../tui/App.js";
import { CommandPicker } from "../tui/CommandPicker.js";
import { EffortPrompt } from "../tui/EffortPrompt.js";
import { PermissionPrompt, QuestionPrompt } from "../tui/Prompts.js";
import { nextOffset, SessionPicker } from "../tui/SessionPicker.js";
import { TuiStore } from "../tui/store.js";
import { CompletedToolCard } from "../tui/ToolCard.js";
import type { ToolExecutionResult } from "../types.js";

const noopSubmit = () => {};
const commands = [{ name: "help", description: "Show help" }];

describe("App", () => {
  it("renders the status bar and input hint when idle", () => {
    const store = new TuiStore("deepseek/chat");
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    // Check for status bar elements (format changed, now shows "default" without "mode:" prefix)
    expect(lastFrame()).toContain("default");
    expect(lastFrame()).toMatch(/\/ commands/);
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
    expect(lastFrame()).toMatch(/Thinking|working/);
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
    expect(frame).toContain("ctrl+r to expand");
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
    expect(frame).toContain("recursive delete");
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
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(lastFrame()).toMatch(/↑ \d+ more/); // window scrolled off the top
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(chosen).toBe("cmd12");
  });

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
