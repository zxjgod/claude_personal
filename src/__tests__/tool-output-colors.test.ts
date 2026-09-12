import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { highlightCode } from "../tui/markdown.js";
import { stripAnsi } from "../tui/terminal-width.js";
import { applyTheme } from "../tui/theme.js";
import { renderNumberedDiffLine, toolOutputLines } from "../tui/tool-output.js";

const originalLevel = chalk.level;
beforeEach(() => {
  chalk.level = 3;
  applyTheme("dark");
});
afterEach(() => {
  chalk.level = originalLevel;
  applyTheme("dark");
});

describe("tool output colors", () => {
  it("preserves source text and resolves syntax colors after a live theme switch", () => {
    const code = 'import { x } from "./x"; // <source>';
    const dark = highlightCode(code, "ts");
    expect(stripAnsi(dark)).toBe(code);
    applyTheme("light");
    const light = highlightCode(code, "ts");
    expect(stripAnsi(light)).toBe(code);
    expect(light).not.toBe(dark);
  });

  it("uses diff backgrounds only for edit output, never ordinary shell lines", () => {
    const formatted = '+ const message = "你好";';
    const edit = toolOutputLines({ toolName: "edit", formatted }, "app.ts")[0]!;
    const bash = toolOutputLines({ toolName: "bash", formatted })[0]!;
    expect(edit).toContain("\x1b[48;2;0;40;0m");
    expect(stripAnsi(edit).trimEnd()).toBe(formatted);
    expect(bash).not.toContain("\x1b[48;");
  });

  it("draws a line-number gutter for an Edit diff when metadata carries it", () => {
    const diff = "Edit applied to app.ts:\n- const a = 1;\n+ const a = 2;";
    const result = {
      toolName: "edit",
      formatted: diff,
      result: {
        content: diff,
        metadata: {
          diffLines: [
            { sign: "-" as const, text: "const a = 1;", line: 12 },
            { sign: "+" as const, text: "const a = 2;", line: 12 },
          ],
        },
      },
    };
    const display = toolOutputLines(result, "app.ts").map((l) => stripAnsi(l).trimEnd());
    expect(display).toHaveLength(2);
    // The 4-column gutter matches the Write preview's numbering.
    expect(display[0]).toContain("  12 - const a = 1;");
    expect(display[1]).toContain("  12 + const a = 2;");
  });

  it("falls back to the gutter-free diff when no numbered metadata is present", () => {
    // Older sessions and replayed history carry no diffLines — the diff must
    // still render exactly as before.
    const formatted = "+ added line\n- removed line";
    const display = toolOutputLines({ toolName: "edit", formatted }, "app.ts").map((l) =>
      stripAnsi(l).trimEnd(),
    );
    expect(display[0]).toBe("+ added line");
    expect(display[1]).toBe("- removed line");
  });

  it("colors the numbered diff by side and keeps the gutter legible on the band", () => {
    const removed = renderNumberedDiffLine({ sign: "-", text: "gone", line: 3 }, "ts");
    expect(stripAnsi(removed).trimEnd()).toBe("   3 - gone");
    expect(removed).toContain("\x1b[48;2;56;0;0m"); // palette.diffRemovedBg (dark)
  });

  it("renders a bounded Write snapshot without replacing the model-facing result", () => {
    const result = {
      toolName: "write",
      formatted: "Created file: app.ts",
      result: {
        content: "Created file: app.ts",
        metadata: {
          codePreview: { filePath: "app.ts", text: "const n = 1;", totalLines: 40 },
        },
      },
    };
    const before = JSON.stringify(result);
    const display = stripAnsi(toolOutputLines(result).join("\n"));
    expect(display).toContain("1 const n = 1;");
    expect(display).toContain("+39 lines");
    expect(JSON.stringify(result)).toBe(before);
  });
});
