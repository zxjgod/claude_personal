// ============================================================
// Tests: TUI startup banner
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderBannerLines } from "../tui/banner.js";

describe("renderBannerLines", () => {
  const info = {
    version: "1.0.0",
    model: "deepseek-chat",
    provider: "deepseek",
    workspaceRoot: "/home/user/project",
  };

  it("includes the title, model and tips", () => {
    const text = renderBannerLines(info).join("\n");
    expect(text).toContain("Claude Code");
    expect(text).toContain("v1.0.0");
    expect(text).toContain("deepseek-chat");
    expect(text).toContain("Welcome back!");
    expect(text).toContain("Tips for getting started");
    expect(text).toContain("What's new");
  });

  it("wraps everything in one rounded box with a vertical divider", () => {
    const lines = renderBannerLines(info);
    // The first content line is the rounded top border at column 0.
    expect(lines[0]).toContain("╭");
    expect(lines.at(-2)).toContain("╰");
    // Interior rows carry a vertical divider between the two columns.
    const divided = lines.filter((l) => (l.match(/│/g) ?? []).length >= 3);
    expect(divided.length).toBeGreaterThan(0);
  });
});

describe("full-screen alt-screen lifecycle (M25.2 — source regression)", () => {
  // No headless TTY can trigger the real alt-screen switch in CI, so we assert
  // on run.tsx source that the enter/exit sequences and a guaranteed restore
  // are present — locking the contract that a leaked alt-screen can't ship.
  const src = readFileSync(fileURLToPath(new URL("../tui/run.tsx", import.meta.url)), "utf8");

  it("enters and exits the alternate screen (DEC 1049) only in fullscreen", () => {
    expect(src).toContain("?1049h"); // ENTER_ALT
    expect(src).toContain("?1049l"); // EXIT_ALT
    // Entry is gated on the opt-in flag.
    expect(src).toMatch(/if \(deps\.fullscreen\)[\s\S]*?ENTER_ALT/);
  });

  it("guards restore against double-write and runs it on exit + unmount", () => {
    expect(src).toContain("altRestored"); // double-restore guard
    expect(src).toContain('process.once("exit", restoreScreen)');
    expect(src).toContain(".finally(restoreScreen)"); // Ink-unmount path
  });
});
