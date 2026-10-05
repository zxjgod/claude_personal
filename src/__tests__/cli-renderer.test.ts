// ============================================================
// Tests: CLI renderer
// ============================================================

import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderPermissionPrompt,
  renderSubAgentActivity,
  renderToolResult,
  renderToolStart,
  StreamingRenderer,
} from "../tui/cli-renderer.js";
import { setLanguage } from "../tui/i18n.js";
import { renderMarkdown } from "../tui/markdown.js";
import type { ToolExecutionResult } from "../types.js";

// Force chalk on so color codes are deterministic in CI, and pin the UI
// language so literal-string assertions hold on zh-locale machines too.
// An OSC 52 clipboard write — the payload every "strips terminal control
// sequences" assertion below hunts for.
const OSC52 = "\x1b]52;c;SGVsbG8hHGludmFkaW5nIQ==\x07";
const prevLevel = chalk.level;
beforeEach(() => {
  chalk.level = 1;
  setLanguage("en");
});
afterEach(() => {
  chalk.level = prevLevel;
  vi.restoreAllMocks();
});

function captureStdout(fn: () => void): string {
  let out = "";
  const append = (chunk: any) => {
    out += String(chunk);
    return true;
  };
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(append as any);
  // console.log holds its own stream reference, so spy on it separately.
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: any[]) => append(args.join(" ") + "\n"));
  fn();
  stdoutSpy.mockRestore();
  logSpy.mockRestore();
  return out;
}

describe("StreamingRenderer", () => {
  it("buffers until a block boundary, then renders", () => {
    const r = new StreamingRenderer();
    const partial = captureStdout(() => r.write("hello "));
    expect(partial).toBe(""); // no block boundary yet

    const full = captureStdout(() => r.flush());
    expect(full).toContain("hello");
  });

  it("flush emits the trailing partial block", () => {
    const r = new StreamingRenderer();
    captureStdout(() => r.write("dangling"));
    const flushed = captureStdout(() => r.flush());
    expect(flushed).toContain("dangling");
  });

  it("renders bold without leaking ** markers", () => {
    const r = new StreamingRenderer();
    const out = captureStdout(() => {
      r.write("This is **bold** text\n");
      r.flush();
    });
    expect(out).toContain("bold");
    expect(out).not.toContain("**");
  });

  it("renders headings without leaking # markers", () => {
    const r = new StreamingRenderer();
    const out = captureStdout(() => {
      r.write("## A Heading\n");
      r.flush();
    });
    expect(out).toContain("A Heading");
    expect(out).not.toContain("##");
  });
});

describe("renderMarkdown", () => {
  it("strips ** and renders inline code + tables", () => {
    const md = [
      "**strong** and `code`",
      "",
      "| Key | Value |",
      "|-----|-------|",
      "| a   | 1     |",
    ].join("\n");
    const out = renderMarkdown(md);
    expect(out).not.toContain("**");
    expect(out).toContain("strong");
    expect(out).toContain("code");
    // Box-drawing borders for the table.
    expect(out).toMatch(/[┌┬┐├┼┤└┴┘│─]/);
  });

  it("renders list bullets without leaking markers", () => {
    const out = renderMarkdown("- one\n- two\n");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });
});

describe("renderToolResult", () => {
  it("shows a branch glyph and folds long output", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const result: ToolExecutionResult = {
      toolName: "read",
      formatted: longOutput,
      durationMs: 42,
    } as ToolExecutionResult;
    const out = captureStdout(() => renderToolResult(result));
    expect(out).toContain("⎿");
    // The line-based REPL has no key handler mid-turn, so the fold hint must
    // not promise a ctrl+r affordance only the Ink TUI implements.
    expect(out).toContain("+18 lines");
    expect(out).not.toContain("ctrl+r");
  });

  it("shows the error on failure", () => {
    const result: ToolExecutionResult = {
      toolName: "write",
      formatted: "",
      error: "boom",
    } as ToolExecutionResult;
    const out = captureStdout(() => renderToolResult(result));
    expect(out).toContain("boom");
  });

  it("colors diff +/- lines in formatted output", () => {
    const result: ToolExecutionResult = {
      toolName: "edit",
      formatted: "+ added line\n- removed line",
      durationMs: 5,
    } as ToolExecutionResult;
    const out = captureStdout(() => renderToolResult(result));
    expect(out).toContain("added line");
    expect(out).toContain("removed line");
  });

  it("shows a compact summary for Read/Grep/Glob instead of raw content", () => {
    const result: ToolExecutionResult = {
      toolName: "read",
      formatted: "   1: line one\n   2: line two",
      durationMs: 3,
      result: {
        content: "   1: line one\n   2: line two",
        metadata: { linesRead: 2, summary: "Read 2 lines" },
      },
    };
    const out = captureStdout(() => renderToolResult(result));
    expect(out).toContain("Read 2 lines");
    expect(out).not.toContain("line one");
  });

  it("strips terminal control sequences from the Write preview path (round 4)", () => {
    const result: ToolExecutionResult = {
      toolName: "write",
      formatted: "",
      result: {
        content: "",
        // The file path is model-controlled and lands in a plain (unstyled)
        // line of the preview header.
        metadata: {
          codePreview: {
            filePath: `src/x${OSC52}.ts`,
            text: "export const a = 1;",
            totalLines: 1,
            truncated: false,
          },
        },
      },
    } as ToolExecutionResult;
    const out = captureStdout(() => renderToolResult(result));
    expect(out).toContain("lines written to");
    expect(out).toContain(".ts");
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("\x07");
  });
});

describe("renderSubAgentActivity", () => {
  it("renders nested tool use with detail", () => {
    const out = captureStdout(() =>
      renderSubAgentActivity({
        subagentName: "code-explorer",
        phase: "tool_use",
        toolName: "read",
        input: { filePath: "src/a.ts" },
      }),
    );
    expect(out).toContain("code-explorer");
    expect(out).toContain("Read");
    expect(out).toContain("src/a.ts");
  });

  it("renders nested tool result success and failure", () => {
    const out = captureStdout(() =>
      renderSubAgentActivity({
        subagentName: "code-explorer",
        phase: "tool_results",
        results: [
          { toolName: "read", formatted: "ok", durationMs: 2 },
          { toolName: "grep", formatted: "", error: "boom" },
        ],
      }),
    );
    expect(out).toContain("read");
    expect(out).toContain("grep");
    expect(out).toContain("boom");
  });

  // Round 4: sub-agent names, nested tool names and nested tool errors all
  // reach stdout verbatim here, unlike renderToolResult which sanitizes.
  it("strips terminal control sequences from sub-agent names, tool names and errors", () => {
    const out = captureStdout(() =>
      renderSubAgentActivity({
        subagentName: `evil${OSC52}`,
        phase: "tool_results",
        results: [
          { toolName: `t${OSC52}`, formatted: "", error: `boom ${OSC52}` },
          { toolName: "read", formatted: "ok", durationMs: 2 },
        ],
      }),
    );
    expect(out).toContain("boom");
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("\x07");
  });

  it("strips terminal control sequences from a nested tool_use line", () => {
    const out = captureStdout(() =>
      renderSubAgentActivity({
        subagentName: `x${OSC52}`,
        phase: "tool_use",
        toolName: `read${OSC52}`,
        input: {},
      }),
    );
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("\x07");
  });
});

describe("renderToolStart / renderPermissionPrompt", () => {
  it("renders the tool name (capitalized) and detail", () => {
    const out = captureStdout(() => renderToolStart("bash", { command: "ls -la" }));
    expect(out).toContain("Bash");
    expect(out).toContain("ls -la");
    expect(out).toContain("●");
  });

  it("strips terminal control sequences from a server-supplied tool name", () => {
    const out = captureStdout(() => renderToolStart(`mcp__srv__t${OSC52}`));
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("\x07");
  });

  it("renders a bordered permission prompt with detail and risk", () => {
    const out = captureStdout(() =>
      renderPermissionPrompt("write", { filePath: "a.txt" }, "overwrites file"),
    );
    // P3-13: labels come from i18n (en by default in tests).
    expect(out).toContain("Write file");
    expect(out).toContain("overwrites file");
    expect(out).toContain("a.txt");
    expect(out).toMatch(/[┌┐└┘│─]/);
  });

  it("renders the generic label for tools without a dedicated i18n key", () => {
    const out = captureStdout(() => renderPermissionPrompt("webfetch", { url: "https://x" }));
    expect(out).toContain("Webfetch operation");
  });

  it("strips terminal control sequences from an unknown tool name", () => {
    const out = captureStdout(() => renderPermissionPrompt(`weird${OSC52}`, {}));
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("\x07");
  });
});
