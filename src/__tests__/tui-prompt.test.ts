import { describe, expect, it, vi } from "vitest";
import { resolveTurnSystemPrompt } from "../tui/run.js";

describe("TUI turn prompt assembly", () => {
  it("does not append the goal when the live builder already owns it", () => {
    const builder = vi.fn(() => "base\n\n[SESSION GOAL]\nship it");

    const prompt = resolveTurnSystemPrompt(
      { systemPrompt: "stale", buildTurnSystemPrompt: builder },
      "ship it",
    );

    expect(prompt).toBe("base\n\n[SESSION GOAL]\nship it");
    expect(prompt.match(/\[SESSION GOAL\]/g)).toHaveLength(1);
    expect(builder).toHaveBeenCalledOnce();
  });

  it("keeps the fallback goal behavior for embedders without a builder", () => {
    expect(resolveTurnSystemPrompt({ systemPrompt: "base" }, "ship it")).toContain(
      "[SESSION GOAL]",
    );
  });
});
