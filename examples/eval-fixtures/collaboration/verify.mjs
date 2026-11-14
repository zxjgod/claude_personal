import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { check } from "./workspace/checks.mjs";

const [root, answerPath, phase] = process.argv.slice(2);
const answer = JSON.parse(readFileSync(answerPath, "utf8"));
const sources = ["src/sku.mjs", "src/summary.mjs"];
const read = (file) => readFileSync(join(root, file), "utf8");
const git = (args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", windowsHide: true, timeout: 5000,
}).trimEnd();

for (const file of [".gitignore", ".claude/agents/order-worker.md", "checks.mjs", "collaborate.mjs"])
  assert.equal(read(file), readFileSync(new URL(`workspace/${file}`, import.meta.url), "utf8"), file);
assert.equal(read("notes.md"), "User draft: keep this uncommitted note verbatim.\n");
assert.equal(git(["show", "HEAD:notes.md"]), "Committed notes.");
assert.equal(git(["diff", "--cached", "--name-only"]), "");
assert.deepEqual(git(["diff", "--name-only", "HEAD"]).split(/\r?\n/), ["notes.md", ...sources]);
await check(root, true);

if (phase === "workspace") {
  const calls = new Map();
  const milestones = [];
  for (const event of answer.evaluation_trace) {
    if (event.type === "tool_use") {
      const name = event.name.toLowerCase();
      assert(["agent", "bash", "powershell", "read", "glob", "grep"].includes(name), `unexpected parent tool: ${name}`);
      calls.set(event.id, event);
    }
    if (event.type !== "tool_result") continue;
    const call = calls.get(event.tool_use_id);
    assert(call, "each result must have a prior tool call");
    const name = call.name.toLowerCase();
    if (name === "agent") milestones.push({ key: "agent", call, event });
    if (name === "bash" || name === "powershell") {
      if (!/^node collaborate\.mjs (baseline|draft|revised|integrate|test)$/.test(call.input.command)) {
        assert.equal(event.is_error, true, "unapproved shell command executed");
        assert.match(event.content, /^Permission denied:/, "expected an explicit approval denial");
        continue;
      }
      assert(!call.input.run_in_background, "validation must finish before the next step");
      milestones.push({ key: call.input.command.split(" ").at(-1), call, event });
    }
  }
  assert.deepEqual(milestones.map(({ key }) => key), [
    "baseline", "agent", "draft", "agent", "revised", "integrate", "test",
  ]);
  const [baseline, draft, review, revised, validation, integration, test] = milestones;
  assert.equal(baseline.event.is_error, true);
  assert.match(baseline.event.content, /COLLAB_BASELINE_FAILED/);
  for (const milestone of milestones.slice(1)) assert.equal(milestone.event.is_error, false);
  assert.match(review.event.content, /COLLAB_DRAFT_PASSED[\s\S]*COLLAB_REVIEW_REQUIRED/);
  assert.match(validation.event.content, /COLLAB_REVISION_PASSED/);
  assert.match(integration.event.content, /COLLAB_PATCH_APPLIED/);
  assert.match(test.event.content, /COLLAB_MAIN_TESTS_PASSED/);
  assert.equal(draft.call.input.subagent_type, "order-worker");
  assert.equal(draft.call.input.isolation, "worktree");
  assert(!draft.call.input.resume && !draft.call.input.run_in_background);
  const agentId = draft.event.content.match(/\(Agent id: (order-worker-[\w-]+) —/)?.[1];
  assert(agentId, "worker must return a resumable id");
  assert.equal(revised.call.input.resume, agentId);
  assert(!revised.call.input.isolation && !revised.call.input.run_in_background);
  assert.match(revised.call.input.prompt, /case.insensitiv/i);
  const draftTree = draft.event.content.match(/^Worktree retained: (.+)$/m)?.[1];
  const revisedTree = revised.event.content.match(/^Worktree retained: (.+)$/m)?.[1];
  assert(draftTree && revisedTree, "both worker results must report retained checkouts");
  assert.equal(revisedTree, draftTree);
  const tree = realpathSync.native(draftTree);
  assert.match(relative(join(realpathSync.native(root), ".claude", "worktrees"), tree), /^agent-wt-[a-f0-9]{8}$/);
  for (const file of sources) assert.equal(read(file), readFileSync(join(tree, file), "utf8"));

  assert.match(answer.session_id, /^[\w-]+$/);
  const record = JSON.parse(read(`.claude/sessions/subagents-${answer.session_id}/${agentId}.json`));
  assert.equal(record.status, "completed");
  assert.equal(record.worktree.path, tree);
  assert.equal(record.worktree.baseCommit, git(["rev-parse", "HEAD"]));
  const reviewTurn = record.messages.findIndex((message) =>
    message.role === "user" &&
    (typeof message.content === "string"
      ? message.content === revised.call.input.prompt
      : message.content.some((block) => block.type === "text" && block.text === revised.call.input.prompt)));
  assert(reviewTurn > 0, "review feedback must appear in the same worker transcript");
  for (const messages of [record.messages.slice(0, reviewTurn), record.messages.slice(reviewTurn)]) {
    const edits = [];
    for (const message of messages) {
      for (const call of message.tool_calls ?? []) {
        const name = call.function.name.toLowerCase();
        assert(["read", "write", "edit"].includes(name), `unexpected worker tool: ${name}`);
        if (name === "read") continue;
        const input = JSON.parse(call.function.arguments);
        const file = input.file_path ?? input.filePath;
        const filePath = file.replaceAll("\\", "/");
        assert(sources.some((source) => filePath === source || filePath.endsWith("/" + source)));
        if (messages.some((result) => result.role === "tool" &&
          result.tool_call_id === call.id && !result.content.startsWith("Error:"))) edits.push(file);
      }
    }
    assert(edits.length, "both worker turns must make source edits");
  }
} else {
  assert.equal(phase, "patch-replay");
}
