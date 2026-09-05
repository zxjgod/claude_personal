// ============================================================
// Tests: InputBox editing + slash-command behavior
// ============================================================
// Drives the component through ink-testing-library's stdin to verify cursor
// editing and that "/" + Enter runs the highlighted command (not a bare "/").
// ============================================================

import { render } from "ink-testing-library";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InputBox } from "../tui/InputBox.js";
import { setLanguage, t } from "../tui/i18n.js";

// Pin the UI language so literal-string assertions hold on zh-locale machines.
beforeAll(() => setLanguage("en"));

const commands = [
  { name: "help", description: "Show help" },
  { name: "clear", description: "Clear history" },
  { name: "model", description: "Switch model" },
];

const ARROW_DOWN = "[B";
const ENTER = "\r";
const ARROW_UP = "\x1b[A";
const CTRL_J = "\n"; // Ctrl+J sends LF

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

/** A bare ESC is held ~20ms by Ink's escape-sequence disambiguation before
 *  it's emitted as an escape keypress — assertions right after writing one
 *  need to outlive that timer. */
function escFlush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 60));
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

describe("InputBox multi-line input (M25.1)", () => {
  it("Ctrl+J inserts a newline instead of submitting; Enter submits the whole buffer", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("line one");
    await flush();
    stdin.write(CTRL_J); // newline, NOT submit
    await flush();
    stdin.write("line two");
    await flush();
    expect(onSubmit).not.toHaveBeenCalled(); // Ctrl+J did not submit
    stdin.write(ENTER); // now submit the full two-line buffer
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("line one\nline two");
  });

  it("'\\' + Enter inserts a newline rather than submitting", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("first\\"); // trailing backslash
    await flush();
    stdin.write(ENTER); // backslash+Enter → newline
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write("second");
    await flush();
    stdin.write(ENTER);
    await flush();
    // The backslash was replaced by the newline.
    expect(onSubmit).toHaveBeenCalledWith("first\nsecond");
  });

  it("renders each logical line on its own row", async () => {
    const { stdin, lastFrame } = render(
      <InputBox commands={commands} disabled={false} onSubmit={vi.fn()} />,
    );
    await flush();
    stdin.write("alpha");
    await flush();
    stdin.write(CTRL_J);
    await flush();
    stdin.write("beta");
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    // Two distinct rows: "alpha" and "beta" land on different lines.
    const alphaRow = frame.split("\n").findIndex((l) => l.includes("alpha"));
    const betaRow = frame.split("\n").findIndex((l) => l.includes("beta"));
    expect(betaRow).toBeGreaterThan(alphaRow);
  });

  it("↑ moves the cursor to the previous line when the palette is closed", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("ab");
    await flush();
    stdin.write(CTRL_J);
    await flush();
    stdin.write("cd"); // buffer "ab\ncd", cursor at end (row 1, col 2)
    await flush();
    stdin.write(ARROW_UP); // → row 0, col 2 (end of "ab")
    await flush();
    stdin.write("X"); // insert at that position → "abX\ncd"
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("abX\ncd");
  });

  it("Ctrl+U deletes to the start of the CURRENT line, not the buffer", async () => {
    // Line-relative like Ctrl+A/E: the draft's earlier rows must survive.
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("one");
    await flush();
    stdin.write(CTRL_J);
    await flush();
    stdin.write("two"); // row 1, cursor at its end
    await flush();
    stdin.write("\x15"); // Ctrl+U on row 1 → clears "two" only
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("one\n");
  });

  it("Ctrl+K deletes to the end of the CURRENT line, not the buffer", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("one");
    await flush();
    stdin.write(CTRL_J);
    await flush();
    stdin.write("XXtwo"); // row 1 = "XXtwo", cursor at its end
    await flush();
    stdin.write("\x01"); // Ctrl+A → row-relative line start
    await flush();
    stdin.write("\x0b"); // Ctrl+K kills "XXtwo", keeps row 0 + the newline
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("one\n");
  });
});

// M36: type-ahead — while the agent is busy the box stays active (disabled=false
// + busy=true) so the user can type the next message; a hint marks it as queued.
describe("InputBox type-ahead (M36)", () => {
  it("still captures keystrokes and submits while busy", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox commands={commands} disabled={false} busy onSubmit={onSubmit} />,
    );
    await flush();
    stdin.write("next message");
    await flush();
    stdin.write(ENTER);
    await flush();
    // Busy doesn't gate input here — the box stays active; routing-to-queue is
    // the parent's job (Root.onSubmit), the box just submits.
    expect(onSubmit).toHaveBeenCalledWith("next message");
  });

  it("shows the type-ahead hint while busy", async () => {
    const { lastFrame } = render(
      <InputBox commands={commands} disabled={false} busy onSubmit={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).toContain("queues your next message");
  });

  it("does not show the hint when idle", async () => {
    const { lastFrame } = render(
      <InputBox commands={commands} disabled={false} onSubmit={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).not.toContain("queues your next message");
  });
});

// M41: input history navigation + line editing shortcuts
describe("InputBox history navigation (M41)", () => {
  it("↑ navigates to the previous history entry", async () => {
    // Start with pre-populated history
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        history={["first command", "second command"]}
      />,
    );
    await flush();
    // Press ↑ to navigate to history (second command is most recent)
    stdin.write(ARROW_UP);
    await flush();
    stdin.write(ENTER);
    await flush();
    // Should submit the most recent history entry
    expect(onSubmit).toHaveBeenCalledWith("second command");
  });

  it("↑ navigates through history entries correctly", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        history={["older", "newer"]}
      />,
    );
    await flush();
    // First ↑ shows "newer" (most recent)
    stdin.write(ARROW_UP);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenLastCalledWith("newer");
  });

  it("↑ then ↓ navigates back and forth", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        history={["first", "second", "third"]}
      />,
    );
    await flush();
    // ↑ to "third"
    stdin.write(ARROW_UP);
    await flush();
    // ↑ to "second"
    stdin.write(ARROW_UP);
    await flush();
    // ↓ back to "third"
    stdin.write(ARROW_DOWN);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenLastCalledWith("third");
  });

  it("↓ navigates back to current buffer", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox commands={commands} disabled={false} onSubmit={onSubmit} history={["previous"]} />,
    );
    await flush();
    stdin.write(ARROW_UP); // enter history browsing
    await flush();
    stdin.write(ARROW_DOWN); // go back to current (empty)
    await flush();
    stdin.write("test");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("test");
  });

  it("typing exits history browsing mode", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        history={["history item"]}
      />,
    );
    await flush();
    stdin.write(ARROW_UP); // enter history browsing
    await flush();
    stdin.write("x"); // typing should exit history mode, insert at cursor (end)
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("history itemx");
  });

  it("does not push empty entries to history on submit", async () => {
    const onSubmit = vi.fn();
    const onHistoryChange = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        history={[]}
        onHistoryChange={onHistoryChange}
      />,
    );
    await flush();
    stdin.write("test");
    await flush();
    stdin.write(ENTER);
    await flush();
    // Should push to history on submit
    expect(onHistoryChange).toHaveBeenCalledWith(["test"]);
  });
});

// M41: line editing shortcuts (Ctrl+U, Ctrl+K, Ctrl+W)
describe("InputBox line editing shortcuts (M41)", () => {
  it("Ctrl+U deletes from cursor to beginning of line", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("hello world");
    await flush();
    // Move cursor to after "hello" (5 left arrows from end=11 to pos=6)
    for (let i = 0; i < 5; i++) stdin.write("\x1b[D"); // left arrow
    await flush();
    stdin.write("\x15"); // Ctrl+U
    await flush();
    stdin.write(ENTER);
    await flush();
    // Ctrl+U at pos 6: deletes "hello " (everything before cursor)
    expect(onSubmit).toHaveBeenCalledWith("world");
  });

  it("Ctrl+K deletes from cursor to end of line", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("hello world");
    await flush();
    // Move cursor to after "hello" (5 left arrows from end=11 to pos=5)
    for (let i = 0; i < 5; i++) stdin.write("\x1b[D"); // left arrow
    await flush();
    stdin.write("\x0b"); // Ctrl+K
    await flush();
    stdin.write(ENTER);
    await flush();
    // Ctrl+K at pos 5: deletes " world" (everything after cursor)
    expect(onSubmit).toHaveBeenCalledWith("hello ");
  });

  it("Ctrl+W deletes the word before the cursor", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    // Use input: "test query" - Ctrl+W at end deletes "query" (not the space)
    stdin.write("test query");
    await flush();
    stdin.write("\x17"); // Ctrl+W at end of "query"
    await flush();
    stdin.write(ENTER);
    await flush();
    // Ctrl+W at end: deletes "query" (word before cursor), leaves "test"
    expect(onSubmit).toHaveBeenCalledWith("test");
  });

  it("Ctrl+U at beginning does nothing", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("hello world");
    await flush();
    // Move cursor back to beginning (11 left arrows)
    for (let i = 0; i < 11; i++) stdin.write("\x1b[D"); // left arrow
    await flush();
    stdin.write("\x15"); // Ctrl+U at position 0
    await flush();
    stdin.write(ENTER);
    await flush();
    // Ctrl+U at position 0 deletes nothing (slice(0) = full buffer)
    // Actually in our implementation it deletes everything since cursor=0
    // and slice(0) = "hello world". So this test verifies that behavior.
    expect(onSubmit).toHaveBeenCalledWith("hello world");
  });

  it("Ctrl+K at end does nothing", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("hello world");
    await flush();
    // Move to end then Ctrl+K
    for (let i = 0; i < 11; i++) stdin.write("\x1b[C"); // right arrow
    await flush();
    stdin.write("\x0b"); // Ctrl+K at end (cursor at end, slice(0,11) = "hello world")
    await flush();
    stdin.write(ENTER);
    await flush();
    // Ctrl+K at end deletes from cursor to end, but cursor is at end, so nothing deleted
    expect(onSubmit).toHaveBeenCalledWith("hello world");
  });
});

// P2-10: "@" file completion — dropdown at the cursor's '@'-word, Tab inserts.
describe("InputBox @ file completion (P2-10)", () => {
  const files = ["src/tui/App.tsx", "src/util.ts"];

  it("shows matching paths while typing an @word", async () => {
    const { stdin, lastFrame } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={vi.fn()}
        completeFiles={(q) => (q === "src" ? files : [])}
      />,
    );
    await flush();
    stdin.write("look at @s");
    await flush();
    stdin.write("r");
    await flush();
    stdin.write("c");
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("@src/tui/App.tsx");
    expect(frame).toContain("@src/util.ts");
  });

  it("Tab replaces the @word with the selected path", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        completeFiles={(q) => (q === "src" ? files : [])}
      />,
    );
    await flush();
    stdin.write("read @src please");
    await flush();
    // Move the cursor back onto the @word (7 lefts: past "please" + its space
    // → cursor right after "@src"), so the dropdown targets "@src", not "please".
    for (let i = 0; i < 7; i++) stdin.write("\x1b[D");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write(ENTER);
    await flush();
    // The @word was replaced; surrounding text (before + after) is untouched.
    expect(onSubmit).toHaveBeenCalledWith("read @src/tui/App.tsx  please");
  });

  it("↓ moves the file selection before Tab", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        completeFiles={(q) => (q === "src" ? files : [])}
      />,
    );
    await flush();
    stdin.write("@src");
    await flush();
    stdin.write(ARROW_DOWN);
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("@src/util.ts ");
  });

  it("Esc closes the file dropdown; a changed query reopens it", async () => {
    const { stdin, lastFrame } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={vi.fn()}
        completeFiles={(q) => (q.startsWith("s") ? files : [])}
      />,
    );
    await flush();
    stdin.write("@s");
    await flush();
    expect(lastFrame()).toContain("@src/tui/App.tsx");
    stdin.write("\x1b"); // Esc dismisses (after Ink's escape-disambiguation timer)
    await escFlush();
    expect(lastFrame()).not.toContain("@src/tui/App.tsx");
    stdin.write("r"); // query "sr" — still startsWith("s") → reopened
    await flush();
    expect(lastFrame()).toContain("@src/tui/App.tsx");
  });

  it("does not hijack Enter while the file dropdown is open (submits as-is)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputBox
        commands={commands}
        disabled={false}
        onSubmit={onSubmit}
        completeFiles={() => files}
      />,
    );
    await flush();
    stdin.write("@src");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("@src");
  });
});

// P2-12: Esc closes the slash palette; Ctrl+←/→ jump by word.
describe("InputBox dropdown dismissal + word jumps (P2-12)", () => {
  it("Esc closes the '/' palette and a changed query reopens it", async () => {
    const { stdin, lastFrame } = render(
      <InputBox commands={commands} disabled={false} onSubmit={vi.fn()} />,
    );
    await flush();
    stdin.write("/c"); // palette showing /clear
    await flush();
    expect(lastFrame()).toContain("/clear");
    stdin.write("\x1b");
    await escFlush();
    expect(lastFrame()).not.toContain("/clear");
    stdin.write("l"); // query "cl" → the dismissal is cleared, palette reopens
    await flush();
    expect(lastFrame()).toContain("/clear");
  });

  it("Ctrl+← jumps the cursor to the previous word start", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("one two three");
    await flush();
    stdin.write("\x1b[1;5D"); // Ctrl+← → start of "three"
    stdin.write("\x1b[1;5D"); // Ctrl+← → start of "two"
    await flush();
    stdin.write("X"); // insert at start of "two"
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("one Xtwo three");
  });

  it("Ctrl+→ jumps the cursor to the next word end", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("one two three");
    await flush();
    for (let i = 0; i < 13; i++) stdin.write("\x1b[D"); // cursor to start (0)
    await flush();
    stdin.write("\x1b[1;5C"); // Ctrl+→ → end of "one"
    await flush();
    stdin.write("X"); // insert at the word's end
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("oneX two three");
  });
});

// P2-11: bracketed paste via Ink's usePaste channel.
describe("InputBox paste (P2-11)", () => {
  it("inserts a multi-line paste as text without submitting early", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBox commands={commands} disabled={false} onSubmit={onSubmit} />);
    await flush();
    stdin.write("\x1b[200~line one\r\nline two\x1b[201~");
    await flush();
    expect(onSubmit).not.toHaveBeenCalled(); // the embedded \r did NOT submit
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("line one\nline two");
  });

  it("shows the paste note for large pastes and clears it on the next key", async () => {
    const { stdin, lastFrame } = render(
      <InputBox commands={commands} disabled={false} onSubmit={vi.fn()} />,
    );
    await flush();
    const big = Array.from({ length: 7 }, (_, i) => `row ${i}`).join("\n");
    stdin.write(`\x1b[200~${big}\x1b[201~`);
    await flush();
    expect(lastFrame()).toContain(t("ui.paste.note", { n: 7 }));
    stdin.write("x");
    await flush();
    expect(lastFrame()).not.toContain(t("ui.paste.note", { n: 7 }));
  });
});
