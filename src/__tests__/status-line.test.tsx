// ============================================================
// Tests: StatusLine + status label (M23.2 / M23.3)
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StatusLine, shimmerParts } from "../tui/StatusLine.js";

describe("shimmerParts", () => {
  it("reconstructs the original label from its three spans", () => {
    const label = "Reading App.tsx";
    const { before, shimmer, after } = shimmerParts(label, 0);
    expect(before + shimmer + after).toBe(label);
  });
});

describe("StatusLine", () => {
  it("renders the label, an elapsed clock, and a token count", () => {
    const startedAt = Date.now() - 16_000; // ~16s ago
    const { lastFrame } = render(
      <StatusLine
        label="Reading App.tsx"
        startedAt={startedAt}
        tokens={1234}
        activityAt={Date.now()}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Reading App.tsx");
    expect(frame).toMatch(/1[56]s/); // ~16s (allow tiny timing slack)
    expect(frame).toContain("1.2k tokens");
  });

  it("omits the token suffix when tokens is zero", () => {
    const { lastFrame } = render(
      <StatusLine label="Thinking" startedAt={Date.now()} tokens={0} activityAt={Date.now()} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Thinking");
    expect(frame).not.toContain("tokens");
  });

  it("thinking phase shows the turn's sampled verb (official, mount-once)", () => {
    const { lastFrame } = render(
      <StatusLine
        label="Thinking"
        startedAt={1_700_000_000_000}
        tokens={0}
        activityAt={Date.now()}
        cycleVerbs
      />,
    );
    const frame = lastFrame()!;
    // The verb is deterministic for the seed; whatever it is, it ends with the
    // official ellipsis and is NOT the static label.
    expect(frame).toContain("…");
    expect(frame).not.toContain("Thinking");
  });
});
