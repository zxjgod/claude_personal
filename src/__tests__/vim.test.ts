// ============================================================
// Tests: Vim mode engine (pure state machine + operators)
// ============================================================

import { describe, expect, it } from "vitest";
import { VimEngine } from "../tui/vim/index.js";

function keys(e: VimEngine, ...list: string[]): void {
  for (const k of list) e.handleKey(k);
}

describe("VimEngine — insert / normal", () => {
  it("inserts characters in INSERT mode", () => {
    const e = new VimEngine("");
    keys(e, "h", "i");
    expect(e.getText()).toBe("hi");
    expect(e.getMode()).toBe("insert");
  });

  it("Escape switches to normal mode", () => {
    const e = new VimEngine("abc");
    e.handleKey("Escape");
    expect(e.getMode()).toBe("normal");
  });

  it("i/a re-enter insert mode", () => {
    const e = new VimEngine("ab");
    e.handleKey("Escape");
    e.handleKey("0");
    e.handleKey("i");
    expect(e.getMode()).toBe("insert");
  });
});

describe("VimEngine — motions + operators", () => {
  it("x deletes the char under the cursor", () => {
    const e = new VimEngine("abc");
    keys(e, "Escape", "0", "x");
    expect(e.getText()).toBe("bc");
  });

  it("0 / $ move to line start / end", () => {
    const e = new VimEngine("hello world");
    keys(e, "Escape", "$");
    expect(e.getOffset()).toBe("hello world".length);
    e.handleKey("0");
    expect(e.getOffset()).toBe(0);
  });

  it("w moves to the start of the next word", () => {
    const e = new VimEngine("hello world");
    keys(e, "Escape", "0", "w");
    expect(e.getOffset()).toBe(6);
  });

  it("dd deletes the current line", () => {
    const e = new VimEngine("a\nb\nc");
    keys(e, "Escape", "g", "g", "d", "d");
    expect(e.getText()).toBe("b\nc");
  });

  it("yy then p yanks and pastes a line below", () => {
    const e = new VimEngine("one\ntwo");
    keys(e, "Escape", "g", "g", "y", "y", "p");
    expect(e.getText()).toBe("one\none\ntwo");
  });

  it("cw changes a word and enters insert mode", () => {
    const e = new VimEngine("hello world");
    keys(e, "Escape", "0", "c", "w");
    expect(e.getMode()).toBe("insert");
    expect(e.getText()).toBe(" world");
  });

  it("diw deletes the inner word under the cursor", () => {
    const e = new VimEngine("hello world");
    keys(e, "Escape", "0", "d", "i", "w");
    expect(e.getText()).toBe(" world");
  });

  it("r replaces the char under the cursor", () => {
    const e = new VimEngine("cat");
    keys(e, "Escape", "0", "r", "b");
    expect(e.getText()).toBe("bat");
  });
});
