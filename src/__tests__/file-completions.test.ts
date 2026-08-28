// ============================================================
// Tests: file-completions — "@" path autocomplete source (P2-10)
// ============================================================
// Builds a throwaway fixture tree and verifies matching, capping, and the
// vendored-directory ignores. The listing cache is cleared between tests so
// each one lists its own fixture deterministically.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFileCompletionCache,
  completeFiles,
  MAX_FILE_SUGGESTIONS,
} from "../tui/file-completions.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccr-completions-"));
  clearFileCompletionCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearFileCompletionCache();
});

function touch(rel: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p.replace(/[/\\]$/, ""), "x");
}

describe("completeFiles", () => {
  it("matches by path prefix, case-insensitively", () => {
    touch("src/tui/App.tsx");
    touch("src/util.ts");
    touch("docs/guide.md");
    expect(completeFiles(root, "src/tu")).toEqual(["src/tui/App.tsx"]);
    expect(completeFiles(root, "SRC/")).toContain("src/util.ts");
  });

  it("backfills substring matches when few prefix hits exist", () => {
    touch("src/tui/App.tsx");
    touch("docs/my-app-notes.md");
    // "app" is not a path prefix of anything, but both contain it.
    const hits = completeFiles(root, "app");
    expect(hits).toContain("src/tui/App.tsx");
    expect(hits).toContain("docs/my-app-notes.md");
  });

  it("caps results at MAX_FILE_SUGGESTIONS and prefers shorter paths", () => {
    for (let i = 0; i < 20; i++) touch(`long/deeply/nested/dir_${i}/file.txt`);
    touch("short.txt");
    const hits = completeFiles(root, "t"); // everything matches by substring
    expect(hits.length).toBeLessThanOrEqual(MAX_FILE_SUGGESTIONS);
    expect(hits[0]).toBe("short.txt"); // shortest path first
  });

  it("never suggests vendored/ignored directories", () => {
    touch("node_modules/pkg/index.js");
    touch(".git/config");
    touch("src/real.ts");
    expect(completeFiles(root, "")).toEqual([]);
    const hits = completeFiles(root, "s");
    expect(hits).toEqual(["src/real.ts"]);
  });

  it("returns nothing for an empty query (no unfocused dumping)", () => {
    touch("src/App.tsx");
    expect(completeFiles(root, "")).toEqual([]);
    expect(completeFiles(root, "   ")).toEqual([]);
  });

  it("treats backslash queries like forward slashes (Windows typing)", () => {
    touch("src/tui/App.tsx");
    expect(completeFiles(root, "src\\tu")).toEqual(["src/tui/App.tsx"]);
  });
});
