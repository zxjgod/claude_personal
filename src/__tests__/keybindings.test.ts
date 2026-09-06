// ============================================================
// Tests: keybindings parser + loader (Phase A2)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  chordToString,
  createResolver,
  DEFAULT_BINDINGS,
  getKeyName,
  type InkKey,
  parseBindings,
  parseBindingsFile,
  parseChord,
  parseKeystroke,
  resolveKey,
} from "../tui/keybindings/index.js";

describe("parseKeystroke", () => {
  it("parses modifiers + key", () => {
    expect(parseKeystroke("ctrl+shift+k")).toEqual({
      key: "k",
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      super: false,
    });
  });

  it("maps modifier aliases", () => {
    expect(parseKeystroke("cmd+x").super).toBe(true);
    expect(parseKeystroke("opt+x").alt).toBe(true);
    expect(parseKeystroke("control+x").ctrl).toBe(true);
  });

  it("maps named keys", () => {
    expect(parseKeystroke("esc").key).toBe("escape");
    expect(parseKeystroke("return").key).toBe("enter");
    expect(parseKeystroke("space").key).toBe(" ");
    expect(parseKeystroke("↑").key).toBe("up");
  });
});

describe("parseChord / chordToString", () => {
  it("parses a two-keystroke chord", () => {
    const chord = parseChord("ctrl+k ctrl+s");
    expect(chord).toHaveLength(2);
    expect(chord[0]!.key).toBe("k");
    expect(chord[1]!.key).toBe("s");
  });

  it("treats a lone space as the space key", () => {
    expect(parseChord(" ")).toHaveLength(1);
    expect(parseChord(" ")[0]!.key).toBe(" ");
  });

  it("formats a chord for display", () => {
    expect(chordToString(parseChord("ctrl+shift+k"))).toBe("ctrl+shift+k");
    expect(chordToString(parseChord("esc"))).toBe("Esc");
  });
});

describe("parseBindings", () => {
  it("flattens blocks into parsed bindings", () => {
    const parsed = parseBindings([
      {
        context: "Global",
        bindings: { "ctrl+k": "app:globalSearch", "ctrl+x": null },
      },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.action).toBe("app:globalSearch");
    expect(parsed[1]!.action).toBeNull();
  });
});

describe("match / resolver", () => {
  it("getKeyName maps Ink flags to normalized names", () => {
    expect(getKeyName("", { escape: true })).toBe("escape");
    expect(getKeyName("", { return: true })).toBe("enter");
    expect(getKeyName("", { upArrow: true })).toBe("up");
    expect(getKeyName("k", {})).toBe("k");
  });

  it("resolveKey matches a single-keystroke binding", () => {
    const bindings = parseBindings([
      { context: "Global", bindings: { "shift+tab": "chat:cycleMode" } },
    ]);
    const key: InkKey = { shift: true, tab: true };
    expect(resolveKey("", key, ["Global"], bindings)).toEqual({
      type: "match",
      action: "chat:cycleMode",
    });
    expect(resolveKey("x", {}, ["Global"], bindings)).toEqual({ type: "none" });
  });

  it("createResolver merges user overrides (last wins)", () => {
    const resolve = createResolver(
      [{ context: "Global", bindings: { "?": "help:toggle" } }],
      [{ context: "Global", bindings: { "?": "app:globalSearch" } }],
    );
    expect(resolve("?", {}, ["Global"])).toEqual({ type: "match", action: "app:globalSearch" });
  });

  it("default bindings map ctrl+r to history:search (official, batch B)", () => {
    const resolve = createResolver(DEFAULT_BINDINGS, null);
    expect(resolve("r", { ctrl: true }, ["Global"])).toEqual({
      type: "match",
      action: "history:search",
    });
    // A user override can move the search off ctrl+r entirely.
    const remapped = createResolver(DEFAULT_BINDINGS, [
      { context: "Global", bindings: { "ctrl+r": null, "ctrl+f": "history:search" } },
    ]);
    expect(remapped("r", { ctrl: true }, ["Global"])).toEqual({ type: "unbound" });
    expect(remapped("f", { ctrl: true }, ["Global"])).toEqual({
      type: "match",
      action: "history:search",
    });
  });

  it("batch B defaults: stash/editor/todos/redraw on ctrl+s/g/t/l, pickers on meta+p/t", () => {
    const resolve = createResolver(DEFAULT_BINDINGS, null);
    expect(resolve("s", { ctrl: true }, ["Global"])).toEqual({
      type: "match",
      action: "chat:stash",
    });
    expect(resolve("g", { ctrl: true }, ["Global"])).toEqual({
      type: "match",
      action: "chat:externalEditor",
    });
    expect(resolve("t", { ctrl: true }, ["Global"])).toEqual({
      type: "match",
      action: "app:toggleTodos",
    });
    expect(resolve("l", { ctrl: true }, ["Global"])).toEqual({
      type: "match",
      action: "app:redraw",
    });
    expect(resolve("p", { meta: true }, ["Global"])).toEqual({
      type: "match",
      action: "chat:modelPicker",
    });
    expect(resolve("t", { meta: true }, ["Global"])).toEqual({
      type: "match",
      action: "chat:thinkingToggle",
    });
  });
});

describe("parseBindingsFile (shape validation)", () => {
  it("returns null for a bindings array of nulls instead of throwing", () => {
    // `{"bindings":[null]}` used to reach parseBindings and throw a
    // TypeError at App MODULE SCOPE (resolver created at import) — a typo'd
    // keybindings.json took the whole TUI down at startup.
    expect(parseBindingsFile('{"bindings":[null]}')).toBeNull();
    expect(parseBindingsFile('{"bindings":["nope", 42, false]}')).toBeNull();
  });

  it("keeps well-formed blocks and drops malformed siblings", () => {
    const blocks = parseBindingsFile(
      JSON.stringify({
        bindings: [
          { context: "Global", bindings: { g: "app:globalSearch" } },
          null,
          { context: "Global", bindings: { x: 123 } }, // non-string action
          { bindings: { y: "help:toggle" } }, // missing context
        ],
      }),
    );
    expect(blocks).toEqual([{ context: "Global", bindings: { g: "app:globalSearch" } }]);
  });

  it("accepts null action values (explicit unbind) and bad JSON returns null", () => {
    const blocks = parseBindingsFile(
      '{"bindings":[{"context":"Global","bindings":{"ctrl+r":null}}]}',
    );
    expect(blocks).toEqual([{ context: "Global", bindings: { "ctrl+r": null } }]);
    expect(parseBindingsFile("{not json")).toBeNull();
    expect(parseBindingsFile('{"bindings":"not-an-array"}')).toBeNull();
  });
});
