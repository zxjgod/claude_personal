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
      <StatusLine label="Reading App.tsx" startedAt={startedAt} tokens={1234} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Reading App.tsx");
    expect(frame).toMatch(/1[56]s/); // ~16s (allow tiny timing slack)
    expect(frame).toContain("1.2k tokens");
  });

  it("omits the token suffix when tokens is zero", () => {
    const { lastFrame } = render(<StatusLine label="Thinking" startedAt={Date.now()} tokens={0} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Thinking");
    expect(frame).not.toContain("tokens");
  });
});
