// ============================================================
// Tests: P0 TUI features — checkpoints, retry countdown, collapsed
// thinking, transcript viewer, Esc+Esc rewind, image paste chip
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginUserTurn,
  resetAllCheckpoints,
  restoreToTurn,
  shadowBeforeWrite,
  turnOfMessage,
} from "../checkpoint.js";
import { handleModelError, type RecoveryState } from "../error-recovery.js";
import { App } from "../tui/App.js";
import { messagesToTranscript } from "../tui/history-replay.js";
import { InputBox } from "../tui/InputBox.js";
import { setLanguage } from "../tui/i18n.js";
import { RetryLine } from "../tui/RetryLine.js";
import { TuiStore } from "../tui/store.js";
import { TranscriptReview } from "../tui/TranscriptReview.js";
import { transcriptToLines } from "../tui/transcript-lines.js";
import type { Message } from "../types.js";

// Assertions match English UI strings; pin the language like the sibling TUI
// test files (i18n seeds from LANG/CCR_LANGUAGE at import time).
beforeAll(() => setLanguage("en"));

const ESC = "\x1b";
const CTRL_V = "\x16";

function flush(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A bare ESC is held ~20ms by Ink's escape-sequence disambiguation before it
 *  is emitted as an escape keypress — assertions after writing one need to
 *  outlive that timer. Use this for NEGATIVE assertions ("nothing happened"),
 *  which have no condition to poll. */
function escFlush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 60));
}

/**
 * Poll `cond` until it holds or `timeoutMs` elapses.
 *
 * POSITIVE Esc assertions must use this instead of escFlush: a fixed sleep only
 * *bets* that Ink's ~20ms disambiguation timer has fired, and under parallel
 * load the event loop can be starved well past that budget — which is what made
 * these tests flake in full-suite runs while passing in isolation.
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ============================================================
// checkpoint.ts — shadow copies + turn-boundary restore (P0-3)
// ============================================================
describe("checkpoint restore (P0-3)", () => {
  let dir: string;
  let a: string;
  let b: string;

  beforeEach(() => {
    resetAllCheckpoints();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-cp-"));
    a = path.join(dir, "a.txt");
    b = path.join(dir, "b.txt");
    fs.writeFileSync(a, "original", "utf-8");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetAllCheckpoints();
  });

  it("rewinds a modified file to its boundary snapshot, then to the original", () => {
    const s = "cp-session";
    beginUserTurn(s); // turn 1
    shadowBeforeWrite(s, a);
    fs.writeFileSync(a, "v1", "utf-8");
    beginUserTurn(s); // turn 2 (boundary snapshot: a = "v1")
    fs.writeFileSync(a, "v2", "utf-8");

    // Rewind to before turn 2 → the turn-2 boundary state ("v1").
    let r = restoreToTurn(s, 2);
    expect(r.restored).toEqual([a]);
    expect(fs.readFileSync(a, "utf-8")).toBe("v1");

    // Rewind further to before turn 1 → pre-session original.
    r = restoreToTurn(s, 1);
    expect(fs.readFileSync(a, "utf-8")).toBe("original");
  });

  it("deletes files created during the rewound turns", () => {
    const s = "cp-session";
    beginUserTurn(s); // turn 1
    shadowBeforeWrite(s, b); // b does not exist yet → original = null
    fs.writeFileSync(b, "created", "utf-8");
    expect(fs.existsSync(b)).toBe(true);

    const r = restoreToTurn(s, 1);
    expect(fs.existsSync(b)).toBe(false);
    expect(r.deleted).toEqual([b]);
  });

  it("leaves files untouched outside the rewound range", () => {
    const s = "cp-session";
    beginUserTurn(s); // turn 1
    beginUserTurn(s); // turn 2
    shadowBeforeWrite(s, a);
    fs.writeFileSync(a, "v1", "utf-8");

    // a was first written "in" turn 2's runtime — rewinding to turn 2's
    // boundary restores the ORIGINAL (it was unmodified at that boundary).
    restoreToTurn(s, 2);
    expect(fs.readFileSync(a, "utf-8")).toBe("original");
  });

  it("tags messages with their turn and maps them back (review fix #1)", () => {
    const s = "cp-session";
    const msg1: object = { role: "user" };
    const msg2: object = { role: "user" };
    // An untagged message between the two (e.g. injected by the loop without
    // a boundary) must not shift anyone's mapping.
    const synthetic: object = { role: "user" };
    expect(beginUserTurn(s, msg1)).toBe(1);
    beginUserTurn(s); // synthetic, untagged
    expect(beginUserTurn(s, msg2)).toBe(3);
    expect(turnOfMessage(msg1)).toBe(1);
    expect(turnOfMessage(msg2)).toBe(3);
    expect(turnOfMessage(synthetic)).toBeNull();
  });

  it("reuses turn numbers after a rewind (review fix #2)", () => {
    const s = "cp-session";
    beginUserTurn(s); // 1
    beginUserTurn(s); // 2
    shadowBeforeWrite(s, a);
    fs.writeFileSync(a, "v1", "utf-8");
    beginUserTurn(s); // 3
    fs.writeFileSync(a, "v2", "utf-8");

    restoreToTurn(s, 2);
    expect(fs.readFileSync(a, "utf-8")).toBe("original");
    // The counter rolled back: the next boundary reuses turn 2, and a SECOND
    // rewind still resolves an existing boundary instead of a pruned one.
    expect(beginUserTurn(s)).toBe(2);
    shadowBeforeWrite(s, a);
    fs.writeFileSync(a, "again", "utf-8");
    restoreToTurn(s, 2);
    expect(fs.readFileSync(a, "utf-8")).toBe("original");
  });

  it("folds sub-agent buckets into the parent (review fix, agent fork)", () => {
    const s = "cp-session";
    beginUserTurn(s); // turn 1
    // Sub-agents shadow under `<parent>-agent-<ts>` (tools/extended/agent.ts)
    // — the parent rewind must still restore those writes.
    shadowBeforeWrite(`${s}-agent-1725454545`, a);
    fs.writeFileSync(a, "sub-agent edit", "utf-8");
    restoreToTurn(s, 1);
    expect(fs.readFileSync(a, "utf-8")).toBe("original");
  });

  it("only reports files it actually deleted (review fix, misreport)", () => {
    const s = "cp-session";
    beginUserTurn(s);
    // Shadow a path whose original didn't exist AND is already gone at
    // restore time — the deleted list must stay empty.
    const ghost = path.join(dir, "never-created.txt");
    shadowBeforeWrite(s, ghost);
    const r = restoreToTurn(s, 1);
    expect(r.deleted).toEqual([]);
  });

  it("boundary snapshots stay fresh across back-to-back same-size writes (mtime-cache trust domain)", () => {
    // CI regression: the snapshotAt mtime cache served a stale boundary when
    // consecutive writes landed within one mtime tick. shadowBeforeWrite and
    // restoreToTurn now bust the cache entry around every known write. The
    // writes here mirror the real tool flow (shadow BEFORE every write — the
    // module's standing invariant, which original capture already relies
    // on), and the same-size payloads ("v1"→"v2") make sure no size
    // heuristic could mask a regression either.
    const s = "cp-session";
    beginUserTurn(s); // turn 1
    shadowBeforeWrite(s, a);
    fs.writeFileSync(a, "v1", "utf-8");
    beginUserTurn(s); // turn 2 boundary must read "v1" (not the cached "original")
    shadowBeforeWrite(s, a);
    fs.writeFileSync(a, "v2", "utf-8");
    beginUserTurn(s); // turn 3 boundary must read "v2"
    restoreToTurn(s, 3);
    expect(fs.readFileSync(a, "utf-8")).toBe("v2"); // boundary 3 was fresh
    restoreToTurn(s, 2);
    expect(fs.readFileSync(a, "utf-8")).toBe("v1"); // boundary 2 was fresh
    restoreToTurn(s, 1);
    expect(fs.readFileSync(a, "utf-8")).toBe("original");
  });
});

// ============================================================
// error-recovery — onRetry fires before the backoff sleep (P0-4)
// ============================================================
describe("handleModelError onRetry (P0-4)", () => {
  const state = (): RecoveryState => ({
    rateLimitRetries: 0,
    contextLengthRetries: 0,
    transientRetries: 0,
    maxRateLimitRetries: 10,
    maxContextLengthRetries: 1,
    maxTransientRetries: 3,
  });

  it("reports the rate-limit backoff before sleeping", async () => {
    vi.useFakeTimers();
    try {
      const notices: Array<{ kind: string; delayMs: number }> = [];
      const p = handleModelError({ status: 429 }, state(), (n) => notices.push(n));
      await vi.advanceTimersByTimeAsync(65_000);
      const recovery = await p;
      expect(recovery).toBe("retry");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.kind).toBe("rate_limit");
      expect(notices[0]!.delayMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports transient retries with a 2s delay", async () => {
    vi.useFakeTimers();
    try {
      const notices: Array<{ kind: string; delayMs: number }> = [];
      const p = handleModelError(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        state(),
        (n) => notices.push(n),
      );
      await vi.advanceTimersByTimeAsync(3000);
      const recovery = await p;
      expect(recovery).toBe("retry_transient");
      expect(notices).toEqual([{ kind: "transient", delayMs: 2000 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================
// store — collapsed thinking, retry countdown, rewind overlay
// ============================================================
describe("TuiStore P0 additions", () => {
  it("commitThinking(seconds) stores duration for the collapsed line", () => {
    const store = new TuiStore("p/m");
    store.appendThinking("line 1\nline 2");
    store.commitThinking(7);
    const item = store.getSnapshot().transcript[0]!;
    expect(item.kind).toBe("thinking_text");
    if (item.kind === "thinking_text") {
      expect(item.seconds).toBe(7);
      expect(item.text).toBe("line 1\nline 2");
    }
    expect(store.getSnapshot().streamingThinking).toBe("");
  });

  it("showRetry counts down, HOLDS at 0 until cleared (retry in flight)", () => {
    vi.useFakeTimers();
    try {
      const store = new TuiStore("p/m");
      store.showRetry("API 429 rate limit", 1, 10, 5000);
      expect(store.getSnapshot().retryStatus).toMatchObject({
        secondsLeft: 5,
        attempt: 1,
        max: 10,
      });
      vi.advanceTimersByTime(2000);
      expect(store.getSnapshot().retryStatus?.secondsLeft).toBe(3);
      // Past the backoff sleep the line stays up at 0 ("retrying now") — the
      // retry REQUEST is still in flight; only its first event clears this.
      vi.advanceTimersByTime(3000);
      expect(store.getSnapshot().retryStatus?.secondsLeft).toBe(0);
      expect(store.getSnapshot().retryStatus).not.toBeNull();
      vi.advanceTimersByTime(5000); // still holding, no further ticks matter
      expect(store.getSnapshot().retryStatus?.secondsLeft).toBe(0);
      store.clearRetry();
      expect(store.getSnapshot().retryStatus).toBeNull();
      vi.advanceTimersByTime(10_000); // no further ticks after clear
      expect(store.getSnapshot().retryStatus).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("askRewind resolves with the chosen turn index", async () => {
    const store = new TuiStore("p/m");
    const p = store.askRewind([
      { turnIndex: 2, label: "second", timestamp: "10:00", filesChanged: 1 },
      { turnIndex: 1, label: "first", timestamp: "09:00", filesChanged: 0 },
    ]);
    const overlay = store.getSnapshot().overlay;
    expect(overlay?.kind).toBe("rewind");
    if (overlay?.kind === "rewind") overlay.resolve({ turnIndex: 2, action: "both" });
    await expect(p).resolves.toEqual({ turnIndex: 2, action: "both" });
    expect(store.getSnapshot().overlay).toBeNull();
  });

  it("askRewind never displaces a live overlay (review follow-up #4c)", async () => {
    const store = new TuiStore("p/m");
    const permP = store.askPermission("Header", "detail");
    expect(store.getSnapshot().overlay?.kind).toBe("permission");
    // Attempting to open the rewind menu under it resolves as "cancelled"
    // and leaves the permission overlay untouched.
    await expect(
      store.askRewind([{ turnIndex: 1, label: "x", timestamp: "", filesChanged: 0 }]),
    ).resolves.toBeNull();
    expect(store.getSnapshot().overlay?.kind).toBe("permission");
    const ov = store.getSnapshot().overlay;
    if (ov?.kind === "permission") ov.resolve("no");
    await expect(permP).resolves.toBe("no");
    expect(store.getSnapshot().overlay).toBeNull();
  });

  it("replays assistant thinking blocks as collapsed thinking items (review follow-up #4b)", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: "a",
        thinking: [
          { type: "thinking", thinking: "line one\nline two", signature: "sig" },
          { type: "redacted_thinking", data: "opaque" },
        ],
      } as Message,
    ];
    const items = messagesToTranscript(messages);
    // ReplayItem is Omit<union, "id"> (non-distributive) — no narrowing.
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("thinking_text");
    const replayed = items.find((i) => i.kind === "thinking_text") as {
      kind: string;
      text: string;
    };
    expect(replayed.text).toBe("line one\nline two");
    expect(kinds).toContain("assistant");
  });

  it("resetTranscript clears items and bumps the epoch (Static remount key)", () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("one");
    store.addUserMessage("two");
    const epochBefore = store.getSnapshot().transcriptEpoch;
    store.resetTranscript();
    expect(store.getSnapshot().transcript).toEqual([]);
    expect(store.getSnapshot().transcriptEpoch).toBe(epochBefore + 1);
    // New items land normally after the reset (the region remounts on the
    // epoch, restarting Ink's Static index).
    store.addUserMessage("three");
    expect(store.getSnapshot().transcript).toHaveLength(1);
  });
});

// ============================================================
// transcript-lines — verbose vs collapsed rendering (P0-1 / P0-2)
// ============================================================
describe("transcriptToLines verbose mode (P0-1/P0-2)", () => {
  const longOutput = Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n");

  function toolStore(): TuiStore {
    const store = new TuiStore("p/m");
    store.finishTool({ toolName: "read", formatted: longOutput }, "src/foo.ts");
    return store;
  }

  it("compact mode cuts tool output at the preview window", () => {
    const lines = transcriptToLines(toolStore().getSnapshot().transcript, "");
    expect(lines.some((l) => l.text.includes("… +18 lines"))).toBe(true);
    expect(lines.some((l) => l.text.includes("out 29"))).toBe(false);
  });

  it("verbose mode (transcript viewer) shows the full output", () => {
    const lines = transcriptToLines(toolStore().getSnapshot().transcript, "", "", {
      verbose: true,
    });
    expect(lines.some((l) => l.text.includes("out 29"))).toBe(true);
    expect(lines.some((l) => l.text.includes("… +"))).toBe(false);
  });

  it("thinking collapses to one line (compact) and expands (verbose)", () => {
    const store = new TuiStore("p/m");
    store.appendThinking("thought a\nthought b\nthought c");
    store.commitThinking(4);
    const transcript = store.getSnapshot().transcript;

    const compact = transcriptToLines(transcript, "");
    const thinkingRows = compact.filter((l) => l.text.includes("Thought for 4s"));
    expect(thinkingRows).toHaveLength(1);
    expect(compact.some((l) => l.text.includes("thought c"))).toBe(false);

    const verbose = transcriptToLines(transcript, "", "", { verbose: true });
    expect(verbose.some((l) => l.text.includes("thought c"))).toBe(true);
  });

  it("no-duration thinking renders identically in both paths (follow-up #1/#2)", async () => {
    // /resume replay produces thinking_text WITHOUT seconds — both the
    // <Static> row (App) and the flat lines (fullscreen/viewer) must hide
    // the duration instead of showing "Thought for 0s", via the shared
    // collapsedThinkingLine helper.
    const store = new TuiStore("p/m");
    store.appendThinking("r1\nr2\nr3");
    store.commitThinking(); // no duration — the /resume replay shape
    const { lastFrame } = render(<App store={store} commands={[]} onSubmit={() => {}} />);
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Thinking · 3 lines");
    expect(frame).not.toContain("Thought for 0s");

    const lines = transcriptToLines(store.getSnapshot().transcript, "");
    expect(lines.some((l) => l.text.includes("Thinking · 3 lines"))).toBe(true);
    expect(lines.some((l) => l.text.includes("0s"))).toBe(false);
  });

  it("marks user rows for { } prompt jumps", () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("hello");
    const lines = transcriptToLines(store.getSnapshot().transcript, "");
    expect(lines[0]!.role).toBe("user");
  });

  it("multi-line user drafts flatten to one row per line (pager windowing)", () => {
    // The pagers window over this array 1:1, so an embedded "\n" inside a
    // single row desynced the viewport math (sticky-bottom drift, clipped
    // tail) until this flattening existed.
    const store = new TuiStore("p/m");
    store.addUserMessage("line one\nline two\nline three");
    const lines = transcriptToLines(store.getSnapshot().transcript, "");
    expect(lines.map((l) => l.text)).toEqual(["> line one", "  line two", "  line three"]);
    // The { / } jump marker rides the head row only — jumps target the turn
    // head, not its tail.
    expect(lines[0]!.role).toBe("user");
    expect(lines[1]!.role).toBeUndefined();
    // Every row keeps the user color so the turn reads as one block.
    expect(lines[1]!.color).toBe(lines[0]!.color);
  });
});

// ============================================================
// TranscriptReview — verbose viewer keys (P0-1)
// ============================================================
describe("TranscriptReview viewer", () => {
  it("shows full thinking text and closes on ctrl+o", async () => {
    const store = new TuiStore("p/m");
    store.addUserMessage("q1");
    store.appendThinking("secret reasoning");
    store.commitThinking(3);
    store.setReviewing(true);
    const { stdin, lastFrame } = render(<TranscriptReview store={store} />);
    await flush();
    expect(lastFrame()).toContain("secret reasoning"); // verbose
    expect(lastFrame()).toContain("Showing detailed transcript"); // D6 footer

    stdin.write("\x0f"); // Ctrl+O toggles closed
    await flush();
    expect(store.getSnapshot().reviewing).toBe(false);
  });

  it("'{' steps back through user prompts one at a time", async () => {
    const store = new TuiStore("p/m");
    for (let i = 0; i < 25; i++) store.addUserMessage(`turn ${i}`);
    store.setReviewing(true);
    const { stdin, lastFrame } = render(<TranscriptReview store={store} />);
    await flush();
    // Opens at the bottom: turn 24 visible, turn 0 not.
    expect(lastFrame()).toContain("turn 24");
    expect(lastFrame()).not.toContain("turn 0");
    stdin.write("{");
    await flush();
    // One step: walked back to an earlier prompt. The exact top row depends
    // on the viewport height (D6 grew the chrome budget by one row), so assert
    // progress, not a position: some earlier turn is visible, the latest is not.
    const after = lastFrame()!;
    const visible = [...after.matchAll(/turn (\d+)/g)].map((m) => Number(m[1]));
    expect(visible.length).toBeGreaterThan(0);
    expect(Math.max(...visible)).toBeLessThan(24);
    expect(after).not.toContain("turn 24");
    // Repeated steps walk back to the first prompt.
    for (let i = 0; i < 6; i++) stdin.write("{");
    await flush();
    expect(lastFrame()).toContain("turn 0");
  });
});

// ============================================================
// InputBox — Esc+Esc rewind + Ctrl+V image chip (P0-3 / P0-5)
// ============================================================
describe("InputBox P0 keys", () => {
  it("double-Esc fires onRewind (idle, empty buffer)", async () => {
    const onRewind = vi.fn();
    const { stdin } = render(
      <InputBox commands={[]} disabled={false} onSubmit={() => {}} onRewind={onRewind} />,
    );
    await flush();
    stdin.write(ESC);
    await escFlush();
    expect(onRewind).not.toHaveBeenCalled(); // armed, not fired
    stdin.write(ESC);
    await waitFor(() => onRewind.mock.calls.length > 0);
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  it("first Esc clears a non-empty draft, second Esc rewinds", async () => {
    const onRewind = vi.fn();
    const { stdin, lastFrame } = render(
      <InputBox commands={[]} disabled={false} onSubmit={() => {}} onRewind={onRewind} />,
    );
    await flush();
    stdin.write("draft text");
    await flush();
    expect(lastFrame()).toContain("draft text");
    stdin.write(ESC);
    await waitFor(() => !(lastFrame() ?? "").includes("draft text"));
    expect(lastFrame()).not.toContain("draft text"); // cleared
    stdin.write(ESC);
    await waitFor(() => onRewind.mock.calls.length > 0);
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  it("a printable key between Escs disarms the rewind arm", async () => {
    const onRewind = vi.fn();
    const { stdin } = render(
      <InputBox commands={[]} disabled={false} onSubmit={() => {}} onRewind={onRewind} />,
    );
    await flush();
    stdin.write(ESC);
    await escFlush();
    stdin.write("x"); // disarm
    await flush();
    stdin.write(ESC); // re-arm (not the second of a pair)
    await escFlush();
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("Ctrl+V inserts the image chip from onImagePaste", async () => {
    const onImagePaste = vi.fn(async () => "[Image #1]");
    const { stdin, lastFrame } = render(
      <InputBox commands={[]} disabled={false} onSubmit={() => {}} onImagePaste={onImagePaste} />,
    );
    await flush();
    stdin.write(CTRL_V);
    await flush(30);
    expect(onImagePaste).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("[Image #1]");
  });

  it("Ctrl+V without an image shows the no-image note", async () => {
    const onImagePaste = vi.fn(async () => null);
    const { stdin, lastFrame } = render(
      <InputBox commands={[]} disabled={false} onSubmit={() => {}} onImagePaste={onImagePaste} />,
    );
    await flush();
    stdin.write(CTRL_V);
    await flush(30);
    expect(lastFrame()).not.toContain("[Image #1]");
  });

  it("drops the chip when the draft was submitted while the clipboard read was in flight", async () => {
    // Controllable paste promise: resolve it only AFTER the user "submitted"
    // — the chip must not splice into the next draft (review follow-up #1).
    let resolvePaste!: (v: string | null) => void;
    const onImagePaste = () =>
      new Promise<string | null>((res) => {
        resolvePaste = res;
      });
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <InputBox commands={[]} disabled={false} onSubmit={onSubmit} onImagePaste={onImagePaste} />,
    );
    await flush();
    stdin.write(CTRL_V); // slow clipboard read starts
    await flush();
    stdin.write("hello"); // user keeps typing…
    await flush();
    stdin.write("\r"); // …and submits the draft without the image
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("hello");
    resolvePaste("[Image #1]"); // image arrives too late
    await flush(30);
    expect(lastFrame()).not.toContain("[Image #1]");
    expect(lastFrame()).toContain("paste again"); // stale-paste note
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("inputSuspended swallows keypresses AND the mirror stays empty", async () => {
    const onDraftChange = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={onSubmit}
        inputSuspended={() => true}
        onDraftChange={onDraftChange}
      />,
    );
    await flush();
    stdin.write("abc");
    await flush();
    expect(lastFrame()).not.toContain("abc"); // nothing reached the buffer
    expect(onSubmit).not.toHaveBeenCalled();
    // Mount reported the empty seed; the swallowed keys must not have re-reported.
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledWith({ text: "", cursor: 0 });
  });

  it("onDraftChange mirrors typing; the saved seed restores on remount", async () => {
    // The mirror is the draft's survival mechanism across unmounts (overlays,
    // the review pager REPLACE the box) — the next instance seeds from it.
    const onDraftChange = vi.fn();
    const { stdin, unmount } = render(
      <InputBox commands={[]} disabled={false} onSubmit={() => {}} onDraftChange={onDraftChange} />,
    );
    await flush();
    stdin.write("abc");
    await flush();
    expect(onDraftChange).toHaveBeenLastCalledWith({ text: "abc", cursor: 3 });
    const seed = onDraftChange.mock.calls.at(-1)![0];
    unmount();
    const second = render(
      <InputBox
        commands={[]}
        disabled={false}
        onSubmit={() => {}}
        onDraftChange={onDraftChange}
        initialDraft={seed}
      />,
    );
    await flush();
    expect(second.lastFrame()).toContain("abc");
  });
});

describe("RetryLine", () => {
  it("shows the countdown, then 'retrying now' once it hits 0", () => {
    const counting = render(
      <RetryLine retry={{ reason: "API 429 rate limit", attempt: 2, max: 10, secondsLeft: 8 }} />,
    );
    expect(counting.lastFrame()).toContain("retrying in 8s");
    expect(counting.lastFrame()).toContain("2/10");
    const now = render(
      <RetryLine retry={{ reason: "API 429 rate limit", attempt: 2, max: 10, secondsLeft: 0 }} />,
    );
    expect(now.lastFrame()).toContain("retrying now");
    expect(now.lastFrame()).not.toContain("retrying in");
  });
});

// ============================================================
// Help hotkey arbitration — "?" opens help, panel owns the
// keyboard, InputBox suspended while it is on screen (P0)
// ============================================================
describe("help hotkey arbitration (App-level)", () => {
  function renderApp() {
    const store = new TuiStore("p/m");
    const onSubmit = vi.fn();
    const inst = render(<App store={store} commands={[]} onSubmit={onSubmit} />);
    return { store, onSubmit, ...inst };
  }

  it("'?' on an empty draft opens help WITHOUT inserting the character", async () => {
    const { store, stdin } = renderApp();
    await flush();
    stdin.write("?");
    await flush();
    expect(store.getSnapshot().showHelp).toBe(true);
    // The opening keypress arrives at every useInput listener in one stdin
    // dispatch — a leaked "?" would sit in the buffer for the next submit.
    expect(store.getSnapshot().draft.text).toBe("");
  });

  it("'?' with a live draft inserts the character and does NOT open help", async () => {
    const { store, stdin, lastFrame } = renderApp();
    await flush();
    stdin.write("what is X");
    await flush();
    stdin.write("?");
    await flush();
    expect(store.getSnapshot().showHelp).toBe(false);
    expect(lastFrame()).toContain("what is X?");
    expect(store.getSnapshot().draft.text.length).toBe(10); // "what is X" (9) + "?"
  });

  it("keys typed while help is open are swallowed (draft stays empty)", async () => {
    const { store, stdin } = renderApp();
    await flush();
    stdin.write("?");
    await flush();
    expect(store.getSnapshot().showHelp).toBe(true);
    stdin.write("draft");
    await flush();
    expect(store.getSnapshot().showHelp).toBe(true); // still open, keys ignored
    expect(store.getSnapshot().draft.text).toBe("");
  });

  it("Esc closes help WITHOUT clearing the live draft", async () => {
    // Regression: Ink broadcasts the closing Esc to the InputBox too — it
    // used to wipe the draft (and arm double-Esc rewind) in the same
    // keypress that closed the panel.
    const { store, stdin, lastFrame } = renderApp();
    await flush();
    stdin.write("keep me");
    await flush();
    // /help-style open: the panel can be on screen while a draft exists
    // (opened from the command path), and must own Esc while it is.
    store.setShowHelp(true);
    await flush();
    stdin.write(ESC);
    await waitFor(() => store.getSnapshot().showHelp === false);
    expect(store.getSnapshot().showHelp).toBe(false);
    expect(lastFrame()).toContain("keep me");
    expect(store.getSnapshot().draft.text.length).toBe(7);
  });

  it("Enter closes help WITHOUT submitting the draft", async () => {
    const { store, onSubmit, stdin, lastFrame } = renderApp();
    await flush();
    stdin.write("keep me");
    await flush();
    store.setShowHelp(true);
    await flush();
    stdin.write("\r");
    await flush();
    expect(store.getSnapshot().showHelp).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("keep me");
  });

  it("the draft survives a review-mode round trip (the pager unmounts the box)", async () => {
    const { store, stdin, lastFrame } = renderApp();
    await flush();
    stdin.write("keep me");
    await flush();
    store.setReviewing(true);
    await flush();
    // The pager replaced the input region — the draft lives on in the store.
    expect(store.getSnapshot().draft.text).toBe("keep me");
    store.setReviewing(false);
    await flush();
    expect(lastFrame()).toContain("keep me"); // restored into the fresh box
  });

  it("a permission overlay preserves the draft AND exits review mode (no agent hang)", async () => {
    const { store, stdin, lastFrame } = renderApp();
    await flush();
    stdin.write("keep me");
    await flush();
    store.setReviewing(true);
    await flush();
    // A tool permission arrives while the user reads the transcript: the
    // overlay cannot render inside the review layout — leaving `reviewing`
    // on would hang its resolve() promise (and the agent loop) until the
    // user happened to leave the viewer.
    const answer = store.askPermission("Allow Bash?");
    await flush();
    expect(store.getSnapshot().reviewing).toBe(false);
    expect(lastFrame()).toContain("Allow Bash?");
    const ov = store.getSnapshot().overlay;
    if (ov?.kind === "permission") ov.resolve("no");
    await answer;
    await flush();
    expect(lastFrame()).toContain("keep me"); // draft restored after the overlay
  });
});
