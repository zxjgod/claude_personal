import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { highlightCode } from "../tui/markdown.js";
import { stripAnsi } from "../tui/terminal-width.js";
import { applyTheme } from "../tui/theme.js";
import { toolOutputLines } from "../tui/tool-output.js";

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
