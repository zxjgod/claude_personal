// ============================================================
// Tests: read tracker (read-before-edit)
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  markRead,
  checkReadBeforeEdit,
  refreshRead,
  resetReadTracker,
} from "../read-tracker.js";

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
