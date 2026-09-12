// ============================================================
// Tests: HelpPanel — shortcut reference + permission-mode list
// ============================================================
// The panel had no coverage at all. These lock in the two invariants its
// header comment states: the mode list follows PERMISSION_MODE_CYCLE (the same
// constant Shift+Tab cycles), and all copy is translated rather than inlined.
// ============================================================

import { render } from "ink-testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HelpPanel } from "../tui/HelpPanel.js";
import { setLanguage } from "../tui/i18n.js";
import { PERMISSION_MODE_CYCLE } from "../tui/store.js";

beforeAll(() => setLanguage("en"));
afterEach(() => setLanguage("en"));

const noop = () => {};

describe("HelpPanel", () => {
  it("renders the title and both section headings", () => {
    const { lastFrame } = render(<HelpPanel currentMode="default" onClose={noop} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Keyboard shortcuts");
    expect(frame).toContain("Global shortcuts");
    expect(frame).toContain("Permission modes (Shift+Tab to cycle)");
    expect(frame).toContain("Esc or Enter to close");
  });

  it("lists the permission modes in the order Shift+Tab actually cycles", () => {
    const { lastFrame } = render(<HelpPanel currentMode="default" onClose={noop} />);
    const frame = lastFrame()!;
    // The panel previously printed default→acceptEdits→bypassPermissions→plan
    // while the shortcut row directly beneath it printed the correct order.
    const order = PERMISSION_MODE_CYCLE.map((m) => frame.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(PERMISSION_MODE_CYCLE).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  });

  it("marks the current mode and only that one", () => {
    const { lastFrame } = render(<HelpPanel currentMode="plan" onClose={noop} />);
    const marked = lastFrame()!
      .split("\n")
      .filter((l) => l.includes("❯"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("plan");
  });

  it("translates the copy when the language is Chinese", () => {
    setLanguage("zh-CN");
    const { lastFrame } = render(<HelpPanel currentMode="default" onClose={noop} />);
    const frame = lastFrame()!;
    expect(frame).toContain("键盘快捷键");
    expect(frame).toContain("全局快捷键");
    expect(frame).not.toContain("Keyboard shortcuts");
  });

  const pressAndCount = async (key: string): Promise<number> => {
    let closed = 0;
    const { stdin } = render(<HelpPanel currentMode="default" onClose={() => closed++} />);
    // Ink dispatches stdin on the next tick, not synchronously in write().
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(key);
    await new Promise((r) => setTimeout(r, 50));
    return closed;
  };

  it("dismisses on Enter", async () => {
    expect(await pressAndCount("\r")).toBe(1);
  });

  it("dismisses on Escape", async () => {
    expect(await pressAndCount("\x1b")).toBe(1);
  });
});
