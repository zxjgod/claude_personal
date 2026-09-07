// ============================================================
// Tests: spinner-core (shared spinner primitives, M23.1)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  actionLabel,
  ERROR_RED_HEX,
  formatDuration,
  formatTokens,
  GLYPH_FRAME_MS,
  glyphAt,
  ORANGE_HEX,
  pickVerb,
  SPINNER_FRAMES,
  SPINNER_VERBS,
  STALL_AFTER_MS,
  STALL_RAMP_MS,
  stalledGlyphColor,
  verbForTurn,
} from "../tui/spinner-core.js";

describe("SPINNER_VERBS / pickVerb", () => {
  it("are all gerunds (or -in' variants) and include the canonical ones", () => {
    expect(SPINNER_VERBS).toContain("Whisking");
    expect(SPINNER_VERBS).toContain("Pondering");
    expect(SPINNER_VERBS).toContain("Clauding"); // official 188-verb list marker
    expect(SPINNER_VERBS.length).toBeGreaterThan(150);
    for (const v of SPINNER_VERBS) expect(v).toMatch(/(ing|in')$/);
  });

  it("pickVerb returns a member of the list", () => {
    for (let i = 0; i < 20; i++) {
      expect(SPINNER_VERBS).toContain(pickVerb());
    }
  });
});

describe("verbForTurn (official mount-once sampling)", () => {
  it("always returns a member of the list", () => {
    for (let seed = 0; seed < 200; seed += 7) {
      expect(SPINNER_VERBS).toContain(verbForTurn(seed * 1_000_003));
    }
  });

  it("is stable for the whole turn (elapsed time no longer re-rolls it)", () => {
    const seed = 1_700_000_000_000;
    expect(verbForTurn(seed)).toBe(verbForTurn(seed));
  });

  it("different turns usually land on different verbs", () => {
    const seen = new Set<string>();
    for (let turn = 0; turn < 40; turn++) {
      seen.add(verbForTurn(turn * 60_000 + 1_700_000_000_000));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("stalledGlyphColor (official stall warning)", () => {
  it("stays orange before the stall threshold", () => {
    expect(stalledGlyphColor(0)).toBe(ORANGE_HEX);
    expect(stalledGlyphColor(STALL_AFTER_MS - 1)).toBe(ORANGE_HEX);
  });

  it("reaches error red after the full ramp", () => {
    expect(stalledGlyphColor(STALL_AFTER_MS + STALL_RAMP_MS)).toBe(ERROR_RED_HEX);
    expect(stalledGlyphColor(STALL_AFTER_MS + 10 * STALL_RAMP_MS)).toBe(ERROR_RED_HEX);
  });

  it("blends between the thresholds", () => {
    const mid = stalledGlyphColor(STALL_AFTER_MS + STALL_RAMP_MS / 2);
    expect(mid).not.toBe(ORANGE_HEX);
    expect(mid).not.toBe(ERROR_RED_HEX);
    expect(mid).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("glyphAt", () => {
  it("returns the first frame at t=0 and advances every GLYPH_FRAME_MS", () => {
    expect(glyphAt(0)).toBe(SPINNER_FRAMES[0]);
    expect(glyphAt(GLYPH_FRAME_MS)).toBe(SPINNER_FRAMES[1]);
    expect(glyphAt(GLYPH_FRAME_MS * 2)).toBe(SPINNER_FRAMES[2]);
  });

  it("plays the official platform-forked charset forwards then backwards", () => {
    // Official cadence: 6 forward + 5 reversed (first element dropped) = 11
    // frames; the peak ✽ plays ONCE per cycle — the naive full reverse
    // duplicated both endpoints and visibly stalled the animation. Platform
    // fork per official getDefaultCharacters(): darwin plays ✳, other
    // platforms substitute `*` (it renders poorly off macOS); Ghostty also
    // swaps ✽→*.
    expect(SPINNER_FRAMES.length).toBe(11);
    if (process.env.TERM !== "xterm-ghostty") {
      expect(SPINNER_FRAMES.filter((f) => f === "✽").length).toBe(1);
    }
    if (process.platform === "darwin") {
      expect(SPINNER_FRAMES).toContain("✳");
    } else {
      expect(SPINNER_FRAMES).toContain("*");
      expect(SPINNER_FRAMES).not.toContain("✳");
    }
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
