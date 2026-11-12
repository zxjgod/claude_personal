import assert from "node:assert/strict";
import { stableUnique } from "./src/unique.mjs";
import { uniqueBatches } from "./src/batches.mjs";
try {
  assert.deepEqual(stableUnique(Object.freeze([3, 1, 3, 2])), [3, 1, 2], "stableUnique must retain input order");
  assert.deepEqual(uniqueBatches([[3, 1, 3], [2, 4, 2]]), [[3, 1], [2, 4]], "batch API must retain each batch order");
  console.log("CODING_LOOP_TESTS_PASSED");
} catch (error) {
  console.error("CODING_LOOP_TESTS_FAILED");
  console.error(error);
  process.exitCode = 1;
}
