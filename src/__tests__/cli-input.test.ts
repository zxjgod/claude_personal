// ============================================================
// Tests: EOF-safe CLI input reader
// ============================================================

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createCliInputReader } from "../cli-input.js";

class FakeReadline extends EventEmitter {
  closed = false;

  line(value: string): void {
    this.emit("line", value);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }
}

describe("createCliInputReader", () => {
  it("returns null on EOF instead of throwing ERR_USE_AFTER_CLOSE", async () => {
    const rl = new FakeReadline();
    const reader = createCliInputReader(rl as any);

    rl.close();

    await expect(reader.askQuestion("> ")).resolves.toBeNull();
    expect(reader.isClosed()).toBe(true);
  });

  it("readInput returns null when stdin is already closed", async () => {
    const rl = new FakeReadline();
    const reader = createCliInputReader(rl as any);
    rl.close();

    await expect(reader.readInput()).resolves.toBeNull();
  });

  it("reads a normal single line", async () => {
    const rl = new FakeReadline();
    const reader = createCliInputReader(rl as any);
    rl.line("hello");

    await expect(reader.readInput()).resolves.toBe("hello");
  });

  it("reads backslash-continuation multiline input", async () => {
    const rl = new FakeReadline();
    const reader = createCliInputReader(rl as any);
    rl.line("one\\");
    rl.line("two");

    await expect(reader.readInput()).resolves.toBe("one\ntwo");
  });

  it("reads fenced multiline input", async () => {
    const rl = new FakeReadline();
    const reader = createCliInputReader(rl as any);
    rl.line("```js");
    rl.line("const x = 1;");
    rl.line("```");

    await expect(reader.readInput()).resolves.toBe("```js\nconst x = 1;\n```");
  });

  it("uses partial multiline input if EOF occurs mid-block", async () => {
    const rl = new FakeReadline();
    const reader = createCliInputReader(rl as any);
    rl.line("```js");
    rl.line("const x = 1;");
    rl.close();

    await expect(reader.readInput()).resolves.toBe("```js\nconst x = 1;");
    expect(reader.isClosed()).toBe(true);
  });

  it("drains multiple queued pipe lines across separate readInput calls", async () => {
    const rl = new FakeReadline();
    const reader = createCliInputReader(rl as any);
    rl.line("/tokens");
    rl.line("/tokens on");
    rl.line("exit");
    rl.close();

    await expect(reader.readInput()).resolves.toBe("/tokens");
    await expect(reader.readInput()).resolves.toBe("/tokens on");
    await expect(reader.readInput()).resolves.toBe("exit");
    await expect(reader.readInput()).resolves.toBeNull();
  });
});
