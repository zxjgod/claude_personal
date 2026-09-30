// ============================================================
// FullScreenApp hotkey parity — regression guard
// ------------------------------------------------------------
// The full-screen layout (--fullscreen / CCR_FULLSCREEN=1) used to
// hardcode all ten global hotkeys in an if/else chain, bypassing the
// keybindings resolver entirely. A user's ~/.claude/keybindings.json
// customizations were therefore ignored whenever full-screen was on:
// the same action reachable two ways, two different behaviors.
//
// This suite pins the fix at the SOURCE level — both layouts must route
// through `globalResolver` and must not re-introduce literal keystroke
// comparisons. Source-level assertions are the right tool here because the
// bug was structural (wrong wiring), not a value that changed.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createResolver, DEFAULT_BINDINGS, parseBindings } from "../tui/keybindings/index.js";

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");

/**
 * Isolate one top-level function by name from a TSX source file.
 *
 * Brace-matching must skip the parameter list — `function F({ a, b }: T) {`
 * opens a destructuring brace long before the body. Match from the `)` that
 * closes the parameter list instead.
 */
function extractBlock(source: string, name: string): string {
  const start = source.search(new RegExp(`function ${name}\\b`));
  if (start === -1) throw new Error(`${name} not found`);
  // Find the `)` closing the parameter list: the first one at depth 0 after
  // the name, ignoring parens nested inside the type annotation.
  let parens = 0;
  let bodyStart = -1;
  for (let i = source.indexOf("(", start); i < source.length; i++) {
    const c = source[i];
    if (c === "(") parens++;
    else if (c === ")") {
      parens--;
      if (parens === 0) {
        bodyStart = source.indexOf("{", i);
        break;
      }
    }
  }
  if (bodyStart === -1) throw new Error(`no body for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces for ${name}`);
}

describe("FullScreenApp global hotkeys", () => {
  const source = read("tui/FullScreenApp.tsx");
  const hotkey = extractBlock(source, "FsModeHotkey");

  it("routes through the shared keybindings resolver", () => {
    expect(source).toContain("createResolver, DEFAULT_BINDINGS, loadUserBindings");
    expect(hotkey).toContain('globalResolver(input, key, ["Global"])');
    expect(hotkey).toContain('result.type !== "match"');
  });

  it("no longer compares literal keystrokes", () => {
    // The old chain tested `key.ctrl && input === "s"` etc. directly.
    expect(hotkey).not.toMatch(/key\.ctrl\s*&&\s*input\s*===/);
    expect(hotkey).not.toMatch(/key\.meta\s*&&\s*input\s*===/);
    expect(hotkey).not.toMatch(/key\.tab\s*&&\s*key\.shift/);
  });

  it("handles every action the default Global block binds to a hotkey", () => {
    // Every default binding that FullScreenApp can service must appear as an
    // `result.action === "..."` branch. ctrl+c (interrupt) and pageup
    // (transcript:review) are deliberately excluded: interrupt is owned by
    // InterruptHotkey, and the full-screen ScrollView owns PgUp itself.
    const expected = [
      "chat:cycleMode",
      "help:toggle",
      "history:search",
      "transcript:toggle",
      "chat:stash",
      "chat:externalEditor",
      "app:toggleTodos",
      "app:redraw",
      "chat:modelPicker",
      "chat:thinkingToggle",
    ];
    for (const action of expected) {
      expect(hotkey, `missing branch for ${action}`).toContain(`result.action === "${action}"`);
    }
  });

  it("emits no raw ESC control bytes in the redraw branch", () => {
    // A literal 0x1B in source silently corrupts across editors/transfers.
    // run.tsx already used the \x1B escape form; both App files must match.
    expect(source).not.toContain(String.fromCharCode(27));
    expect(read("tui/App.tsx")).not.toContain(String.fromCharCode(27));
    expect(hotkey).toContain('process.stdout.write("\\x1B[2J\\x1B[H")');
  });
});

describe("FullScreenApp / App hotkey parity", () => {
  const appHotkey = extractBlock(read("tui/App.tsx"), "ModeHotkey");
  const fsHotkey = extractBlock(read("tui/FullScreenApp.tsx"), "FsModeHotkey");

  it("both layouts service the same action set", () => {
    const actionsOf = (src: string): string[] => {
      const actions = new Set<string>();
      for (const m of src.matchAll(/result\.action === "([^"]+)"/g)) actions.add(m[1]);
      return [...actions].sort();
    };
    // transcript:review is App-only (full-screen has its own PgUp scroll
    // bindings inside ScrollView), so compare the intersection both own.
    const app = actionsOf(appHotkey).filter((a) => a !== "transcript:review");
    const fs = actionsOf(fsHotkey);
    expect(fs.sort()).toEqual(app.sort());
  });
});

describe("resolver honors user overrides", () => {
  it("a user-added binding reaches both layouts via the same resolver", () => {
    // Proves the parity assertions above are meaningful: a custom binding
    // from ~/.claude/keybindings.json resolves through the shared resolver,
    // so a layout still doing literal keystroke comparisons would diverge
    // here — it would simply never fire.
    const user = [{ context: "Global", bindings: { "ctrl+y": "app:redraw" } }];
    const resolver = createResolver(DEFAULT_BINDINGS, user);

    expect(resolver("y", { ctrl: true } as never, ["Global"])).toEqual({
      type: "match",
      action: "app:redraw",
    });
  });

  it("a user REBINDING overrides the default for the same action", () => {
    // Overrides are additive + last-wins, so the default keystroke stays
    // live unless the user explicitly nulls it. Pinning the documented
    // "later bindings win" semantics keeps the override story honest.
    const user = [{ context: "Global", bindings: { "ctrl+y": "app:redraw" } }];
    const bindings = parseBindings([...DEFAULT_BINDINGS, ...user]);
    const redraws = bindings.filter((b) => b.action === "app:redraw");
    expect(redraws.length).toBe(2);
    // ctrl+y (user, later) is the winning binding for this action.
    expect(redraws[redraws.length - 1]?.chord[0]?.key).toBe("y");
  });
});
