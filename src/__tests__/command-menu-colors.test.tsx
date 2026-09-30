import chalk from "chalk";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandPicker } from "../tui/CommandPicker.js";
import { InputBox } from "../tui/InputBox.js";
import { setLanguage } from "../tui/i18n.js";
import { stripAnsi } from "../tui/terminal-width.js";
import { applyTheme, palette } from "../tui/theme.js";

const commands = [
  { name: "help", description: "Show help" },
  { name: "clear", description: "Clear history" },
];
let previousColorLevel: typeof chalk.level;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  previousColorLevel = chalk.level;
  chalk.level = 3;
  applyTheme("dark");
  setLanguage("en");
});

afterEach(() => {
  chalk.level = previousColorLevel;
  applyTheme("dark");
});

describe("command menu reference colors", () => {
  it("uses lavender for the entire selected slash suggestion and gray for other rows", async () => {
    const { stdin, lastFrame, unmount } = render(
      <InputBox commands={commands} disabled={false} onSubmit={() => {}} />,
    );
    try {
      await flush();
      stdin.write("/");
      await flush();
      expect(lastFrame()).toContain(
        chalk.hex(palette.commandSelected)(`❯ ${"/help".padEnd(27)} Show help`),
      );
      expect(lastFrame()).toContain(
        chalk.hex(palette.secondary)(`  ${"/clear".padEnd(27)} Clear history`),
      );
      const rows = stripAnsi(lastFrame() ?? "").split("\n");
      const help = rows.find((row) => row.includes("Show help")) ?? "";
      const clear = rows.find((row) => row.includes("Clear history")) ?? "";
      expect(help.indexOf("Show help")).toBe(30);
      expect(clear.indexOf("Clear history")).toBe(30);
      stdin.write("\x1b[B");
      await flush();
      expect(lastFrame()).toContain(
        chalk.hex(palette.commandSelected)(`❯ ${"/clear".padEnd(27)} Clear history`),
      );
      expect(lastFrame()).toContain(
        chalk.hex(palette.secondary)(`  ${"/help".padEnd(27)} Show help`),
      );
    } finally {
      unmount();
    }
  });

  it("uses the same row colors in the command picker", () => {
    const { lastFrame, unmount } = render(
      <CommandPicker overlay={{ kind: "commandPicker", commands, resolve: () => {} }} />,
    );
    try {
      expect(lastFrame()).toContain(
        chalk.hex(palette.commandSelected)(`❯ ${"/help".padEnd(27)} Show help`),
      );
      expect(lastFrame()).toContain(
        chalk.hex(palette.secondary)(`  ${"/clear".padEnd(27)} Clear history`),
      );
    } finally {
      unmount();
    }
  });
});
