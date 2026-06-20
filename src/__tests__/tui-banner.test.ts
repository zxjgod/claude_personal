// ============================================================
// Tests: TUI startup banner
// ============================================================

import { describe, it, expect } from "vitest";
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
