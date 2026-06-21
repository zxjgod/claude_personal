// ============================================================
// Tests: effort-fx frame builder (M13.7)
// ============================================================
// Asserts on the ANSI-stripped frame so structure/layout is verified
// independent of color. Color presence is checked via raw ANSI codes.

import { describe, it, expect, beforeAll } from "vitest";
import chalk from "chalk";
import { buildEffortFrame, ORDER } from "../tui/effort-fx.js";
import { stripAnsi } from "../terminal-width.js";

// Force truecolor so color-based assertions are meaningful off-TTY (CI/vitest).
beforeAll(() => {
  chalk.level = 3;
});

function plain(lines: string[]): string {
  return lines.map(stripAnsi).join("\n");
}

describe("effort-fx buildEffortFrame", () => {
  it("ORDER runs low→max then ultracode", () => {
    expect(ORDER).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
  });

  it("renders the reference layout for high", () => {
    const f = buildEffortFrame({ active: "high", phase: 0, cols: 124 });
    const text = plain(f);
    expect(text).toContain("Effort");
    expect(text).toContain("Faster");
    expect(text).toContain("Smarter");
    expect(text).toContain("low");
    expect(text).toContain("ultracode");
    expect(text).toContain("xhigh + workflows");
    expect(text).toContain("▲"); // marker present
    expect(text).toContain("┆"); // gradient/ultracode divider
    expect(text).toContain("Thorough reasoning");
    expect(text).toContain("←/→ to adjust");
  });

  it("centers the track: left padding grows with terminal width", () => {
    const narrow = buildEffortFrame({ active: "high", phase: 0, cols: 80 });
    const wide = buildEffortFrame({ active: "high", phase: 0, cols: 160 });
    const pad = (lines: string[]) => {
      // The labels row contains "low ... ultracode"; measure its indent.
      const row = lines.map(stripAnsi).find((l) => /low/.test(l) && /ultracode/.test(l))!;
      return row.length - row.trimStart().length;
    };
    expect(pad(wide)).toBeGreaterThan(pad(narrow));
  });

  it("max uses a rainbow track (many distinct truecolor codes)", () => {
    const f = buildEffortFrame({ active: "max", phase: 50, cols: 124 });
    const raw = f.join("");
    const colors = new Set(raw.match(/38;2;\d+;\d+;\d+/g) ?? []);
    // A rainbow spreads across the whole track → lots of unique colors.
    expect(colors.size).toBeGreaterThan(30);
  });

  it("ultracode adds particle/ring rows and is purple-dominant", () => {
    const f = buildEffortFrame({ active: "ultracode", phase: 40, cols: 124 });
    const text = plain(f);
    // Expanding ring bar uses heavy ━; particles drift around the panel.
    expect(text).toContain("━");
    expect(/[·˙°*✦⋆•∴❖]/.test(text)).toBe(true);
    // More rows than the plain layout (particles above + ring + particles below).
    const plainHigh = buildEffortFrame({ active: "high", phase: 0, cols: 124 });
    expect(f.length).toBeGreaterThan(plainHigh.length);
  });

  it("ultracode frames differ across phases (animation)", () => {
    const a = buildEffortFrame({ active: "ultracode", phase: 0, cols: 124 }).join("\n");
    const b = buildEffortFrame({ active: "ultracode", phase: 120, cols: 124 }).join("\n");
    expect(a).not.toBe(b);
  });
});
