// ============================================================
// Tests: raw-mode interactive input (autocomplete + permission menu)
// ============================================================

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  type CommandInfo,
  createRawInputReader,
  promptPermissionMenu,
} from "../cli-interactive.js";

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
