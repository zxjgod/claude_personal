// ============================================================
// Tests: InterruptHotkey — Esc / Ctrl+C interrupt semantics (P2-9)
// ============================================================
// Esc aborts the in-flight turn (Claude Code muscle memory), Ctrl+C aborts
// too and exits when idle. Overlays/the review pager own the keyboard while
// active, and vim editor mode keeps Esc for normal-mode.
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { InterruptHotkey } from "../tui/run.js";
import { TuiStore } from "../tui/store.js";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
// Bare ESC is emitted after Ink's ~20ms escape-disambiguation timer.
const escFlush = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function setup(opts?: { editorMode?: { value: "default" | "vim" } }) {
  const store = new TuiStore("p/m");
  const controller = new AbortController();
  const ref = { current: controller } as { current: AbortController | null };
  const { stdin } = render(
    <InterruptHotkey store={store} controllerRef={ref} editorMode={opts?.editorMode} />,
  );
  return { store, controller, stdin };
}

describe("InterruptHotkey (P2-9)", () => {
  it("Esc aborts the running turn when busy", async () => {
    const { store, controller, stdin } = setup();
    store.setBusy(true);
    await flush();
    stdin.write("\x1b");
    await escFlush();
    expect(controller.signal.aborted).toBe(true);
  });

  it("Esc while idle does NOT abort or exit (nothing to interrupt)", async () => {
    const { store, controller, stdin } = setup();
    await flush();
    stdin.write("\x1b");
    await escFlush();
    expect(controller.signal.aborted).toBe(false);
  });

  it("Esc is left to vim editor mode (normal-mode switch) instead", async () => {
    const { store, controller, stdin } = setup({ editorMode: { value: "vim" } });
    store.setBusy(true);
    await flush();
    stdin.write("\x1b");
    await escFlush();
    expect(controller.signal.aborted).toBe(false); // vim keeps Esc
  });

  it("Esc is ignored while an overlay owns the keyboard", async () => {
    const { store, controller, stdin } = setup();
    store.setBusy(true);
    void store.askPermission("Bash request", "rm -rf /"); // overlay is up
    await flush();
    stdin.write("\x1b");
    await escFlush();
    // The overlay's own component handles its Esc (cancel); the turn keeps running.
    expect(controller.signal.aborted).toBe(false);
  });

  it("Esc is ignored while the transcript pager is open", async () => {
    const { store, controller, stdin } = setup();
    store.setBusy(true);
    store.setReviewing(true);
    await flush();
    stdin.write("\x1b");
    await escFlush();
    expect(controller.signal.aborted).toBe(false);
    store.setReviewing(false);
  });

  it("Ctrl+C still aborts when busy", async () => {
    const { store, controller, stdin } = setup();
    store.setBusy(true);
    await flush();
    stdin.write("\x03");
    await flush();
    expect(controller.signal.aborted).toBe(true);
  });
});
