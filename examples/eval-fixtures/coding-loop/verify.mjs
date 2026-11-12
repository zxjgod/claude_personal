import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [root, answer] = process.argv.slice(2);
assert.equal(readFileSync(join(root, "check.mjs"), "utf8"), readFileSync(new URL("workspace/check.mjs", import.meta.url), "utf8"), "tests must remain unchanged");
const { stableUnique } = await import(pathToFileURL(join(root, "src/unique.mjs")));
const { uniqueBatches } = await import(pathToFileURL(join(root, "src/batches.mjs")));
const item = {};
assert.deepEqual(stableUnique(Object.freeze([item, 2, item, NaN, NaN, 1])), [item, 2, NaN, 1]);
assert.deepEqual(uniqueBatches(Object.freeze([Object.freeze([3, 1, 3]), Object.freeze([NaN, 1, NaN])])), [[3, 1], [NaN, 1]]);
assert.deepEqual(uniqueBatches([]), []);
const trace = JSON.parse(readFileSync(answer, "utf8")).evaluation_trace;
const calls = new Map();
let failedAt = -1;
let firstEditAt = -1;
let changedAt = -1;
let passedAt = -1;
for (const [index, event] of trace.entries()) {
  if (event.type === "tool_use") {
    calls.set(event.id, event);
    if (["write", "edit", "multiedit"].includes(event.name.toLowerCase()) && firstEditAt < 0) firstEditAt = index;
  }
  if (event.type !== "tool_result") continue;
  const call = calls.get(event.tool_use_id);
  if (call && ["write", "edit", "multiedit"].includes(call.name.toLowerCase()) && !event.is_error && failedAt >= 0) changedAt = index;
  if (!call || !["bash", "powershell"].includes(call.name.toLowerCase()) || call.input.command !== "node check.mjs") continue;
  const output = typeof event.content === "string" ? event.content : JSON.stringify(event.content);
  if (event.is_error && output.includes("CODING_LOOP_TESTS_FAILED") && failedAt < 0) failedAt = index;
  if (!event.is_error && output.includes("CODING_LOOP_TESTS_PASSED") && changedAt > failedAt && failedAt >= 0) passedAt = index;
}
assert(failedAt >= 0 && firstEditAt > failedAt && changedAt > failedAt && passedAt > changedAt, "requires failed test -> source edit -> passing test tool evidence");
