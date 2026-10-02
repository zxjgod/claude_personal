// ============================================================
// Tests: Batch C — mode & state-flow alignment (2026-09)
// ============================================================
// Covers the C1–C5 surface: the official permission-mode cycle order, the
// ExitPlanMode approval flow (approve/reject/legacy fallback + the plan-mode
// exemption), the two-stage rewind menu, the official compact-summary
// rendering + persistent Context-low line, and cross-session input-history
// persistence.
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPermission } from "../permissions.js";
import { EnterPlanModeTool, ExitPlanModeTool } from "../tools/breadth/interactive.js";
import { App } from "../tui/App.js";
import { setLanguage } from "../tui/i18n.js";
import { appendHistory, loadHistory } from "../tui/input-history.js";
import { PlanApproval } from "../tui/PlanApproval.js";
import { RewindPicker } from "../tui/RewindPicker.js";
import { nextPermissionMode, TuiStore } from "../tui/store.js";
import type { Tool } from "../types.js";

const flush = () => new Promise((r) => setTimeout(r, 30));

// --- shared permission-check fixtures ---------------------------------------

function fakeTool(name: string): Tool {
  return {
    name,
    description: "",
    inputSchema: { type: "object", properties: {}, required: [] },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    call: async () => ({ content: "" }),
  } as unknown as Tool;
}

interface TestCtx {
  workspaceRoot: string;
  sessionId: string;
  permissionMode: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  setPermissionMode: (m: TestCtx["permissionMode"]) => void;
  requestPlanApproval?: (plan: string) => Promise<{ choice: "approve" | "reject"; plan: string }>;
}

function ctx(mode: TestCtx["permissionMode"] = "default"): TestCtx {
  const c = {
    workspaceRoot: "/w",
    sessionId: "s",
    permissionMode: mode,
    setPermissionMode: (m: TestCtx["permissionMode"]) => {
      c.permissionMode = m;
    },
  } as TestCtx;
  return c;
}

describe("C1 — official permission-mode cycle", () => {
  it("cycles default → acceptEdits → plan → bypassPermissions", () => {
    expect(nextPermissionMode("default")).toBe("acceptEdits");
    expect(nextPermissionMode("acceptEdits")).toBe("plan");
    expect(nextPermissionMode("plan")).toBe("bypassPermissions");
    expect(nextPermissionMode("bypassPermissions")).toBe("default");
  });
});

describe("C2 — ExitPlanMode approval flow", () => {
  it("approve: surfaces the plan, flips to acceptEdits, returns success", async () => {
    const c = ctx("plan");
    c.requestPlanApproval = async (plan) => {
      expect(plan).toBe("## The plan");
      return { choice: "approve", plan };
    };
    const r = await ExitPlanModeTool.call({ plan: "## The plan" }, c as never);
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("approved");
    expect(c.permissionMode).toBe("acceptEdits");
  });

  it("reject: returns an error result and stays in plan mode", async () => {
    const c = ctx("plan");
    c.requestPlanApproval = async (plan) => ({ choice: "reject", plan });
    const r = await ExitPlanModeTool.call({ plan: "revise me" }, c as never);
    expect(r.error).toBe("plan rejected by user");
    expect(c.permissionMode).toBe("plan");
  });

  it("carries the editor-revised plan back to the model", async () => {
    const c = ctx("plan");
    c.requestPlanApproval = async () => ({ choice: "approve", plan: "EDITED PLAN" });
    const r = await ExitPlanModeTool.call({ plan: "ORIGINAL" }, c as never);
    expect(r.content).toContain("EDITED PLAN");
  });

  it("missing approval surface preserves plan mode", async () => {
    const c = ctx("plan");
    const r = await ExitPlanModeTool.call({ plan: "p", to: "acceptEdits" }, c as never);
    expect(r.error).toContain("approval is unavailable");
    expect(c.permissionMode).toBe("plan");
  });

  it("plan-mode permission gate exempts exit_plan_mode but blocks others", async () => {
    const c = ctx("plan");
    const write = fakeTool("write");
    // The REAL ExitPlanModeTool is read-only, so plan mode lets it through;
    // a destructive tool is blocked at the mode gate before askUser runs.
    const opts = { askUser: async () => true } as never;
    expect((await checkPermission(ExitPlanModeTool, {}, c as never, opts)).allowed).toBe(true);
    const blocked = await checkPermission(write, {}, c as never, opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("Plan mode");
  });

  it("enter_plan_mode still flips to plan (regression)", async () => {
    const c = ctx("default");
    await EnterPlanModeTool.call({}, c as never);
    expect(c.permissionMode).toBe("plan");
  });

  it("askPlanApproval threads through the store's overlay pipeline", async () => {
    const store = new TuiStore("p/m");
    const p = store.askPlanApproval("the plan");
    const overlay = store.getSnapshot().overlay;
    expect(overlay?.kind).toBe("planApproval");
    if (overlay?.kind === "planApproval") overlay.resolve({ choice: "approve", plan: "the plan" });
    await expect(p).resolves.toEqual({ choice: "approve", plan: "the plan" });
    expect(store.getSnapshot().overlay).toBeNull();
  });
});

describe("C3 — two-stage rewind menu", () => {
  const entries = [
    { turnIndex: 3, label: "third prompt", timestamp: "10:00", filesChanged: 2 },
    { turnIndex: 2, label: "second prompt", timestamp: "09:00", filesChanged: 0 },
    { turnIndex: 1, label: "first prompt", timestamp: "08:00", filesChanged: 1 },
  ];

  type RewindChoice = { turnIndex: number; action: "both" | "conversation" | "code" } | null;
  function makeOverlay() {
    let resolve: (c: RewindChoice) => void = () => {};
    const done = new Promise<RewindChoice>((r) => (resolve = r));
    return { overlay: { kind: "rewind" as const, entries, resolve }, done };
  }

  it("Enter on a turn opens the action stage with the official options", async () => {
    const { overlay, done } = makeOverlay();
    const { lastFrame, stdin, unmount } = render(<RewindPicker overlay={overlay} />);
    await flush();
    stdin.write("\r"); // pick turn #3
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Restore code and conversation");
    expect(frame).toContain("Restore conversation");
    expect(frame).toContain("Restore code");
    expect(frame).toContain("Never mind");
    // Down twice → "code"; Enter resolves with the chosen action.
    stdin.write("\x1b[B");
    await flush();
    stdin.write("\x1b[B");
    await flush();
    stdin.write("\r");
    await expect(done).resolves.toEqual({ turnIndex: 3, action: "code" });
    unmount();
  });

  it("Esc on the action stage goes back to the turn list", async () => {
    const { overlay } = makeOverlay();
    const { lastFrame, stdin, unmount } = render(<RewindPicker overlay={overlay} />);
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("Restore code and conversation");
    stdin.write("\x1b"); // back
    await flush();
    expect(lastFrame()!).not.toContain("Restore code and conversation");
    expect(lastFrame()).toContain("#3 third prompt");
    unmount();
  });

  it('"Never mind" is a real selectable row that resolves null', async () => {
    const { overlay, done } = makeOverlay();
    const { stdin, unmount } = render(<RewindPicker overlay={overlay} />);
    await flush();
    stdin.write("\r"); // pick turn #3 → action stage
    await flush();
    stdin.write("4"); // number shortcut for the 4th row
    await expect(done).resolves.toBeNull();
    unmount();
  });

  it('"Never mind" is reachable by arrows too (down ×3 + Enter)', async () => {
    const { overlay, done } = makeOverlay();
    const { stdin, unmount } = render(<RewindPicker overlay={overlay} />);
    await flush();
    stdin.write("\r");
    await flush();
    for (const _ of [1, 2, 3]) {
      stdin.write("\x1b[B");
      await flush();
    }
    stdin.write("\r");
    await expect(done).resolves.toBeNull();
    unmount();
  });
});

describe("D-review — PlanApproval overflow", () => {
  beforeEach(() => setLanguage("en"));

  function makePlanOverlay(plan: string) {
    let resolve: (r: { choice: "approve" | "reject"; plan: string }) => void = () => {};
    const done = new Promise<{ choice: "approve" | "reject"; plan: string }>((r) => (resolve = r));
    return { overlay: { kind: "planApproval" as const, plan, resolve }, done };
  }

  it("a plan over 15 rendered lines shows the '+N more' overflow line", async () => {
    const plan = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`).join("\n");
    const { overlay } = makePlanOverlay(plan);
    const { lastFrame, unmount } = render(<PlanApproval overlay={overlay} />);
    await flush();
    expect(lastFrame()).toContain("+5 lines");
    expect(lastFrame()).toContain("step 15");
    expect(lastFrame()).not.toContain("step 16");
    unmount();
  });

  it("a short plan renders fully with no overflow line", async () => {
    const { overlay } = makePlanOverlay("one\ntwo\nthree");
    const { lastFrame, unmount } = render(<PlanApproval overlay={overlay} />);
    await flush();
    expect(lastFrame()).toContain("three");
    expect(lastFrame()!).not.toContain("lines");
    unmount();
  });
});

describe("C4 — compact summary + context-low line", () => {
  beforeEach(() => setLanguage("en"));

  it("store.addCompactSummary commits the official rows", () => {
    const store = new TuiStore("p/m");
    store.addCompactSummary("summarized: we fixed the bug", 42);
    const item = store.getSnapshot().transcript[0]!;
    expect(item).toMatchObject({ kind: "compact", messages: 42 });
  });

  it("App renders the official CompactSummary block", async () => {
    const store = new TuiStore("p/m");
    store.addCompactSummary("we fixed the bug and wrote tests", 42);
    const { lastFrame, unmount } = render(<App store={store} commands={[]} onSubmit={() => {}} />);
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Summarized conversation");
    expect(frame).toContain("Summarized 42 messages");
    expect(frame).toContain("Context:");
    expect(frame).toContain("we fixed the bug");
    unmount();
  });

  it("TokenWarning line appears at 80% (amber) and 95% (red), hidden below", async () => {
    const store = new TuiStore("p/m");
    store.setContextLimit(100_000);
    const { lastFrame, unmount } = render(<App store={store} commands={[]} onSubmit={() => {}} />);
    await flush();
    store.addUsage(80_000, 0, undefined, 80_000);
    await flush();
    expect(lastFrame()).toContain("Context low (20% remaining)");
    store.addUsage(95_000, 0, undefined, 95_000);
    await flush();
    expect(lastFrame()).toContain("Context low (5% remaining)");
    unmount();
    // Below the threshold the line is gone.
    const store2 = new TuiStore("p/m");
    store2.setContextLimit(100_000);
    store2.addUsage(50_000, 0, undefined, 50_000);
    const two = render(<App store={store2} commands={[]} onSubmit={() => {}} />);
    await flush();
    expect(two.lastFrame()!).not.toContain("Context low");
    two.unmount();
  });

  it("crossing the threshold no longer fires a toast (replaced by the line)", () => {
    const store = new TuiStore("p/m");
    store.setContextLimit(100_000);
    store.addUsage(80_000, 0, undefined, 80_000);
    expect(store.getSnapshot().toast).toBeNull();
  });
});

describe("C5 — input history persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-hist-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("round-trips entries across loads (oldest→newest)", () => {
    appendHistory(dir, "first");
    appendHistory(dir, "second");
    appendHistory(dir, "third");
    expect(loadHistory(dir)).toEqual(["first", "second", "third"]);
  });

  it("collapses consecutive duplicates but keeps alternations", () => {
    appendHistory(dir, "npm test");
    appendHistory(dir, "npm test"); // consecutive dup → dropped
    appendHistory(dir, "npm run build");
    appendHistory(dir, "npm test"); // non-consecutive → kept
    expect(loadHistory(dir)).toEqual(["npm test", "npm run build", "npm test"]);
  });

  it("multi-line drafts survive as single entries", () => {
    appendHistory(dir, "line one\nline two");
    const h = loadHistory(dir);
    expect(h).toHaveLength(1);
    expect(h[0]).toBe("line one\nline two");
  });

  it("skips corrupt lines instead of throwing", () => {
    appendHistory(dir, "good");
    const file = path.join(dir, ".claude", "history", `${hashName(dir)}.jsonl`);
    fs.appendFileSync(file, "{not json}\n", "utf-8");
    appendHistory(dir, "after");
    expect(loadHistory(dir)).toEqual(["good", "after"]);
  });

  it("missing file reads as empty; blank values are ignored", () => {
    expect(loadHistory(dir)).toEqual([]);
    appendHistory(dir, "   ");
    expect(loadHistory(dir)).toEqual([]);
  });
});

/** Mirror input-history.ts's file naming so the corrupt-line test writes the
 *  same file the module reads. */
function hashName(root: string): string {
  let h = 0;
  for (const ch of root) h = (Math.imul(h, 31) + ch.codePointAt(0)!) | 0;
  return (h >>> 0).toString(36);
}
