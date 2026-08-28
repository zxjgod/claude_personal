// ============================================================
// Tests: StatusBar (shared bottom bar — model · mode · tokens · ctx · cost)
// ============================================================
// Renders into a virtual terminal whose width we control so both the full
// row and the narrow-terminal degradation path are observable.
//
// Width note: ink-testing-library renders Ink at a FIXED 100-column virtual
// terminal, while the StatusBar's own fitting logic reads
// process.stdout.columns. Tests set process.stdout.columns to match the
// scenario; the "full row" test keeps the total under 100 so Ink itself
// never truncates.
// ============================================================

import { render } from "ink-testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setLanguage } from "../tui/i18n.js";
import { gaugeBar, gaugeColor, StatusBar } from "../tui/StatusBar.js";
import { TuiStore } from "../tui/store.js";
import { palette } from "../tui/theme.js";

// Pin the UI language so literal-string assertions hold on zh-locale machines.
beforeAll(() => setLanguage("en"));

/** Force the terminal width the StatusBar fits itself against. */
function setColumns(cols: number): void {
  Object.defineProperty(process.stdout, "columns", {
    value: cols,
    configurable: true,
  });
}

afterEach(() => {
  setColumns(100);
});

describe("gauge helpers", () => {
  it("fills cells proportionally and clamps to the gauge width", () => {
    expect(gaugeBar(0)).toBe("░".repeat(8));
    expect(gaugeBar(0.5)).toBe("████░░░░");
    expect(gaugeBar(1)).toBe("█".repeat(8));
    expect(gaugeBar(1.5)).toBe("█".repeat(8)); // clamped
  });

  it("colors by threshold: success → warn (75%) → critical (90%)", () => {
    expect(gaugeColor(0.28)).toBe(palette.success);
    expect(gaugeColor(0.75)).toBe("#e0af68");
    expect(gaugeColor(0.9)).toBe(palette.error);
  });
});

describe("StatusBar", () => {
  it("shows model, friendly mode badge, k-formatted tokens, gauge, and cost", () => {
    setColumns(100);
    // Short label so the full row (all six segments) fits the 100-col frame.
    const store = new TuiStore("prov/m", { modelId: "deepseek-chat" });
    store.setPermissionMode("acceptEdits");
    store.setContextLimit(100_000);
    store.addUsage(20_000, 3_100, { read: 5_000 }, 28_100);
    const { lastFrame } = render(<StatusBar store={store} />);
    const frame = lastFrame()!;
    expect(frame).toContain("prov/m");
    expect(frame).toContain("accept edits"); // friendly label, not acceptEdits
    expect(frame).toContain("↑20k ↓3.1k tokens");
    expect(frame).toContain("28%");
    expect(frame).toContain("$"); // best-effort cost from the pricing table
  });

  it("shows an absolute ctx estimate when the model's window is unknown", () => {
    setColumns(100);
    const store = new TuiStore("some/unknown", { modelId: "totally-unknown" });
    store.addUsage(20_000, 3_100, undefined, 23_100);
    const { lastFrame } = render(<StatusBar store={store} />);
    const frame = lastFrame()!;
    expect(frame).toContain("ctx 23k"); // formatTokens rounds ≥10k to integers
    expect(frame).not.toContain("%"); // no limit → no percentage to plot
  });

  it("degrades on narrow terminals: cost first, then the model label", () => {
    setColumns(100);
    const store = new TuiStore("deepseek/chat", { modelId: "deepseek-chat" });
    store.setContextLimit(100_000);
    store.addUsage(20_000, 3_100, { read: 5_000 }, 28_100);
    const wide = render(<StatusBar store={store} />).lastFrame()!;
    expect(wide).toContain("deepseek/chat");
    expect(wide).toContain("28%");

    // Narrow: the full row would wrap, so segments drop until it fits — cost,
    // the gauge bar, then the model label. Mode badge and tokens survive.
    setColumns(70);
    const narrow = render(<StatusBar store={store} />).lastFrame()!;
    expect(narrow).toContain("default");
    expect(narrow).toContain("↑20k ↓3.1k");
    expect(narrow).not.toContain("deepseek/chat");
    expect(narrow.split("\n")).toHaveLength(1); // never wraps
  });

  it("swaps the hint text for the busy state (Esc/Ctrl+C interrupt)", () => {
    setColumns(100);
    const store = new TuiStore("p/m");
    store.setBusy(true);
    const { lastFrame } = render(<StatusBar store={store} />);
    expect(lastFrame()).toContain("working");
    expect(lastFrame()).toContain("Esc/Ctrl+C");
  });

  it("shows the queued-N badge while busy, hides it when idle or empty", () => {
    setColumns(100);
    const store = new TuiStore("p/m");
    store.setBusy(true);
    store.setQueuedInputs(2);
    const busy = render(<StatusBar store={store} />).lastFrame()!;
    expect(busy).toContain("queued 2");
    store.setQueuedInputs(0);
    const drained = render(<StatusBar store={store} />).lastFrame()!;
    expect(drained).not.toContain("queued");
    store.setQueuedInputs(3);
    store.setBusy(false);
    const idle = render(<StatusBar store={store} />).lastFrame()!;
    expect(idle).not.toContain("queued"); // queue only matters mid-turn
  });
});
