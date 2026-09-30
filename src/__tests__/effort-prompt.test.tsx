import chalk from "chalk";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../tui/App.js";
import { EffortPrompt } from "../tui/EffortPrompt.js";
import { setLanguage } from "../tui/i18n.js";
import { TuiStore } from "../tui/store.js";
import { stripAnsi } from "../tui/terminal-width.js";

let previousColorLevel: typeof chalk.level;
const wait = (milliseconds = 30) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const backgrounds = (frame: string | undefined) => (frame?.match(/48;2;/g) ?? []).length;

beforeEach(() => {
  previousColorLevel = chalk.level;
  chalk.level = 3;
  vi.stubEnv("CCR_REDUCED_MOTION", "0");
  setLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  chalk.level = previousColorLevel;
  vi.unstubAllEnvs();
});

describe("effort reference animation interaction", () => {
  it("slows the xhigh sweep and uses a soft lavender highlight", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const { lastFrame, unmount } = render(
      <EffortPrompt overlay={{ kind: "effort", current: "xhigh", resolve: () => {} }} />,
    );
    try {
      const initial = lastFrame();
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 160);
      await wait(710);
      expect(lastFrame()).not.toBe(initial);
      expect(lastFrame()).toContain("38;2;208;180;232");
      expect(lastFrame()).not.toContain("38;2;255;255;255");
      expect(stripAnsi(lastFrame() ?? "")).toBe(stripAnsi(initial ?? ""));
    } finally {
      unmount();
    }
  });

  it("runs the max rainbow on a faster clock without moving the panel", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const { lastFrame, unmount } = render(
      <EffortPrompt overlay={{ kind: "effort", current: "max", resolve: () => {} }} />,
    );
    try {
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 60);
      const initial = lastFrame();
      await wait(150);
      expect(lastFrame()).not.toBe(initial);
      expect(stripAnsi(lastFrame() ?? "")).toBe(stripAnsi(initial ?? ""));
    } finally {
      unmount();
    }
  });

  it("grows outward after moving right to ultracode and restarts on re-entry", async () => {
    const resolve = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <EffortPrompt overlay={{ kind: "effort", current: "max", resolve }} />,
    );
    try {
      await wait();
      stdin.write("\x1b[C");
      await wait();
      const initial = backgrounds(lastFrame());
      await wait(280);
      const expanded = backgrounds(lastFrame());
      expect(initial).toBeGreaterThan(0);
      expect(expanded).toBeGreaterThan(initial);
      expect(stripAnsi(lastFrame() ?? "")).not.toContain("Enter select");
      stdin.write("\x1b[D");
      await wait();
      expect(backgrounds(lastFrame())).toBe(0);
      stdin.write("\x1b[C");
      await wait();
      expect(backgrounds(lastFrame())).toBeLessThan(expanded);
      stdin.write("\r");
      await wait();
      expect(resolve).toHaveBeenCalledWith("ultracode");
    } finally {
      unmount();
    }
  });

  it.each([
    "xhigh",
    "max",
    "ultracode",
  ] as const)("keeps %s static when reduced motion is enabled", async (current) => {
    vi.stubEnv("CCR_REDUCED_MOTION", "1");
    const { lastFrame, unmount } = render(
      <EffortPrompt overlay={{ kind: "effort", current, resolve: () => {} }} />,
    );
    try {
      const initial = lastFrame();
      if (current === "ultracode") expect(backgrounds(initial)).toBeGreaterThan(100);
      await wait(180);
      expect(lastFrame()).toBe(initial);
    } finally {
      unmount();
    }
  });

  it("hides the normal footer while effort is open and restores it on cancel", async () => {
    const store = new TuiStore("test/model");
    const selection = store.askEffort("xhigh");
    const { stdin, lastFrame, unmount } = render(
      <App store={store} commands={[]} onSubmit={() => {}} />,
    );
    try {
      const text = stripAnsi(lastFrame() ?? "");
      expect(text).toContain("Effort");
      expect(text.match(/to adjust/g)).toHaveLength(1);
      expect(text).not.toContain("? for shortcuts");
      expect(text).not.toContain("test/model");
      await wait();
      stdin.write("\x1b");
      await wait(80);
      await expect(selection).resolves.toBeNull();
      expect(stripAnsi(lastFrame() ?? "")).toContain("? for shortcuts");
    } finally {
      unmount();
    }
  });
});
