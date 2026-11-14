import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { check } from "./checks.mjs";

const root = realpathSync.native(process.cwd());
const git = (args, cwd = root, input) =>
  execFileSync("git", args, { cwd, input, encoding: "utf8", windowsHide: true, timeout: 5000 }).trimEnd();
const sources = ["src/sku.mjs", "src/summary.mjs"];

function assertPrimaryUnedited() {
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), " M notes.md");
  assert.equal(readFileSync(join(root, "notes.md"), "utf8"), "User draft: keep this uncommitted note verbatim.\n");
}

function retainedCheckout() {
  const entries = git(["worktree", "list", "--porcelain", "-z"]).split("\0\0").slice(1).filter(Boolean);
  assert.equal(entries.length, 1, "expected exactly one isolated checkout");
  const lines = entries[0].split("\0");
  const worktree = realpathSync.native(lines[0].slice("worktree ".length));
  const name = relative(join(root, ".claude", "worktrees"), worktree);
  assert.match(name, /^agent-wt-[a-f0-9]{8}$/);
  assert(lines.includes("branch refs/heads/codex/" + name));
  assert.equal(git(["rev-parse", "HEAD"], worktree), git(["rev-parse", "HEAD"]));
  assert.deepEqual(git(["diff", "--name-only", "HEAD"], worktree).split(/\r?\n/), sources);
  return worktree;
}

const stage = process.argv[2];
switch (stage) {
  case "baseline":
    assertPrimaryUnedited();
    try {
      await check(root, false);
    } catch (error) {
      console.error("COLLAB_BASELINE_FAILED", error.message);
      process.exitCode = 1;
    }
    assert.equal(process.exitCode, 1, "fixture must fail before work");
    break;
  case "draft": {
    assertPrimaryUnedited();
    const tree = retainedCheckout();
    await check(tree, false);
    await assert.rejects(check(tree, true), { name: "AssertionError" });
    console.log("COLLAB_DRAFT_PASSED");
    console.log("COLLAB_REVIEW_REQUIRED: Match trimmed SKUs case-insensitively. Preserve the first trimmed spelling for display and keep first-seen order.");
    break;
  }
  case "revised":
    assertPrimaryUnedited();
    await check(retainedCheckout(), true);
    console.log("COLLAB_REVISION_PASSED");
    break;
  case "integrate": {
    assertPrimaryUnedited();
    const tree = retainedCheckout();
    await check(tree, true);
    const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...sources], {
      cwd: tree, windowsHide: true, timeout: 5000,
    });
    git(["apply", "--check", "-"], root, patch);
    git(["apply", "-"], root, patch);
    console.log("COLLAB_PATCH_APPLIED");
    break;
  }
  case "test":
    await check(root, true);
    console.log("COLLAB_MAIN_TESTS_PASSED");
    break;
  default:
    throw new Error("Unknown collaboration stage");
}
