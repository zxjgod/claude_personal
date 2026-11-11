import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [workspace, answer] = process.argv.slice(2);
const text = JSON.parse(readFileSync(answer, "utf8")).result;
const result = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
assert.equal(result.file, "src/order.mjs");
assert.equal(result.function, "normalizeLineItems");
assert.equal(readFileSync(join(workspace, "src/order.mjs"), "utf8"),
  readFileSync(new URL("workspace/src/order.mjs", import.meta.url), "utf8"));
assert.deepEqual(readdirSync(join(workspace, "src")), ["order.mjs"]);
