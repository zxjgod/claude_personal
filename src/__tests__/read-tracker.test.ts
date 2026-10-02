// ============================================================
// Tests: read tracker (read-before-edit)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReadBeforeEdit, markRead, refreshRead, resetReadTracker } from "../read-tracker.js";
import { ReadTool } from "../tools/core/read.js";
import type { ToolContext } from "../types.js";

beforeEach(() => resetReadTracker());

describe("checkReadBeforeEdit", () => {
  it("rejects editing a file that was never read", () => {
    const r = checkReadBeforeEdit("s1", "/a.txt", 100);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("has not been read");
  });

  it("allows editing after a matching read", () => {
    markRead("s1", "/a.txt", 100);
    expect(checkReadBeforeEdit("s1", "/a.txt", 100).ok).toBe(true);
  });

  it("rejects when the file changed on disk since read", () => {
    markRead("s1", "/a.txt", 100);
    const r = checkReadBeforeEdit("s1", "/a.txt", 200);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("changed on disk");
  });

  it("allows a brand-new file (no current mtime)", () => {
    expect(checkReadBeforeEdit("s1", "/new.txt", undefined).ok).toBe(true);
  });

  it("isolates state per session", () => {
    markRead("s1", "/a.txt", 100);
    expect(checkReadBeforeEdit("s2", "/a.txt", 100).ok).toBe(false);
  });

  it("refreshRead updates the tracked mtime", () => {
    markRead("s1", "/a.txt", 100);
    refreshRead("s1", "/a.txt", 300);
    expect(checkReadBeforeEdit("s1", "/a.txt", 300).ok).toBe(true);
  });
});

// ============================================================
// Top10 #6: speculative reads must NOT satisfy read-before-edit
// ============================================================
// A prefetched Read runs before the model ever asked for the file. If it
// marked the tracker, the model could Edit a file it never read in the
// conversation. The speculative read instead reports {readPath, readMtimeMs}
// in metadata; tool-executor promotes it into the tracker only on a cache HIT
// (when the content actually goes to the model).
// ============================================================

describe("speculative reads vs read-before-edit (Top10 #6)", () => {
  let dir: string;
  let file: string;
  let ctx: ToolContext;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-readtrack-"));
    file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "line one\nline two\n");
    ctx = { workspaceRoot: dir, sessionId: "spec-session", permissionMode: "default" };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a speculative ReadTool call does NOT open the gate, and reports promotion metadata", async () => {
    const res = await ReadTool.call({ filePath: file }, { ...ctx, speculative: true });
    expect(res.error).toBeUndefined();
    expect(res.metadata?.readPath).toBe(fs.realpathSync.native(file));
    expect(typeof res.metadata?.readMtimeMs).toBe("number");
    const { mtimeMs } = fs.statSync(file);
    expect(checkReadBeforeEdit(ctx.sessionId, file, mtimeMs).ok).toBe(false);
  });

  it("a normal ReadTool call opens the gate and adds no speculative metadata", async () => {
    const res = await ReadTool.call({ filePath: file }, ctx);
    expect(res.error).toBeUndefined();
    expect(res.metadata?.readPath).toBeUndefined();
    const { mtimeMs } = fs.statSync(file);
    expect(checkReadBeforeEdit(ctx.sessionId, file, mtimeMs).ok).toBe(true);
  });

  it("promotion with the prefetched mtime opens the gate; a later mutation re-closes it", async () => {
    // Simulates the tool-executor cache-hit promotion.
    const res = await ReadTool.call({ filePath: file }, { ...ctx, speculative: true });
    const md = res.metadata as { readPath: string; readMtimeMs: number };
    markRead(ctx.sessionId, md.readPath, md.readMtimeMs);
    expect(checkReadBeforeEdit(ctx.sessionId, file, md.readMtimeMs).ok).toBe(true);

    // File mutated after the prefetch: the tracker's staleness check rejects
    // (the promoted mtime is the version the model saw, not the new one).
    await new Promise((r) => setTimeout(r, 15)); // ensure a distinct mtime
    fs.writeFileSync(file, "mutated while cached\n");
    const now = fs.statSync(file).mtimeMs;
    expect(now).not.toBe(md.readMtimeMs);
    const check = checkReadBeforeEdit(ctx.sessionId, file, now);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("changed on disk");
  });
});
