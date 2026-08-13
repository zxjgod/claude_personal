// ============================================================
// Tests: Output styles — registry + system-prompt section switching
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import {
  getOutputStyle,
  listOutputStyles,
  outputStylePrompt,
  resetOutputStyles,
} from "../output-style.js";
import { buildSystemPrompt, renderSystemPrompt } from "../system-prompt.js";

afterEach(() => {
  resetOutputStyles();
});

describe("output style registry", () => {
  it("seeds default / explanatory / learning", () => {
    resetOutputStyles();
    expect(listOutputStyles().map((s) => s.name)).toEqual(["default", "explanatory", "learning"]);
  });

  it("looks up and registers styles", () => {
    resetOutputStyles();
    expect(getOutputStyle("explanatory")?.description).toContain("trade-offs");
    expect(getOutputStyle("nope")).toBeUndefined();
  });

  it("falls back to default for unknown names", () => {
    expect(outputStylePrompt("nope")).toBe(outputStylePrompt("default"));
    expect(outputStylePrompt(undefined)).toBe(outputStylePrompt("default"));
  });
});

describe("system-prompt integration", () => {
  it("switches the OUTPUT STYLE section per style", () => {
    const base = renderSystemPrompt(
      buildSystemPrompt({ workspaceRoot: "/x", tools: [], outputStyle: "default" }),
    );
    const explanatory = renderSystemPrompt(
      buildSystemPrompt({ workspaceRoot: "/x", tools: [], outputStyle: "explanatory" }),
    );

    expect(base).toContain("Be concise");
    expect(explanatory).toContain("Explain your reasoning");
    expect(explanatory).not.toContain("Be concise");
  });

  it("keeps the OUTPUT STYLE section inside the static prefix (above the boundary)", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/x", tools: [], outputStyle: "learning" });
    const joined = blocks.join("\n\n");
    const boundaryIndex = joined.indexOf("SYSTEM PROMPT DYNAMIC BOUNDARY");
    expect(joined.indexOf("learning session")).toBeGreaterThan(-1);
    expect(joined.indexOf("learning session")).toBeLessThan(boundaryIndex);
  });
});
