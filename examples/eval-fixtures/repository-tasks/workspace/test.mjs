import assert from "node:assert/strict";

try {
  const { TaskCatalog, parseTaskLines, readyTitles } = await import("./dist/index.js");
  const text = '\n{"id":" low ","title":" Low ","priority":0,"status":"todo"}\n{"id":"high","title":"High","priority":2,"status":"todo"}\n';
  assert.equal(parseTaskLines(text)[0].id, "low");
  assert.equal(readyTitles(text), "High, Low");
  const input = [{ id: "a", title: "A", priority: 1, status: "todo" }];
  const catalog = new TaskCatalog(input);
  assert.equal(catalog.complete("a"), true);
  assert.equal(catalog.complete("a"), false);
  assert.equal(input[0].status, "todo");
  catalog.list()[0].title = "changed outside";
  assert.equal(catalog.list()[0].title, "A");
  assert.throws(() => parseTaskLines('{"id":"bad","title":"B","priority":3,"status":"todo"}'), /line 1/i);
  assert.throws(() => parseTaskLines("\nnot JSON"), /line 2/i);
  console.log("REPOSITORY_TESTS_PASSED");
} catch (error) {
  console.error(`REPOSITORY_TESTS_FAILED: ${error.stack}`);
  process.exitCode = 1;
}
