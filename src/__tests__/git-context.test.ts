// ============================================================
// Tests: git context injection (12.4)
// ============================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatGitContext, gatherDiffSummary, gatherGitContext } from "../git-context.js";

let repo: string;
let hasGit = true;

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-git-"));
  try {
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.io"], repo);
    git(["config", "user.name", "Tester"], repo);
  } catch {
    hasGit = false;
  }
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("gatherGitContext", () => {
  it("returns null for a non-git directory", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plain-"));
    try {
      expect(await gatherGitContext(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("reports branch, dirty files, and recent commits", async () => {
    if (!hasGit) return;
    fs.writeFileSync(path.join(repo, "a.txt"), "hello");
    git(["add", "a.txt"], repo);
    git(["commit", "-m", "first commit"], repo);
    // Now create an uncommitted change.
    fs.writeFileSync(path.join(repo, "b.txt"), "dirty");

    const ctx = await gatherGitContext(repo);
    expect(ctx).not.toBeNull();
    expect(ctx!.branch).toBe("main");
    expect(ctx!.recentCommits).toContain("first commit");
    expect(ctx!.dirtyFiles.some((f) => f.includes("b.txt"))).toBe(true);
  });

  it("reports a clean working tree after commit", async () => {
    if (!hasGit) return;
    fs.writeFileSync(path.join(repo, "a.txt"), "hello");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
    const ctx = await gatherGitContext(repo);
    expect(ctx!.dirtyFiles).toHaveLength(0);
  });
});

describe("gatherDiffSummary", () => {
  it("treats a missing upstream as a legitimate empty result", async () => {
    if (!hasGit) return;
    fs.writeFileSync(path.join(repo, "a.txt"), "hello");
    git(["add", "a.txt"], repo);
    git(["commit", "-m", "init"], repo);

    const summary = await gatherDiffSummary(repo);
    expect(summary).not.toBeNull();
    expect(summary?.errors).toEqual([]);
    expect(summary?.upstreamFiles).toEqual([]);
    expect(summary?.branchCommits).toEqual([]);
  });
});

describe("formatGitContext", () => {
  it("renders a clean tree", () => {
    const text = formatGitContext({
      branch: "main",
      dirtyFiles: [],
      dirtyTruncated: false,
      recentCommits: ["init"],
    });
    expect(text).toContain("Branch: main");
    expect(text).toContain("Working tree: clean");
    expect(text).toContain("- init");
  });

  it("renders dirty files with a truncation marker", () => {
    const text = formatGitContext({
      branch: "dev",
      dirtyFiles: [" M src/a.ts", "?? new.ts"],
      dirtyTruncated: true,
      recentCommits: [],
    });
    expect(text).toContain("Uncommitted changes (2+)");
    expect(text).toContain("src/a.ts");
  });
});
