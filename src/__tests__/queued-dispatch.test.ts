// ============================================================
// Regression: queued-line dispatch (review 2026-09-07, fixes 1+2)
// ============================================================
// Pins the two queue-semantics invariants that replaced echo-at-queue-time:
//   1. The transcript echo happens at INJECTION time — a line that is never
//      injected (recalled with ↑, or dropped at the follow-up cap) leaves no
//      ghost user message, and the transcript can't diverge from `messages`.
//   2. Queued `!cmd` / `#note` prefixes still execute at the drain point
//      (shell runs, CLAUDE.md append) instead of going to the model as
//      literal text.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../tui/i18n.js";
import { dispatchQueuedLine, type TuiDeps } from "../tui/run.js";
import { TuiStore } from "../tui/store.js";

function makeDeps(toolContent: string, workspaceRoot: string): TuiDeps {
  const shellName = process.platform === "win32" ? "powershell" : "bash";
  return {
    tools: [
      {
        name: shellName,
        call: async () => ({ content: toolContent }),
      },
    ],
    workspaceRoot,
    getWorkspaceRoot: () => workspaceRoot,
  } as unknown as TuiDeps;
}

describe("dispatchQueuedLine — echo at injection, prefixes execute", () => {
  beforeEach(() => setLanguage("en"));

  it("plain text echoes exactly once, at dispatch (injection) time", async () => {
    const store = new TuiStore("p/m");
    const deps = makeDeps("", os.tmpdir());
    // Nothing echoed before dispatch (queue time is echo-free).
    expect(store.getSnapshot().transcript.length).toBe(0);
    const injected = await dispatchQueuedLine(store, deps, () => "s1", "hello model");
    expect(injected).toBe("hello model");
    const items = store.getSnapshot().transcript;
    expect(items.filter((i) => i.kind === "user").length).toBe(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "hello model" });
  });

  it("queued `!cmd` runs the shell and returns the bash-wrapped injection", async () => {
    const store = new TuiStore("p/m");
    const deps = makeDeps("total 42", os.tmpdir());
    const injected = await dispatchQueuedLine(store, deps, () => "s1", "!ls -la");
    expect(injected).toContain("<bash-input>ls -la</bash-input>");
    expect(injected).toContain("total 42");
    // Echo carries the bash marker (pink `!` in the transcript)…
    const items = store.getSnapshot().transcript;
    expect(items[0]).toMatchObject({ kind: "user", text: "ls -la", bash: true });
    // …and the shell output was echoed as dim notice lines.
    const notices = items.filter((i) => i.kind === "notice").map((i) => i.text);
    expect(notices.some((n) => n.includes("total 42"))).toBe(true);
  });

  it("queued `#note` appends to CLAUDE.md and injects nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-queue-mem-"));
    try {
      const store = new TuiStore("p/m");
      const deps = makeDeps("", dir);
      const injected = await dispatchQueuedLine(store, deps, () => "s1", "#prefer pnpm over npm");
      expect(injected).toBeNull();
      expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8")).toContain(
        "- prefer pnpm over npm",
      );
      const items = store.getSnapshot().transcript;
      expect(items[0]).toMatchObject({ kind: "user", memory: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bare `!` / `#` fall through as plain text (idle-path parity)", async () => {
    const store = new TuiStore("p/m");
    const deps = makeDeps("", os.tmpdir());
    expect(await dispatchQueuedLine(store, deps, () => "s1", "!")).toBe("!");
    expect(await dispatchQueuedLine(store, deps, () => "s1", "#")).toBe("#");
  });
});
