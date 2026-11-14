import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { check, source, userLabel } from "./rules.mjs";

const root = realpathSync.native(process.cwd());
const git = (args, cwd = root, input) => execFileSync("git", args, {
  cwd, input, encoding: "utf8", windowsHide: true, timeout: 5000,
}).trimEnd();
const patchArgs = ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", source];

async function workerTrees() {
  const head = git(["rev-parse", "HEAD"]);
  const list = git(["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter(Boolean);
  assert.equal(list.length, 3, "expected primary plus two worker checkouts");
  const trees = new Map();
  for (const entry of list) {
    const lines = entry.split("\0");
    const tree = realpathSync.native(lines[0].slice("worktree ".length));
    if (tree === root) continue;
    const name = relative(join(root, ".claude", "worktrees"), tree);
    assert.match(name, /^agent-wt-[a-f0-9]{8}$/);
    assert(lines.includes("branch refs/heads/codex/" + name));
    assert(lines.includes("HEAD " + head), "both patches must share the primary base");
    assert.equal(git(["diff", "--name-only", "HEAD"], tree), source);
    for (const role of ["quantity", "currency"]) {
      let matches = true;
      try {
        await check(tree, { quantity: role === "quantity", currency: role === "currency", label: "Receipt" });
      } catch (error) {
        if (error.name !== "AssertionError") throw error;
        matches = false;
      }
      if (matches) {
        assert(!trees.has(role), "each worktree must implement a distinct rule");
        trees.set(role, tree);
      }
    }
  }
  assert.equal(trees.size, 2, "both independent patches must pass their tests");
  return trees;
}

switch (process.argv[2]) {
  case "baseline":
    await check(root, { quantity: false, currency: false, label: userLabel });
    await assert.rejects(check(root, { quantity: true, currency: true, label: userLabel }), { name: "AssertionError" });
    console.error("WORKTREE_BASELINE_FAILED: eligibility accepts invalid quantities and currencies.");
    process.exitCode = 1;
    break;
  case "apply-quantity": {
    await check(root, { quantity: false, currency: false, label: userLabel });
    const trees = await workerTrees();
    const patch = git(patchArgs, trees.get("quantity")) + "\n";
    git(["apply", "--check", "-"], root, patch);
    git(["apply", "-"], root, patch);
    console.log("WORKTREE_QUANTITY_APPLIED");
    break;
  }
  case "apply-currency": {
    await check(root, { quantity: true, currency: false, label: userLabel });
    const trees = await workerTrees();
    const before = git(["diff", "--binary", "--no-ext-diff", "HEAD"]);
    const index = git(["write-tree"]);
    const patch = git(patchArgs, trees.get("currency")) + "\n";
    const applied = spawnSync("git", ["apply", "-"], {
      cwd: root, input: patch, encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    if (applied.error) throw applied.error;
    assert.notEqual(applied.status, 0, "expected Git to reject the overlapping patch");
    assert.match(applied.stderr, /patch failed|patch does not apply/i);
    assert.equal(git(["write-tree"]), index);
    assert.equal(git(["diff", "--binary", "--no-ext-diff", "HEAD"]), before);
    console.error("WORKTREE_PATCH_CONFLICT: Git rejected the patch. Primary files and index are unchanged.");
    console.error(applied.stderr.trimEnd());
    console.error("Currency worker patch:\n" + patch);
    process.exitCode = 1;
    break;
  }
  case "test":
    await check(root, { quantity: true, currency: true, label: userLabel });
    assert(!/^(<<<<<<<|=======|>>>>>>>)/m.test(readFileSync(join(root, source), "utf8")));
    console.log("WORKTREE_MERGED_TESTS_PASSED");
    break;
  default:
    throw new Error("Unknown conflict evaluation stage");
}
