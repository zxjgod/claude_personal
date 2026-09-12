// ============================================================
// Path Security Tests - Workspace Boundary & Symlink Escape
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveInWorkspace } from "../tools/utils/path.js";

describe("resolveInWorkspace", () => {
  it("allows files under explicitly granted additional directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-root-"));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-extra-"));
    const file = path.join(extra, "x.txt");
    fs.writeFileSync(file, "x");
    expect(resolveInWorkspace(file, root, [extra])).toEqual({ ok: true, path: file });
  });
  describe("basic boundary checks", () => {
    it("should accept paths inside workspace", () => {
      const result = resolveInWorkspace("src/index.ts", "/workspace");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(path.resolve("/workspace/src/index.ts"));
      }
    });

    it("should reject paths outside workspace (absolute)", () => {
      const result = resolveInWorkspace("/etc/passwd", "/workspace");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("outside workspace");
      }
    });

    it("should reject path traversal escape", () => {
      const result = resolveInWorkspace("../../etc/passwd", "/workspace");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("outside workspace");
      }
    });

    it("should allow workspace root itself", () => {
      const result = resolveInWorkspace(".", "/workspace");
      expect(result.ok).toBe(true);
    });

    it("should prevent prefix aliasing attack", () => {
      // /workspace-evil should not be accessible via /workspace/../../../workspace-evil
      const result = resolveInWorkspace("../../../workspace-evil/file", "/workspace");
      expect(result.ok).toBe(false);
    });
  });

  describe("symlink escape prevention", () => {
    let tempDir: string;
    let outsideDir: string;
    const tempFiles: string[] = [];

    beforeAll(() => {
      // Create a temp workspace and a parent directory outside it
      const base = fs.mkdtempSync(path.join(require("os").tmpdir(), "ccr-test-"));
      outsideDir = path.join(base, "outside");
      fs.mkdirSync(outsideDir);
      tempDir = path.join(base, "ws");
      fs.mkdirSync(tempDir);
    });

    afterAll(() => {
      // Cleanup: remove symlink first, then files
      for (const f of tempFiles) {
        try {
          fs.unlinkSync(f);
        } catch {
          // ignore
        }
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("should block symlink pointing outside workspace", () => {
      // Create a file OUTSIDE the workspace (in outsideDir, not tempDir)
      const outsideFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideFile, "secret");
      tempFiles.push(outsideFile);

      // Create a symlink INSIDE workspace pointing to the outside file
      const linkPath = path.join(tempDir, "link-to-outside.txt");
      try {
        fs.symlinkSync(outsideFile, linkPath);
        tempFiles.push(linkPath);
      } catch {
        // Symlinks may not be supported on all filesystems (e.g., some Windows configurations)
        console.warn("Symlink test skipped: symlinks not supported");
        return;
      }

      // The symlink resolves to a path OUTSIDE tempDir, so it should be blocked
      const result = resolveInWorkspace("link-to-outside.txt", tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("outside workspace");
      }
    });

    it("should allow valid symlinks pointing inside workspace", () => {
      // Create a file inside workspace
      const insideFile = path.join(tempDir, "inside.txt");
      fs.writeFileSync(insideFile, "content");
      tempFiles.push(insideFile);

      // Create a symlink inside workspace pointing to another inside path
      const linkPath = path.join(tempDir, "link-inside.txt");
      try {
        fs.symlinkSync(insideFile, linkPath);
        tempFiles.push(linkPath);
      } catch {
        console.warn("Symlink test skipped: symlinks not supported");
        return;
      }

      const result = resolveInWorkspace("link-inside.txt", tempDir);
      expect(result.ok).toBe(true);
    });

    it("should handle broken symlinks gracefully (fallback to resolved path)", () => {
      // Create a broken symlink (target doesn't exist)
      const brokenLink = path.join(tempDir, "broken-link.txt");
      try {
        fs.symlinkSync(path.join(tempDir, "nonexistent-target.txt"), brokenLink);
        tempFiles.push(brokenLink);
      } catch {
        console.warn("Symlink test skipped: symlinks not supported");
        return;
      }

      // Broken symlinks should not cause crashes, and the resolved path check still applies
      const result = resolveInWorkspace("broken-link.txt", tempDir);
      // The resolved path IS inside workspace, so it's allowed
      // (realpath would fail and we fall back to resolved)
      expect(result.ok).toBe(true);
    });
  });
});
