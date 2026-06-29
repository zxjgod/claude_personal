// ============================================================
// Tests: InputBox editing + slash-command behavior
// ============================================================
// Drives the component through ink-testing-library's stdin to verify cursor
// editing and that "/" + Enter runs the highlighted command (not a bare "/").
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
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
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
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
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
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
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("/model gpt-4o");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("/model gpt-4o");
  });

  // Regression: selecting a high index, then narrowing the filtered list, used
  // to leave `selected` pointing past the end → `suggestions[selected].name`
  // crashed with "Cannot read properties of undefined (reading 'name')".
  it("clamps a stale selection when the filtered list shrinks (Enter)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("/"); // [help, clear, model], selected=0
    await flush();
    stdin.write(ARROW_DOWN); // selected=1
    stdin.write(ARROW_DOWN); // selected=2 (model)
    await flush();
    stdin.write("h"); // buffer "/h" → suggestions narrows to [help] (len 1)
    await flush();
    stdin.write(ENTER); // selected=2 is now out of range → must clamp to 0
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("/help");
  });

  it("clamps a stale selection when the filtered list shrinks (Tab)", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <InputBox commands={commands} disabled={false} onSubmit={onSubmit} />,
    );
    await flush();
    stdin.write("/");
    await flush();
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN); // selected=2
    await flush();
    stdin.write("c"); // "/c" → [clear] (len 1), selected stale at 2
    await flush();
    stdin.write("\t"); // Tab accepts the highlighted (clamped) completion
    await flush();
    // No crash, and the buffer fills with the clamped command.
    expect(lastFrame()).toContain("/clear");
  });
});

describe("InputBox horizontal rule width (M24.4 — DECAWM fix)", () => {
  // The rule must leave at least one column of slack vs the terminal width: a
  // rule exactly as wide as the terminal trips auto-wrap (DECAWM), which made
  // the input box jump on each ASCII keystroke. We assert the rendered rule is
  // strictly narrower than the terminal column count.
  it("renders a divider strictly narrower than the terminal width", async () => {
    const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
    const { lastFrame } = render(
      <InputBox commands={commands} disabled={false} onSubmit={vi.fn()} />,
    );
    await flush();
    const frame = lastFrame()!;
    // Find the longest run of box-drawing dashes in any rendered line.
    const longestRule = Math.max(
      0,
      ...frame.split("\n").map((line) => {
        const m = line.match(/─+/g);
        return m ? Math.max(...m.map((r) => r.length)) : 0;
      }),
    );
    expect(longestRule).toBeGreaterThan(0); // a rule was drawn
    expect(longestRule).toBeLessThan(cols); // …but not flush to the edge
  });
});
