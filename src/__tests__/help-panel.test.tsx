// ============================================================
// Tests: HelpPanel — shortcut reference + permission-mode list
// ============================================================
// The panel had no coverage at all. These lock in the two invariants its
// header comment states: the mode list follows PERMISSION_MODE_CYCLE (the same
// constant Shift+Tab cycles), and all copy is translated rather than inlined.
// ============================================================

import { render } from "ink-testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "../tui/App.js";
import { HelpPanel, helpLines } from "../tui/HelpPanel.js";
import { setLanguage, t } from "../tui/i18n.js";
import { PERMISSION_MODE_CYCLE, TuiStore } from "../tui/store.js";
import { visualWidth } from "../tui/terminal-width.js";

beforeAll(() => setLanguage("en"));
afterEach(() => setLanguage("en"));

const noop = () => {};

describe("HelpPanel", () => {
  it("renders the title and both section headings", () => {
    const { lastFrame } = render(
      <HelpPanel currentMode="default" onClose={noop} maxHeight={100} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Keyboard shortcuts");
    expect(frame).toContain("Global shortcuts");
    expect(frame).toContain("Permission modes (Shift+Tab to cycle)");
    expect(frame).toContain("Esc or Enter to close");
  });

  it("lists the permission modes in the order Shift+Tab actually cycles", () => {
    const { lastFrame } = render(
      <HelpPanel currentMode="default" onClose={noop} maxHeight={100} />,
    );
    const frame = lastFrame()!;
    // The panel previously printed default→acceptEdits→bypassPermissions→plan
    // while the shortcut row directly beneath it printed the correct order.
    const order = PERMISSION_MODE_CYCLE.map((m) => frame.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(PERMISSION_MODE_CYCLE).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  });

  it("marks the current mode and only that one", () => {
    const { lastFrame } = render(<HelpPanel currentMode="plan" onClose={noop} maxHeight={100} />);
    const marked = lastFrame()!
      .split("\n")
      .filter((l) => l.includes("❯"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("plan");
  });

  it("translates the copy when the language is Chinese", () => {
    setLanguage("zh-CN");
    const { lastFrame } = render(
      <HelpPanel currentMode="default" onClose={noop} maxHeight={100} />,
    );
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

  it.each([
    "en",
    "zh-CN",
  ] as const)("keeps all descriptions with aligned wrapped columns in %s", (language) => {
    setLanguage(language);
    for (const width of [36, 74, 134]) {
      const lines = helpLines(width, "bypassPermissions");
      expect(lines.every((line) => visualWidth(line.label + line.description) <= width)).toBe(true);
      const body = lines.filter((line) => line.label.length > 0);
      expect(new Set(body.map((line) => visualWidth(line.label))).size).toBe(1);
      const descriptions = lines
        .map((line) => line.description)
        .join("")
        .replace(/\s/g, "");
      for (const key of [
        "ui.help.shortcut.modeCycle",
        "ui.help.shortcut.interrupt",
        "ui.help.shortcut.fsBottom",
        "ui.help.mode.bypassPermissions",
      ]) {
        expect(descriptions).toContain(t(key).replace(/\s/g, ""));
      }
      expect(lines.some((line) => line.label.includes("bypassPermissions"))).toBe(width > 40);
    }
  });

  it.each([
    false,
    true,
  ])("scrolls all help content without opening transcript review (fullscreen=%s)", async (fullscreen) => {
    const store = new TuiStore("p/m");
    const app = render(<App store={store} commands={[]} onSubmit={noop} fullscreen={fullscreen} />);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 35));
    try {
      await flush();
      app.stdin.write("keep this draft");
      await flush();
      store.setShowHelp(true);
      await flush();
      expect(app.lastFrame()).toContain("Global shortcuts");
      expect((app.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(24);
      app.stdin.write("\x1b[6~");
      await flush();
      expect(store.getSnapshot().reviewing).toBe(false);
      app.stdin.write("\x1b[F");
      await flush();
      expect(app.lastFrame()).toContain("bypassPermissions");
      expect(app.lastFrame()).toContain("without prompting");
      app.stdin.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(store.getSnapshot().showHelp).toBe(false);
      expect(store.getSnapshot().draft.text).toBe("keep this draft");
    } finally {
      app.unmount();
    }
  });
});
