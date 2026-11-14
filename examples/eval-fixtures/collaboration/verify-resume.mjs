import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./verify.mjs";

const [, answerPath] = process.argv.slice(2);
const answer = JSON.parse(readFileSync(answerPath, "utf8"));
const queries = answer.evaluation_queries;
assert(Array.isArray(queries) && queries.length === 2, "two CLI queries are required");
const [review, continuation] = queries;
assert.equal(review.session_id, answer.session_id);
assert.equal(continuation.session_id, answer.session_id);
assert.equal(review.trace_start, 0);
assert.equal(continuation.trace_start, review.trace_end);
assert.equal(continuation.trace_end, answer.evaluation_trace.length);
const reviewTrace = answer.evaluation_trace.slice(0, review.trace_end);
const continuationTrace = answer.evaluation_trace.slice(continuation.trace_start);
const agentCalls = (trace) => trace.filter((event) =>
  event.type === "tool_use" && event.name.toLowerCase() === "agent");
assert.equal(agentCalls(reviewTrace).length, 1);
assert(!agentCalls(reviewTrace)[0].input.resume);
assert(reviewTrace.some((event) => event.type === "tool_result" &&
  !event.is_error && event.content.includes("COLLAB_REVIEW_REQUIRED")));
assert.equal(agentCalls(continuationTrace).length, 1);
assert(agentCalls(continuationTrace)[0].input.resume);
assert(continuationTrace.some((event) => event.type === "tool_result" &&
  !event.is_error && event.content.includes("COLLAB_MAIN_TESTS_PASSED")));
