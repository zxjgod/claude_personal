// ============================================================
// Tests: effort-fx frame builder (M13.7)
// ============================================================
// Asserts on the ANSI-stripped frame so layout is verified independent of
// color; color/background presence is checked via raw ANSI codes (chalk
// forced to truecolor so it emits them off-TTY).

import chalk from "chalk";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEffortFrame, ORDER } from "../tui/effort-fx.js";
import { stripAnsi } from "../tui/terminal-width.js";

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
    const text = plain(buildEffortFrame({ active: "high", phase: 0, cols: 124 }));
    expect(text).toContain("Effort");
    expect(text).toContain("Faster");
    expect(text).toContain("Smarter");
    expect(text).toContain("low");
    expect(text).toContain("ultracode");
    expect(text).toContain("xhigh + workflows");
    expect(text).toContain("▲"); // ▲ marker
    expect(text).toContain("┆"); // ┆ divider
    expect(text).toContain("Thorough reasoning");
    expect(text).toContain("to adjust");
  });

  it("all tiers render the same number of rows (no vertical shift)", () => {
    const counts = ORDER.map(
      (lvl) => buildEffortFrame({ active: lvl, phase: 10, cols: 124 }).length,
    );
    expect(new Set(counts).size).toBe(1);
  });

  it("Faster aligns to the track start, Smarter to the track end", () => {
    const f = buildEffortFrame({ active: "high", phase: 0, cols: 124 }).map(stripAnsi);
    const endsRow = f[3]!; // Faster … Smarter
    const trackRow = f[4]!; // slider track
    const trackStart = trackRow.search(/\S/);
    expect(endsRow.indexOf("Faster")).toBe(trackStart); // left-aligned
    expect(endsRow.replace(/\s+$/, "").length).toBe(trackRow.replace(/\s+$/, "").length); // right
  });

  it("the marker is a single ▲ for every tier (no gap)", () => {
    for (const lvl of ORDER) {
      const trackRow = buildEffortFrame({ active: lvl, phase: 0, cols: 124 }).map(stripAnsi)[4]!;
      expect((trackRow.match(/▲/g) || []).length).toBe(1);
      expect(trackRow).not.toMatch(/✦▲|▲✦/); // no ✦ hugging ▲
    }
  });

  it("max uses a rainbow track (many distinct truecolor codes)", () => {
    const raw = buildEffortFrame({ active: "max", phase: 50, cols: 124 }).join("");
    const colors = new Set(raw.match(/38;2;\d+;\d+;\d+/g) ?? []);
    expect(colors.size).toBeGreaterThan(30);
  });

  it("ultracode paints a violet background field (settled = full panel)", () => {
    const raw = buildEffortFrame({ active: "ultracode", phase: 8, cols: 124, fade: 1 }).join("");
    const bgCount = (raw.match(/48;2;\d+;\d+;\d+/g) ?? []).length;
    expect(bgCount).toBeGreaterThan(100); // a large filled field, not a thin band
  });

  it("ultracode background grows from the marker and reaches full width at fade=1", () => {
    const bgCols = (fade: number) => {
      const raw = buildEffortFrame({ active: "ultracode", phase: 8, cols: 100, fade }).join("");
      return (raw.match(/48;2;\d+;\d+;\d+/g) ?? []).length;
    };
    // Early fade lights fewer cells than a settled (fade=1) field.
    expect(bgCols(0.2)).toBeGreaterThan(0);
    expect(bgCols(1)).toBeGreaterThan(bgCols(0.2));
  });

  it("ultracode violet is the cyber-violet hue (blue-dominant, not red)", () => {
    const raw = buildEffortFrame({ active: "ultracode", phase: 40, cols: 124 }).join("");
    const shades = (raw.match(/48;2;(\d+);(\d+);(\d+)/g) ?? []).map((s) =>
      s.replace("48;2;", "").split(";").map(Number),
    );
    expect(shades.length).toBeGreaterThan(10);
    // Indigo/violet → blue channel dominates green on average.
    const avg = (i: number) => shades.reduce((a, s) => a + s[i]!, 0) / shades.length;
    expect(avg(2)).toBeGreaterThan(avg(1)); // b > g
  });

  it("ultracode frames differ across phases (animation)", () => {
    const a = buildEffortFrame({ active: "ultracode", phase: 0, cols: 124 }).join("\n");
    const b = buildEffortFrame({ active: "ultracode", phase: 120, cols: 124 }).join("\n");
    expect(a).not.toBe(b);
  });

  it("ultracode fade-in: a partial fade lights fewer cells than settled", () => {
    const cells = (fade: number) =>
      (
        buildEffortFrame({ active: "ultracode", phase: 6, cols: 124, fade })
          .join("")
          .match(/48;2;/g) ?? []
      ).length;
    expect(cells(0.15)).toBeLessThan(cells(1));
  });
});
