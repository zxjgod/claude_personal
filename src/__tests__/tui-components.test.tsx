// ============================================================
// Tests: TUI React components (ink-testing-library)
// ============================================================
// Renders components to a virtual terminal and asserts on the frame text.
// Verifies the App shell, tool cards (incl. collapse), and prompt overlays
// render without crashing and show the right content.
// ============================================================

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../tui/App.js";
import { CompletedToolCard } from "../tui/ToolCard.js";
import { PermissionPrompt, QuestionPrompt } from "../tui/Prompts.js";
import { TuiStore } from "../tui/store.js";
import type { ToolExecutionResult } from "../types.js";

const noopSubmit = () => {};
const commands = [{ name: "help", description: "Show help" }];

describe("App", () => {
  it("renders the status bar and input hint when idle", () => {
    const store = new TuiStore("deepseek/chat");
    const { lastFrame } = render(
      <App store={store} commands={commands} onSubmit={noopSubmit} expandedId={null} />,
    );
    expect(lastFrame()).toContain("deepseek/chat");
    expect(lastFrame()).toMatch(/for commands/);
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
