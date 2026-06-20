// ============================================================
// Tests: InputBox editing + slash-command behavior
// ============================================================
// Drives the component through ink-testing-library's stdin to verify cursor
// editing and that "/" + Enter runs the highlighted command (not a bare "/").
// ============================================================

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { InputBox } from "../tui/InputBox.js";

const commands = [
  { name: "help", description: "Show help" },
  { name: "clear", description: "Clear history" },
  { name: "model", description: "Switch model" },
];

const ARROW_DOWN = "[B";
const ENTER = "\r";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

describe("InputBox slash-command submit", () => {
  it("submits the highlighted command when Enter is pressed after '/'", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox commands={commands} disabled={false} onSubmit={onSubmit} />,
    );
    await flush();
    stdin.write("/"); // open the palette (all commands)
    await flush();
    stdin.write(ENTER); // Enter on the highlighted (first) command
    await flush();
    // Must NOT submit a bare "/" (which would be "Unknown command: /").
    expect(onSubmit).toHaveBeenCalledWith("/help");
  });

  it("lets ↓ change the selection before Enter runs it", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox commands={commands} disabled={false} onSubmit={onSubmit} />,
    );
    await flush();
    stdin.write("/");
    await flush();
    stdin.write(ARROW_DOWN); // move to second command (/clear)
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("/clear");
  });

  it("submits raw text once arguments are typed after the command", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox commands={commands} disabled={false} onSubmit={onSubmit} />,
    );
    await flush();
    stdin.write("/model gpt-4o");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("/model gpt-4o");
  });
});
