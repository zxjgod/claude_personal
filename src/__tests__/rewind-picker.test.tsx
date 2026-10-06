import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../tui/App.js";
import { setLanguage } from "../tui/i18n.js";
import { RewindPicker } from "../tui/RewindPicker.js";
import { type Overlay, TuiStore } from "../tui/store.js";
import { visualWidth } from "../tui/terminal-width.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
beforeEach(() => setLanguage("en"));
function overlay(): Extract<Overlay, { kind: "rewind" }> {
  return {
    kind: "rewind",
    entries: [
      { turnIndex: 1, label: "hello", timestamp: "", filesChanged: 0 },
      {
        turnIndex: 2,
        label: "你有哪些功能",
        timestamp: "",
        timestampMs: Date.now() - 120000,
        filesChanged: 0,
      },
    ],
    resolve: vi.fn(),
  };
}

describe("official rewind presentation", () => {
  it.each([42, 120])("keeps labels within a %i-column terminal after resize", async (columns) => {
    const view = overlay();
    view.entries[1]!.label = "这是一条很长的用户请求，包含路径和说明。".repeat(10);
    const { stdout, stdin, lastFrame, unmount } = render(<RewindPicker overlay={view} />);
    Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
    stdout.emit("resize");
    await flush();
    expect((lastFrame() ?? "").split("\n").every((line) => visualWidth(line) <= columns)).toBe(
      true,
    );
    stdin.write("\x1b[A");
    stdin.write("\r");
    await flush();
    expect((lastFrame() ?? "").split("\n").every((line) => visualWidth(line) <= columns)).toBe(
      true,
    );
    unmount();
  });

  it("opens chronologically at current, with code-change summaries and an open divider", async () => {
    const view = overlay();
    const { lastFrame, stdin, unmount } = render(<RewindPicker overlay={view} />);
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame.indexOf("hello")).toBeLessThan(frame.indexOf("你有哪些功能"));
    expect(frame).toContain("> (current)");
    expect(frame).toContain("No code changes");
    expect(frame).toContain("Enter to continue · Esc to cancel");
    expect(frame).not.toMatch(/[╭╮╰╯]/);
    expect(frame).not.toContain("#2");
    stdin.write("\r");
    await flush();
    expect(view.resolve).toHaveBeenCalledWith(null);
    unmount();
  });

  it("matches the four-option confirmation for a turn without code changes", async () => {
    const { lastFrame, stdin, unmount } = render(<RewindPicker overlay={overlay()} />);
    await flush();
    stdin.write("\x1b[A");
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Confirm you want to restore");
    expect(frame).toContain("(2m ago)");
    expect(frame).toContain("The conversation will be forked.");
    expect(frame).toContain("The code will be unchanged.");
    expect(frame).toContain("> 1. Restore conversation");
    expect(frame).toContain("2. Summarize from here");
    expect(frame).toContain("3. Summarize up to here");
    expect(frame).toContain("4. Never mind");
    expect(frame).not.toContain("Restore code");
    unmount();
  });

  it("hides the permission footer while the rewind dialog owns the input", async () => {
    const store = new TuiStore("test/model");
    store.setPermissionMode("bypassPermissions");
    const pending = store.askRewind(overlay().entries);
    const { lastFrame, unmount } = render(<App store={store} commands={[]} onSubmit={() => {}} />);
    await flush();
    expect(lastFrame()).toContain("Rewind");
    expect(lastFrame()).not.toContain("bypass permissions");
    const active = store.getSnapshot().overlay;
    if (active?.kind === "rewind") active.resolve(null);
    await pending;
    unmount();
  });

  it("supports optional context when summarizing", async () => {
    const view = overlay();
    const { stdin, lastFrame, unmount } = render(<RewindPicker overlay={view} />);
    await flush();
    stdin.write("\x1b[A");
    stdin.write("\r");
    await flush();
    stdin.write("\x1b[B");
    await flush();
    expect(lastFrame()).toContain("Messages after this point will be summarized.");
    stdin.write("\t");
    await flush();
    stdin.write("focus on file paths");
    await flush();
    stdin.write("\r");
    await flush();
    expect(view.resolve).toHaveBeenCalledWith({
      turnIndex: 2,
      action: "summarize",
      context: "focus on file paths",
    });
    unmount();
  });

  it("windows long histories and supports Home/End without losing current", async () => {
    const view = overlay();
    view.entries = Array.from({ length: 40 }, (_, i) => ({
      turnIndex: i + 1,
      label: `prompt ${i}`,
      timestamp: "",
      filesChanged: 0,
    }));
    const { stdin, lastFrame, unmount } = render(<RewindPicker overlay={view} />);
    await flush();
    expect(lastFrame()).toContain("prompt 39");
    expect(lastFrame()).not.toContain("prompt 0");
    stdin.write("\x1b[H");
    await flush();
    expect(lastFrame()).toContain("> prompt 0");
    expect(lastFrame()).not.toContain("prompt 39");
    stdin.write("\x1b[F");
    await flush();
    expect(lastFrame()).toContain("> (current)");
    unmount();
  });
});
