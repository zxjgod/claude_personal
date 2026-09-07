// ============================================================
// Regression: editInEditor must READ BACK the edited temp file
// ============================================================
// The 2026-09 review found openInEditor deleting the temp file in its
// finally block BEFORE editInEditor read it back — every ctrl+g / plan-edit
// session silently returned the original draft. These tests pin the fixed
// ordering with a mocked child process that "edits" the file, then exits 0.
// ============================================================

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the editor child process: capture the temp file path from the spawn
// args, simulate the user editing it, then exit 0. Both spawn shapes are
// covered: POSIX direct spawn(cmd, args) and the Windows shell string.
vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, argsOrOpts: unknown) => {
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {};
    // The temp file is always the LAST path-like token in the command.
    const rendered =
      typeof argsOrOpts === "string"
        ? (argsOrOpts as unknown as string) // shell form (unused here)
        : Array.isArray(argsOrOpts)
          ? argsOrOpts.join(" ")
          : String(cmd);
    const match =
      rendered.match(/[^\s"]*ccr-transcript-\d+\.txt/) ??
      String(cmd).match(/[^\s"]*ccr-transcript-\d+\.txt/);
    const filePath = match?.[0];
    process.nextTick(() => {
      if (filePath && fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, "user edited this\n", "utf-8");
      }
      child.emit("exit", 0);
    });
    return child;
  }),
}));

import { editInEditor, openInEditor } from "../tui/open-editor.js";

describe("editInEditor read-back (P0 regression)", () => {
  beforeEach(() => {
    process.env.EDITOR = "fake-editor";
    delete process.env.VISUAL;
  });
  afterEach(() => {
    delete process.env.EDITOR;
  });

  it("returns the content the user saved in the editor", async () => {
    const result = await editInEditor("original draft");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("user edited this");
  });

  it("deletes the temp file after reading it back", async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));
    await editInEditor("draft");
    const after = fs.readdirSync(os.tmpdir());
    const leaked = after.filter((f) => f.startsWith("ccr-transcript-") && !before.has(f));
    expect(leaked).toEqual([]);
  });

  it("openInEditor still cleans up on success by default (view-only path)", async () => {
    const { ok, filePath } = await openInEditor(["line one", "line two"]);
    expect(ok).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
