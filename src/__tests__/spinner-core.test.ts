// ============================================================
// Tests: spinner-core (shared spinner primitives, M23.1)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  actionLabel,
  formatDuration,
  formatTokens,
  GLYPH_FRAME_MS,
  glyphAt,
  pickVerb,
  SPINNER_FRAMES,
  SPINNER_VERBS,
} from "../spinner-core.js";

describe("SPINNER_VERBS / pickVerb", () => {
  it("are all gerunds and include the canonical ones", () => {
    expect(SPINNER_VERBS).toContain("Whisking");
    expect(SPINNER_VERBS).toContain("Pondering");
    expect(SPINNER_VERBS.length).toBeGreaterThan(20);
    for (const v of SPINNER_VERBS) expect(v).toMatch(/ing$/);
  });

  it("pickVerb returns a member of the list", () => {
    for (let i = 0; i < 20; i++) {
      expect(SPINNER_VERBS).toContain(pickVerb());
    }
  });
});

describe("glyphAt", () => {
  it("returns the first frame at t=0 and advances every GLYPH_FRAME_MS", () => {
    expect(glyphAt(0)).toBe(SPINNER_FRAMES[0]);
    expect(glyphAt(GLYPH_FRAME_MS)).toBe(SPINNER_FRAMES[1]);
    expect(glyphAt(GLYPH_FRAME_MS * 2)).toBe(SPINNER_FRAMES[2]);
  });

  it("wraps around the frame ring and never throws on negatives", () => {
    const full = GLYPH_FRAME_MS * SPINNER_FRAMES.length;
    expect(glyphAt(full)).toBe(SPINNER_FRAMES[0]);
    expect(glyphAt(-100)).toBe(SPINNER_FRAMES[0]);
  });
});

describe("formatDuration / formatTokens (re-shared)", () => {
  it("format durations", () => {
    expect(formatDuration(16_000)).toBe("16s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(120_000)).toBe("2m");
  });
  it("format token counts", () => {
    expect(formatTokens(144)).toBe("144");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(15_000)).toBe("15k");
  });
});

describe("actionLabel (M23.3 concrete actions)", () => {
  it("maps read/write/edit to a basename", () => {
    expect(actionLabel("read", "src/tui/App.tsx")).toBe("Reading App.tsx");
    expect(actionLabel("write", "C:\\x\\notes.md")).toBe("Writing notes.md");
    expect(actionLabel("edit", "a/b/c.ts")).toBe("Editing c.ts");
  });

  it("maps bash to the command and glob/grep to a search", () => {
    expect(actionLabel("bash", "npm test")).toBe("Running npm test");
    expect(actionLabel("grep", "TODO")).toBe("Searching TODO");
    expect(actionLabel("glob", "**/*.ts")).toBe("Searching **/*.ts");
  });

  it("maps webfetch to a host and task to delegating", () => {
    expect(actionLabel("webfetch", "https://example.com/a/b")).toBe("Fetching example.com");
    expect(actionLabel("task", "")).toBe("Delegating");
  });

  it("falls back to a capitalized name for unknown tools", () => {
    expect(actionLabel("frobnicate", "")).toBe("Frobnicate");
  });

  it("handles empty detail without a trailing space", () => {
    expect(actionLabel("read", "")).toBe("Reading");
    expect(actionLabel("bash", "")).toBe("Running");
  });
});
