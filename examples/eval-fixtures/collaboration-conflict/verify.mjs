import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { check, source, userLabel } from "./workspace/rules.mjs";

const [root, answerPath, phase] = process.argv.slice(2);
const answer = JSON.parse(readFileSync(answerPath, "utf8"));
const read = (file) => readFileSync(join(root, file), "utf8");
const original = (file) => readFileSync(new URL(`workspace/${file}`, import.meta.url), "utf8");
const git = (args, cwd = root) => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true, timeout: 5000,
}).trimEnd();
const prefix = (text) => text.split("export function eligible(order)")[0];

for (const file of [".gitignore", ".claude/agents/rule-worker.md", "rules.mjs", "conflict.mjs"])
  assert.equal(read(file), original(file), file);
assert.equal(git(["status", "--porcelain", "--untracked-files=all"]), " M " + source);
assert.equal(prefix(read(source)), prefix(original(source)).replace('"Receipt"', JSON.stringify(userLabel)));
assert.equal(git(["show", "HEAD:" + source]), original(source).trimEnd());
await check(root, { quantity: true, currency: true, label: userLabel });
assert(!/^(<<<<<<<|=======|>>>>>>>)/m.test(read(source)));

if (phase === "workspace") {
  const calls = new Map();
  const milestones = [];
  let conflict = -1;
  let readAfterConflict = false;
  let merged = false;
  const sourcePath = realpathSync.native(join(root, source));
  const trace = answer.evaluation_trace;
  for (const [index, event] of trace.entries()) {
    if (event.type === "tool_use") {
      assert(["agent", "bash", "powershell", "read", "glob", "grep", "edit", "write"].includes(event.name.toLowerCase()));
      calls.set(event.id, { call: event, index });
      if (["edit", "write"].includes(event.name.toLowerCase()))
        assert(conflict >= 0, "primary source edits must follow the conflict");
      continue;
    }
    if (event.type !== "tool_result") continue;
    const found = calls.get(event.tool_use_id);
    assert(found, "each result must have a prior tool call");
    const { call, index: callIndex } = found;
    const name = call.name.toLowerCase();
    if (name === "agent") milestones.push({ key: "agent", call, event });
    if (name === "bash" || name === "powershell") {
      const match = /^node conflict\.mjs (baseline|apply-quantity|apply-currency|test)$/.exec(call.input.command);
      if (!match) {
        assert.equal(event.is_error, true, "unapproved shell command executed");
        assert.match(event.content, /^Permission denied:/);
        continue;
      }
      assert(!call.input.run_in_background);
      const key = match[1];
      if (key === "apply-currency") conflict = index;
      if (key === "test") assert(merged, "run tests after resolving the conflict");
      milestones.push({ key, call, event });
    }
    const file = call.input.file_path ?? call.input.filePath;
    if (name === "read" && !event.is_error && callIndex > conflict && conflict >= 0 &&
        typeof file === "string" && realpathSync.native(resolve(root, file)) === sourcePath) {
      readAfterConflict = true;
    }
    if (name === "edit" || name === "write") {
      assert.equal(realpathSync.native(resolve(root, file)), sourcePath);
      assert(readAfterConflict, "read the conflicted source before resolving it");
      if (!event.is_error) merged = true;
    }
  }
  assert.deepEqual(milestones.map(({ key }) => key), [
    "baseline", "agent", "agent", "apply-quantity", "apply-currency", "test",
  ]);
  const [baseline, first, second, applied, rejected, test] = milestones;
  assert.equal(baseline.event.is_error, true);
  assert.match(baseline.event.content, /WORKTREE_BASELINE_FAILED/);
  assert.equal(applied.event.is_error, false);
  assert.match(applied.event.content, /WORKTREE_QUANTITY_APPLIED/);
  assert.equal(rejected.event.is_error, true);
  assert.match(rejected.event.content, /WORKTREE_PATCH_CONFLICT[\s\S]*patch does not apply/i);
  assert.equal(test.event.is_error, false);
  assert.match(test.event.content, /WORKTREE_MERGED_TESTS_PASSED/);

  const identities = new Set();
  const trees = new Set();
  const roles = new Set();
  assert.match(answer.session_id, /^[\w-]+$/);
  for (const { call, event } of [first, second]) {
    assert.equal(call.input.subagent_type, "rule-worker");
    assert.equal(call.input.isolation, "worktree");
    assert(!call.input.resume && !call.input.run_in_background);
    assert.equal(event.is_error, false);
    const agentId = event.content.match(/\(Agent id: (rule-worker-[\w-]+) —/)?.[1];
    const treePath = event.content.match(/^Worktree retained: (.+)$/m)?.[1];
    assert(agentId && treePath, "expected retained worker identity");
    const tree = realpathSync.native(treePath);
    assert.match(relative(join(realpathSync.native(root), ".claude", "worktrees"), tree), /^agent-wt-[a-f0-9]{8}$/);
    const record = JSON.parse(read(`.claude/sessions/subagents-${answer.session_id}/${agentId}.json`));
    assert.equal(record.status, "completed");
    assert.equal(record.worktree.path, tree);
    assert.equal(record.worktree.baseCommit, git(["rev-parse", "HEAD"]));
    assert.equal(git(["rev-parse", "HEAD"], tree), record.worktree.baseCommit);
    assert.equal(git(["diff", "--name-only", "HEAD"], tree), source);
    assert.equal(prefix(readFileSync(join(tree, source), "utf8")), prefix(original(source)));
    for (const role of ["quantity", "currency"]) {
      try {
        await check(tree, { quantity: role === "quantity", currency: role === "currency", label: "Receipt" });
        roles.add(role);
      } catch (error) {
        if (error.name !== "AssertionError") throw error;
      }
    }
    identities.add(agentId);
    trees.add(tree);
  }
  assert.equal(identities.size, 2);
  assert.equal(trees.size, 2);
  assert.equal(roles.size, 2);
} else assert.equal(phase, "patch-replay");
