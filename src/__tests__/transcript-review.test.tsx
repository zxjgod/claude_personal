// ============================================================
// Tests: TranscriptReview — in-app scrollable pager (default TUI path)
// ============================================================
// The default <Static> path owns no scrollback (the terminal does), and
// scroll-on-output terminals fight the user during streaming. This pager is
// the app-controlled fix: opens at the bottom, scrolls with keys, and — the
// core regression guard — does NOT drag the viewport when new lines stream in.
//
// Under ink-testing-library stdout is not a TTY → useTerminalSize falls back
// to 80×24, so the pager viewport is 24 - 4 (chrome) = 20 rows.
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TuiStore } from "../tui/store.js";
import { TranscriptReview } from "../tui/TranscriptReview.js";

const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

/** User rows plus spacing exceed the viewport, exercising scrolling. */
function storeWithTranscript(n = 30): TuiStore {
  const store = new TuiStore("p/m");
  for (let i = 0; i < n; i++) store.addUserMessage(`message ${i}`);
  return store;
}

describe("TranscriptReview", () => {
  it("opens pinned to the bottom (latest content visible)", async () => {
    const store = storeWithTranscript();
    const { lastFrame } = render(<TranscriptReview store={store} />);
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Transcript — 60 lines");
    expect(frame).toContain("message 29");
    expect(frame).not.toContain("message 0");
  });

  it("PgUp scrolls up and G returns to the bottom", async () => {
    const store = storeWithTranscript();
    const { stdin, lastFrame } = render(<TranscriptReview store={store} />);
    await flush();

    for (let i = 0; i < 6; i++) stdin.write(PGUP);
    await flush();
    expect(lastFrame()).toContain("message 0");
    expect(lastFrame()).not.toContain("message 29");

    stdin.write("G"); // jump to bottom
    await flush();
    expect(lastFrame()).toContain("message 29");
    expect(lastFrame()).not.toContain("message 0");
  });

  it("PgDn scrolls back down page by page", async () => {
    const store = storeWithTranscript();
    const { stdin, lastFrame } = render(<TranscriptReview store={store} />);
    await flush();
    stdin.write(PGUP);
    await flush();
    expect(lastFrame()).not.toContain("message 29");
    stdin.write(PGDN);
    stdin.write(PGDN);
    await flush();
    expect(lastFrame()).toContain("message 29");
  });

  it("does not drag the viewport when new lines stream in (sticky off)", async () => {
    const store = storeWithTranscript();
    const { stdin, lastFrame } = render(<TranscriptReview store={store} />);
    await flush();

    for (let i = 0; i < 6; i++) stdin.write(PGUP);
    await flush();
    expect(lastFrame()).toContain("message 0");

    // Simulate streaming: more committed content arrives while reviewing.
    store.addUserMessage("late arrival 30");
    store.addUserMessage("late arrival 31");
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Transcript — 64 lines"); // content grew
    expect(frame).toContain("message 0"); // viewport stayed at the top
    expect(frame).not.toContain("late arrival 31");
  });

  it("Esc/q closes the pager (store.reviewing → false)", async () => {
    const store = storeWithTranscript();
    store.setReviewing(true);
    const { stdin } = render(<TranscriptReview store={store} />);
    await flush();
    stdin.write("q");
    await flush();
    expect(store.getSnapshot().reviewing).toBe(false);
  });
});
