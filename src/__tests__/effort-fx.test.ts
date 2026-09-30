// ============================================================
// Tests: effort-fx frame builder (M13.7)
// ============================================================
// Asserts on the ANSI-stripped frame so layout is verified independent of
// color; color/background presence is checked via raw ANSI codes (chalk
// forced to truecolor so it emits them off-TTY).

import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rainbowColors } from "../tui/effort.js";
import { buildEffortFrame, ORDER } from "../tui/effort-fx.js";
import { stripAnsi, visualWidth } from "../tui/terminal-width.js";
import { palette } from "../tui/theme.js";

let previousColorLevel: typeof chalk.level;
beforeEach(() => {
  previousColorLevel = chalk.level;
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = previousColorLevel;
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
    expect(text).not.toContain("Thorough reasoning");
    expect(text).toContain("to adjust");
  });

  it("keeps track rows stable and adds a warning only for max", () => {
    const counts = ORDER.filter((level) => level !== "max").map(
      (lvl) => buildEffortFrame({ active: lvl, phase: 10, cols: 124 }).length,
    );
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(9);
    const maxFrame = buildEffortFrame({ active: "max", phase: 0, cols: 124 });
    expect(maxFrame).toHaveLength(10);
    expect(stripAnsi(maxFrame[7])).toContain("May use excessive tokens");
    expect(stripAnsi(maxFrame[9])).toContain("to adjust");
    for (const level of ORDER) {
      const frame = buildEffortFrame({ active: level, phase: 0, cols: 124 }).map(stripAnsi);
      expect(frame[4].indexOf("─")).toBe(stripAnsi(maxFrame[4]).indexOf("─"));
    }
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

  it("max flows rainbow label colors right to left while keeping a neutral track", () => {
    const first = buildEffortFrame({ active: "max", phase: 0, cols: 124 });
    const next = buildEffortFrame({ active: "max", phase: 60, cols: 124 });
    const colors = rainbowColors(6, 0);
    expect(first[5]).toContain(chalk.hex(colors[0]).bold("m"));
    expect(first[5]).toContain(chalk.hex(colors[1]).bold("a"));
    expect(first[5]).toContain(chalk.hex(colors[2]).bold("x"));
    expect(next[5]).toContain(chalk.hex(colors[1]).bold("m"));
    expect(next[5]).toContain(chalk.hex(colors[2]).bold("a"));
    expect(first[4]).toBe(next[4]);
    expect(first[4]).toContain(chalk.hex(palette.secondary)("─"));
    expect(first[4]).toContain(chalk.hex("#8c50f0")("─"));
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

  it("uses a neutral track, white marker and purple labels before ultracode entry", () => {
    const frame = buildEffortFrame({ active: "xhigh", phase: 0, cols: 124 });
    expect(frame[1]).toContain(chalk.hex(palette.text).bold("E"));
    expect(frame[4]).toContain(chalk.hex(palette.secondary)("─"));
    expect(frame[4]).toContain(chalk.hex("#8c50f0")("─"));
    expect(frame[4]).toContain(chalk.hex(palette.text).bold("▲"));
    expect(frame[5]).toContain(chalk.hex("#af87ff").bold("x"));
    expect(frame[5]).toContain(chalk.hex("#8c50f0")("u"));
    expect(frame.join("")).not.toMatch(/48;2;/);
    expect(plain(frame).match(/to adjust/g)).toHaveLength(1);
  });

  it("matches low yellow, medium green and high lavender selected labels", () => {
    for (const [level, color] of [
      ["low", "#ffc107"],
      ["medium", palette.success],
      ["high", palette.commandSelected],
    ] as const) {
      const frame = buildEffortFrame({ active: level, phase: 0, cols: 124 });
      for (const character of level) expect(frame[5]).toContain(chalk.hex(color).bold(character));
      expect(frame[4]).toContain(chalk.hex(palette.text).bold("▲"));
    }
  });

  it("moves the white xhigh highlight left to right without changing text geometry", () => {
    const base = buildEffortFrame({ active: "xhigh", phase: 0, cols: 124 });
    expect(base[5]).not.toContain("38;2;255;255;255");
    for (let character = 0; character < "xhigh".length; character++) {
      const frame = buildEffortFrame({ active: "xhigh", phase: character + 4, cols: 124 });
      expect(frame[5]).toContain(chalk.hex("#d0b4e8").bold("xhigh"[character]));
      expect(frame[5]).not.toContain("38;2;255;255;255");
      const beforeWhite = frame[5].split("\x1b[38;2;208;180;232m")[0];
      const expectedStart = stripAnsi(base[5]).indexOf("xhigh");
      expect(visualWidth(beforeWhite)).toBe(expectedStart + character);
      expect(plain(frame)).toBe(plain(base));
      expect(frame[4]).toBe(base[4]);
    }
  });

  it("uses only the reference eight violet background shades", () => {
    const raw = buildEffortFrame({ active: "ultracode", phase: 36, cols: 124 }).join("");
    const shades = new Set(raw.match(/48;2;\d+;\d+;\d+/g));
    const expected = [
      "#3e1676",
      "#491e87",
      "#542799",
      "#5f2faa",
      "#6b37bc",
      "#763fcd",
      "#8148df",
      "#8c50f0",
    ].map(
      (hex) =>
        `48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`,
    );
    expect([...shades].every((shade) => expected.includes(shade))).toBe(true);
    expect(shades.size).toBe(8);
  });

  it("fills title through hint at the end of entry but never paints the divider", () => {
    const frame = buildEffortFrame({ active: "ultracode", phase: 0, cols: 124, fade: 1 });
    expect(frame[0]).not.toMatch(/48;2;/);
    for (const line of frame.slice(1)) {
      expect(line.match(/48;2;/g)).toHaveLength(123);
      expect(line).toContain("38;2;255;255;255");
    }
    expect(plain(frame)).toContain("to adjust");
  });

  it("keeps content and dimensions stable through six outward diffusion stages", () => {
    const stages = [0, 0.1, 0.2, 0.3, 0.45, 1];
    const frames = stages.map((fade) =>
      buildEffortFrame({ active: "ultracode", phase: 0, cols: 124, fade }),
    );
    const counts = frames.map((frame) => (frame.join("").match(/48;2;/g) ?? []).length);
    for (let index = 1; index < counts.length; index++)
      expect(counts[index]).toBeGreaterThan(counts[index - 1]);
    for (const frame of frames) expect(plain(frame)).toBe(plain(frames[0]));
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[0]).toBeLessThanOrEqual(18);
    expect(counts.at(-1)).toBe(123 * 8);
  });

  it("adapts to terminal widths rather than capping the effect at 120 columns", () => {
    for (const cols of [40, 80, 124, 160]) {
      const frame = buildEffortFrame({ active: "ultracode", phase: 8, cols, fade: 1 });
      expect(frame).toHaveLength(9);
      expect(frame.every((line) => visualWidth(line) === cols - 1)).toBe(true);
    }
  });
});
