import { describe, expect, it } from "vitest";
import { formatCommandMenuRow } from "../tui/command-menu-layout.js";
import { visualWidth } from "../tui/terminal-width.js";

const commands = [
  { name: "help", description: "Show help" },
  { name: "permissions", description: "Manage permission rules" },
];

describe("command menu description columns", () => {
  it("starts descriptions at the same reference column regardless of name length or selection", () => {
    const help = formatCommandMenuRow(commands[0], true, commands, 120);
    const permissions = formatCommandMenuRow(commands[1], false, commands, 120);
    expect(help.indexOf("Show help")).toBe(30);
    expect(permissions.indexOf("Manage permission rules")).toBe(30);
    expect(help.startsWith("❯ /help")).toBe(true);
  });

  it("reserves space for the longest name across the whole catalog", () => {
    const catalog = [
      ...commands,
      { name: "extra-long-command-name-that-is-hidden", description: "Long" },
    ];
    const first = formatCommandMenuRow(catalog[0], true, catalog, 120);
    const last = formatCommandMenuRow(catalog[2], false, catalog, 120);
    expect(first.indexOf("Show help")).toBe(last.indexOf("Long"));
    expect(first.indexOf("Show help")).toBe(catalog[2].name.length + 5);
  });

  it("measures non-ASCII names in terminal columns", () => {
    const command = { name: "帮助", description: "Show help" };
    const row = formatCommandMenuRow(command, false, [command], 100);
    expect(visualWidth(row.slice(0, row.indexOf("Show help")))).toBe(30);
  });

  it("shrinks the name column and truncates descriptions on narrow terminals", () => {
    const command = {
      name: "very-long-command-name",
      description: "A long description with 中文说明",
    };
    const row = formatCommandMenuRow(command, true, [command], 40);
    expect(visualWidth(row)).toBeLessThanOrEqual(40);
    expect(row.indexOf("A long")).toBe(20);
    expect(row).toContain("…");
  });

  it("keeps every row on one line when descriptions are long", () => {
    const command = { name: "help", description: "说明".repeat(100) };
    for (const width of [20, 40, 80, 120]) {
      const row = formatCommandMenuRow(command, false, [command], width);
      expect(visualWidth(row)).toBeLessThanOrEqual(width);
      expect(row).not.toContain("\n");
    }
  });
});
