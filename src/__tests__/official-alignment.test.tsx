// ============================================================
// Tests: Batch A official visual alignment (2026-09)
// ============================================================
// Covers the new chrome pieces: figures constants, PromptFooter priority
// chain + width degradation, the official permission dialog (option labels,
// y/a/n shortcuts, in-dialog Shift+Tab mode cycling), the banner version
// plumbing, and the i18n default-English policy for the footer strings.
// ============================================================

import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { renderBannerLines } from "../tui/banner.js";
import { BLACK_CIRCLE, POINTER, TOOL_RESULT } from "../tui/figures.js";
import { InputBox } from "../tui/InputBox.js";
import { setLanguage } from "../tui/i18n.js";
import { ctxColor, ctxRemainingText, PromptFooter } from "../tui/PromptFooter.js";
import { PermissionPrompt } from "../tui/Prompts.js";
import { TuiStore } from "../tui/store.js";
import { APP_VERSION } from "../version.js";

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("figures (official glyphs)", () => {
  it("exposes the tool bullet, pointer, and branch glyphs", () => {
    expect(["⏺", "●"]).toContain(BLACK_CIRCLE); // darwin vs win/linux
    expect(POINTER).toBe("❯");
    expect(TOOL_RESULT).toBe("⎿");
  });
});

describe("APP_VERSION", () => {
  it("reads the version from package.json (not a hardcoded literal)", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(APP_VERSION).not.toBe("1.0.0");
    expect(APP_VERSION).not.toBe("0.0.0");
  });

  it("flows into the startup banner", () => {
    const lines = renderBannerLines({
      version: APP_VERSION,
      model: "m",
      provider: "p",
      workspaceRoot: "/w",
    });
    expect(lines.join("\n")).toContain(`v${APP_VERSION}`);
  });
});

describe("PromptFooter (official hint row)", () => {
  beforeEach(() => setLanguage("en"));

  it("falls back to '? for shortcuts' in default mode when idle", async () => {
    const store = new TuiStore("p/m");
    const { lastFrame } = render(<PromptFooter store={store} />);
    await flush();
    expect(lastFrame()).toContain("? for shortcuts");
  });

  it("shows the official mode indicator for plan mode", async () => {
    const store = new TuiStore("p/m");
    store.setPermissionMode("plan");
    const { lastFrame } = render(<PromptFooter store={store} />);
    await flush();
    expect(lastFrame()).toContain("⏸ plan mode on");
    expect(lastFrame()).toContain("(shift+tab to cycle)");
    expect(lastFrame()).not.toContain("? for shortcuts");
  });

  it("shows 'esc to interrupt' while busy (highest priority)", async () => {
    const store = new TuiStore("p/m");
    store.setPermissionMode("plan");
    store.setBusy(true);
    const { lastFrame } = render(<PromptFooter store={store} />);
    await flush();
    expect(lastFrame()).toContain("esc to interrupt");
    expect(lastFrame()).not.toContain("plan mode on");
  });

  it("carries the model and official context-remaining phrasing on the right", async () => {
    const store = new TuiStore("deepseek/chat");
    store.setContextLimit(100_000);
    store.addUsage(80_000, 6_000, undefined, 86_000);
    const { lastFrame } = render(<PromptFooter store={store} />);
    await flush();
    expect(lastFrame()).toContain("deepseek/chat");
    expect(lastFrame()).toContain("14% until auto-compact"); // remaining, not used
  });

  it("shows the queued depth on the right while busy (type-ahead visibility)", async () => {
    const store = new TuiStore("p/m");
    store.setContextLimit(100_000);
    store.addUsage(50_000, 0, undefined, 50_000);
    store.setBusy(true);
    store.setQueuedInputs(2);
    const { lastFrame } = render(<PromptFooter store={store} />);
    await flush();
    expect(lastFrame()).toContain("queued 2");
  });

  it("colors the context percent by threshold", () => {
    expect(ctxColor(0.5)).toBe("#4EBA65"); // green
    expect(ctxColor(0.8)).toBe("#e0af68"); // amber
    expect(ctxColor(0.95)).toBe("#f7768e"); // red
    expect(ctxRemainingText(0.862)).toContain("14%"); // remaining = 100 - used
    expect(ctxRemainingText(1)).toContain("0%");
  });
});

describe("InputBox internal scroll indicators", () => {
  beforeEach(() => setLanguage("en"));

  it("flags hidden rows on the correct side of the window", async () => {
    // 30 logical lines in a terminal whose cap is max(3, rows/2-2); rows=24
    // → cap 10. Cursor at the end: everything hidden is ABOVE. Cursor at the
    // top: everything hidden is BELOW.
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const { lastFrame, stdin, unmount } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={() => {}}
        initialDraft={{ text: lines, cursor: lines.length }}
      />,
    );
    await flush();
    let frame = lastFrame()!;
    expect(frame).toMatch(/↑ \d+ more/); // hidden above (cursor at tail)
    expect(frame).not.toMatch(/↓ \d+ more/);
    // Walk the cursor to the top row: 29 ↑ presses cross 29 lines.
    for (let i = 0; i < 29; i++) stdin.write("\x1b[A");
    await flush();
    frame = lastFrame()!;
    expect(frame).toMatch(/↓ \d+ more/); // hidden below (cursor at head)
    expect(frame).not.toMatch(/↑ \d+ more/);
    unmount();
  });
});

describe("PermissionPrompt (official dialog)", () => {
  beforeEach(() => setLanguage("en"));

  function makeOverlay(extra: Record<string, unknown> = {}) {
    let resolve: (c: "yes" | "always" | "no") => void = () => {};
    const done = new Promise<"yes" | "always" | "no">((r) => (resolve = r));
    return {
      overlay: {
        kind: "permission" as const,
        header: "Bash request",
        detail: "npm test",
        resolve,
        ...extra,
      },
      done,
    };
  }

  it("renders the official divider + option wording", async () => {
    const { overlay } = makeOverlay();
    const { lastFrame } = render(<PermissionPrompt overlay={overlay} />);
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("▔"); // permission-blue divider row
    expect(frame).toContain("1. Yes");
    expect(frame).toContain("2. Yes, and don't ask again this session");
    expect(frame).toContain("3. No, and tell Claude what to do differently");
  });

  it("uses the tool-aware always label when provided", async () => {
    const { overlay } = makeOverlay({
      alwaysLabel: "Yes, and don't ask again for commands in D:\\repo",
    });
    const { lastFrame } = render(<PermissionPrompt overlay={overlay} />);
    await flush();
    expect(lastFrame()).toContain("for commands in D:\\repo");
  });

  it("resolves via the single-letter shortcuts (y/a/n)", async () => {
    for (const [key, expected] of [
      ["y", "yes"],
      ["a", "always"],
      ["n", "no"],
    ] as const) {
      const { overlay, done } = makeOverlay();
      const { stdin, unmount } = render(<PermissionPrompt overlay={overlay} />);
      await flush();
      stdin.write(key);
      await expect(done).resolves.toBe(expected);
      unmount();
    }
  });

  it("cycles the permission mode on Shift+Tab inside the dialog", async () => {
    const { overlay } = makeOverlay();
    const store = new TuiStore("p/m");
    const before = store.getSnapshot().permissionMode;
    const { stdin, unmount } = render(<PermissionPrompt overlay={overlay} store={store} />);
    await flush();
    stdin.write("\x1b[Z"); // Shift+Tab (CSI Z)
    await flush();
    expect(store.getSnapshot().permissionMode).not.toBe(before);
    unmount();
  });
});
