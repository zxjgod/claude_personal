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
import { renderMarkdown } from "../tui/markdown.js";
import type { ToolExecutionResult } from "../types.js";

// Force chalk on so color codes are deterministic in CI.
const prevLevel = chalk.level;
beforeEach(() => {
  chalk.level = 1;
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
    expect(out).toContain("ctrl+o to expand");
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
});

describe("renderToolStart / renderPermissionPrompt", () => {
  it("renders the tool name (capitalized) and detail", () => {
    const out = captureStdout(() => renderToolStart("bash", { command: "ls -la" }));
    expect(out).toContain("Bash");
    expect(out).toContain("ls -la");
    expect(out).toContain("●");
  });

  it("renders a bordered permission prompt with detail and risk", () => {
    const out = captureStdout(() =>
      renderPermissionPrompt("write", { filePath: "a.txt" }, "overwrites file"),
    );
    // P1-4: Updated to expect Chinese output
    expect(out).toContain("写入文件");
    expect(out).toContain("overwrites file");
    expect(out).toContain("a.txt");
    expect(out).toMatch(/[┌┐└┘│─]/);
  });
});
