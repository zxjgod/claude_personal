// ============================================================
// Tests: raw-mode interactive input (autocomplete + permission menu)
// ============================================================

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  type CommandInfo,
  createRawInputReader,
  promptPermissionMenu,
} from "../tui/cli-interactive.js";

// A fake raw-mode TTY stdin we can push keystrokes into.
class FakeStdin extends EventEmitter {
  isTTY = true;
  rawMode = false;
  setRawMode(v: boolean): this {
    this.rawMode = v;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  off(event: string, listener: (...args: any[]) => void): this {
    super.off(event, listener);
    return this;
  }
  key(seq: string): void {
    this.emit("data", Buffer.from(seq, "utf8"));
  }
}

function fakeStdout() {
  const chunks: string[] = [];
  const out = {
    isTTY: true,
    columns: 80,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { out, chunks };
}

const COMMANDS: CommandInfo[] = [
  { name: "help", description: "Show help" },
  { name: "clear", description: "Clear history" },
  { name: "compact", description: "Compact context" },
  { name: "model", description: "Switch model" },
];

describe("createRawInputReader (TTY)", () => {
  it("close resolves an outstanding input read and removes its listener", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });
    const pending = reader.readInput();
    reader.close();
    await expect(pending).resolves.toBeNull();
    expect(input.listenerCount("data")).toBe(0);
  });
  it("commits a typed line on Enter", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("h");
    input.key("i");
    input.key("\r");
    await expect(promise).resolves.toBe("hi");
  });

  it("Tab completes the highlighted slash command", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("/");
    input.key("c"); // filters to clear, compact
    input.key("\t"); // accept first (clear) → buffer "/clear "
    input.key("\r"); // submit completed buffer
    await expect(promise).resolves.toBe("/clear ");
  });

  it("filters the dropdown to matching commands", async () => {
    const input = new FakeStdin();
    const { out, chunks } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("/");
    input.key("h");
    // The paint after typing "h" is the last chunk that mentions a command.
    const paintFrame = [...chunks].reverse().find((c) => c.includes("/help")) ?? "";
    expect(paintFrame).toContain("help");
    expect(paintFrame).not.toContain("compact");
    input.key("\r"); // submit "/h" verbatim
    await expect(promise).resolves.toBe("/h");
  });
});

describe("promptPermissionMenu", () => {
  it("returns 'yes' when the first option is selected with Enter", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const promise = promptPermissionMenu({
      header: "Bash command",
      detail: "ls -la",
      input: input as any,
      output: out,
    });
    input.key("\r"); // first option (Yes)
    await expect(promise).resolves.toBe("yes");
  });

  it("returns 'no' on Escape", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const promise = promptPermissionMenu({
      header: "Bash command",
      input: input as any,
      output: out,
    });
    input.key("\x1b");
    await expect(promise).resolves.toBe("no");
  });

  it("returns 'always' when option 2 is chosen by number", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const promise = promptPermissionMenu({
      header: "Write request",
      input: input as any,
      output: out,
    });
    input.key("2");
    await expect(promise).resolves.toBe("always");
  });
});

// --- M-7: paste handling ---------------------------------------------------
// A terminal paste arrives as ONE data event carrying the whole pasted block;
// treating it as a single keypress corrupts the repaint region (embedded
// newlines) or fires unintended actions (embedded digits in menus, embedded
// escape sequences moving the cursor).

describe("paste handling (M-7)", () => {
  it("flattens a pasted multi-line block instead of submitting line by line", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("line1\nline2\r\nline3"); // one data event = paste-like burst
    input.key("\r"); // only an explicit Enter submits
    await expect(promise).resolves.toBe("line1 line2 line3");
  });

  it("treats bracketed paste markers as literal text", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("\x1b[200~multi\nline text\x1b[201~");
    input.key("\r");
    await expect(promise).resolves.toBe("multi line text");
  });

  it("does not interpret escape sequences inside pasted text", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("ab");
    input.key("cd\x1b[Aef"); // pasted up-arrow must not move the cursor
    input.key("\r");
    await expect(promise).resolves.toBe("abcdef");
  });

  it("swallows unknown escape sequences so their bytes never reach the buffer", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("x\x1b[1;5Ay"); // ctrl+arrow CSI — must not leak "[1;5A" as text
    input.key("\r");
    await expect(promise).resolves.toBe("xy");
  });

  it("a pasted ^C byte does not cancel the input", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.readInput();
    input.key("before\x03after"); // burst containing a control byte
    input.key("\r");
    await expect(promise).resolves.toBe("beforeafter");
  });

  it("askQuestion accepts pasted text with newlines as one answer", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const reader = createRawInputReader({ commands: COMMANDS, input: input as any, output: out });

    const promise = reader.askQuestion("Name? ");
    input.key("\x1b[200~foo\nbar\x1b[201~");
    input.key("\r");
    await expect(promise).resolves.toBe("foo bar");
  });

  it("a bracketed-pasted digit does not fire permission menu shortcuts", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const promise = promptPermissionMenu({
      header: "Bash command",
      input: input as any,
      output: out,
    });
    input.key("\x1b[200~1\x1b[201~"); // pasted "1" must NOT choose option 1
    input.key("2"); // a typed digit still chooses
    await expect(promise).resolves.toBe("always");
  });

  it("coalesced pasted digits do not fire permission menu shortcuts", async () => {
    const input = new FakeStdin();
    const { out } = fakeStdout();
    const promise = promptPermissionMenu({
      header: "Bash command",
      input: input as any,
      output: out,
    });
    input.key("13"); // one burst event — not a single-digit keypress
    input.key("\r"); // Enter picks the highlighted default (first option)
    await expect(promise).resolves.toBe("yes");
  });
});
