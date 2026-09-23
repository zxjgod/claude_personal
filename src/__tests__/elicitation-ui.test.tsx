// ============================================================
// Tests: ElicitationPrompt — schema validation on submit, paste
// input, backspace editing (regression guards for the 09-13 review)
// ============================================================

import { render } from "ink-testing-library";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../tui/i18n.js";
import { ElicitationPrompt } from "../tui/Prompts.js";
import type { Overlay } from "../tui/store.js";

beforeAll(() => setLanguage("en"));

function flush(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function overlay(
  fields: Extract<Overlay, { kind: "elicitation" }>["fields"],
  resolve: (result: never) => void,
): Extract<Overlay, { kind: "elicitation" }> {
  return { kind: "elicitation", message: "Fill in", fields, resolve } as Extract<
    Overlay,
    { kind: "elicitation" }
  >;
}

describe("ElicitationPrompt", () => {
  it("blocks submit on an out-of-range number, then accepts a valid edit", async () => {
    const resolve = vi.fn();
    const { stdin, lastFrame } = render(
      <ElicitationPrompt
        overlay={overlay([{ name: "count", type: "number", maximum: 10 }], resolve)}
      />,
    );
    await flush();
    stdin.write("50");
    await flush();
    stdin.write("\r");
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("must be ≤ 10");
    // Fix it: backspace twice (the original code inserted DEL here instead of
    // deleting), then type a valid value.
    stdin.write("\x7f\x7f");
    await flush();
    expect(lastFrame()).not.toContain("must be ≤ 10"); // stale error cleared
    stdin.write("5");
    await flush();
    stdin.write("\r");
    await waitFor(() => resolve.mock.calls.length > 0);
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: { count: 5 } });
  });

  it("rejects non-numeric text for a number field (no NaN to the server)", async () => {
    const resolve = vi.fn();
    const { stdin, lastFrame } = render(
      <ElicitationPrompt overlay={overlay([{ name: "size", type: "integer" }], resolve)} />,
    );
    await flush();
    stdin.write("abc");
    await flush();
    stdin.write("\r");
    await flush(30);
    expect(resolve).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("must be a number");
  });

  it("rejects a fractional value for an integer field (3.7 is finite, not whole)", async () => {
    const resolve = vi.fn();
    const { stdin, lastFrame } = render(
      <ElicitationPrompt overlay={overlay([{ name: "count", type: "integer" }], resolve)} />,
    );
    await flush();
    stdin.write("3.7");
    await flush();
    stdin.write("\r");
    await flush(30);
    expect(resolve).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("must be a whole number");
    // Editing clears the stale error; a valid integer submits as a number.
    stdin.write("\x7f\x7f\x7f");
    await flush();
    expect(lastFrame()).not.toContain("must be a whole number");
    stdin.write("7");
    await flush();
    stdin.write("\r");
    await waitFor(() => resolve.mock.calls.length > 0);
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: { count: 7 } });
  });

  it("enforces enum membership", async () => {
    const resolve = vi.fn();
    const { stdin, lastFrame } = render(
      <ElicitationPrompt
        overlay={overlay([{ name: "project", enum: ["alpha", "beta"] }], resolve)}
      />,
    );
    await flush();
    stdin.write("gamma");
    await flush();
    stdin.write("\r");
    await flush(30);
    expect(resolve).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("must be one of: alpha / beta");
    stdin.write("\x7f\x7f\x7f\x7f\x7f\x7f");
    await flush();
    stdin.write("beta");
    await flush();
    stdin.write("\r");
    await waitFor(() => resolve.mock.calls.length > 0);
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: { project: "beta" } });
  });

  it("accepts a multi-character paste and backspaces cleanly", async () => {
    const resolve = vi.fn();
    const { stdin } = render(
      <ElicitationPrompt overlay={overlay([{ name: "note", type: "string" }], resolve)} />,
    );
    await flush();
    // One write = one input event = what a bracketed paste delivers. The old
    // length-1 gate silently dropped everything pasted.
    stdin.write("hello there");
    await flush();
    stdin.write("\x7f"); // delete one char
    await flush();
    stdin.write("\r");
    await waitFor(() => resolve.mock.calls.length > 0);
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { note: "hello there".slice(0, -1) },
    });
  });
});
