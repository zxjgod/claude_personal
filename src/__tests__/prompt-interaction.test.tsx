import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../tui/App.js";
import { setLanguage } from "../tui/i18n.js";
import { PermissionPrompt, QuestionPrompt } from "../tui/Prompts.js";
import { TuiStore } from "../tui/store.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
beforeEach(() => setLanguage("en"));
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reference-style asking", () => {
  it("resets amendment mode and restores the first choice for the next queued request", async () => {
    const store = new TuiStore("test/model");
    const feedback = vi.fn();
    const first = store.askPermission("Request", "same action", undefined, undefined, undefined, {
      onAmend: feedback,
    });
    const second = store.askPermission("Request", "same action");
    const { stdin, lastFrame, unmount } = render(
      <App store={store} commands={[]} onSubmit={() => {}} />,
    );
    try {
      await flush();
      stdin.write("\t");
      await flush();
      stdin.write("先读取文件🙂");
      await flush();
      stdin.write("\x7f");
      await flush();
      stdin.write("\r");
      await expect(first).resolves.toBe("no");
      await flush();
      expect(feedback).toHaveBeenCalledWith("先读取文件");
      expect(lastFrame()).toContain("> 1. Yes");
      expect(lastFrame()).not.toContain("Tell Claude what to do differently");
      expect(lastFrame()).not.toContain("test/model");
      stdin.write("\r");
      await expect(second).resolves.toBe("yes");
    } finally {
      unmount();
      store.cancelOverlays();
    }
  });
  it("allows Tab feedback without approving the pending permission request", async () => {
    const store = new TuiStore("test/model");
    const onAmend = vi.fn();
    const answer = store.askPermission(
      "Run this command?",
      "npm test",
      undefined,
      undefined,
      undefined,
      { onAmend },
    );
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "permission") throw new Error("Permission overlay not shown");
    const { stdin, lastFrame, unmount } = render(
      <PermissionPrompt overlay={overlay} store={store} />,
    );
    try {
      await flush();
      expect(lastFrame()).not.toMatch(/[╭╮╰╯]/);
      expect(lastFrame()).toContain("Tab to amend");
      stdin.write("\t");
      await flush();
      stdin.write("Read the file first");
      await flush();
      stdin.write("\r");
      await expect(answer).resolves.toBe("no");
      expect(onAmend).toHaveBeenCalledWith("Read the file first");
    } finally {
      unmount();
      store.cancelOverlays();
    }
  });

  it("accepts an amended answer to an AI question", async () => {
    const store = new TuiStore("test/model");
    const answer = store.askQuestion(
      "Runtime",
      "Which runtime?",
      [{ label: "Node" }, { label: "Python" }],
      false,
    );
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "question") throw new Error("Question overlay not shown");
    const { stdin, lastFrame, unmount } = render(<QuestionPrompt overlay={overlay} />);
    try {
      await flush();
      expect(lastFrame()).toContain("1. Node");
      stdin.write("\t");
      await flush();
      stdin.write("Rust");
      await flush();
      stdin.write("\r");
      await expect(answer).resolves.toEqual(["Rust"]);
    } finally {
      unmount();
      store.cancelOverlays();
    }
  });
});
