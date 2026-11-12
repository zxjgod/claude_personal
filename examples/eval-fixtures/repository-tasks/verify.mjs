import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verify(migration) {
  const [root, answerPath] = process.argv.slice(2);
  for (const file of ["build.mjs", "test.mjs", "tsconfig.json", "package.json", ".gitignore"])
    assert.equal(readFileSync(join(root, file), "utf8"), readFileSync(new URL(`workspace/${file}`, import.meta.url), "utf8"), `protected input changed: ${file}`);
  const compiler = process.env.CCR_EVAL_TSC;
  assert(compiler, "independent verifier needs the recorded TypeScript toolchain");
  const run = (args, cwd = root) => {
    try { return execFileSync(process.execPath, args, { cwd, windowsHide: true, timeout: 10000, encoding: "utf8", stdio: "pipe" }); }
    catch (error) { throw new Error(`Independent command failed: ${String(error.stdout)}\n${String(error.stderr)}`); }
  };
  assert(run(["build.mjs"]).includes("REPOSITORY_BUILD_PASSED"));
  const { TaskCatalog, parseTaskLines, readyTitles } = await import(pathToFileURL(join(root, "dist/index.js")));
  const record = (id, priority = 1, status = "todo") => ({ id, title: `Title ${id}`, priority, status });
  const rows = [record("lo", 0), record("hi-a", 2), record("hi-b", 2), record("mid", 1, "done")];
  const frozen = Object.freeze(rows.map((task) => Object.freeze({ ...task })));
  const catalog = new TaskCatalog(frozen);
  assert.deepEqual(catalog.list().map((task) => task.id), ["hi-a", "hi-b", "mid", "lo"]);
  assert.deepEqual(catalog.list("todo").map((task) => task.id), ["hi-a", "hi-b", "lo"]);
  catalog.list()[0].id = "outside";
  assert.equal(catalog.list()[0].id, "hi-a");
  assert.equal(catalog.complete("hi-b"), true);
  assert.equal(catalog.complete("hi-b"), false);
  assert.equal(catalog.complete("missing"), false);
  assert.equal(frozen[2].status, "todo");
  assert.deepEqual(catalog.list("todo").map((task) => task.id), ["hi-a", "lo"]);
  const mutable = [record("original")];
  const copied = new TaskCatalog(mutable);
  mutable[0].title = "changed after construction";
  mutable.push(record("late"));
  assert.deepEqual(copied.list(), [record("original")]);
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  assert.equal(readyTitles(text), "Title hi-a, Title hi-b, Title lo");
  assert.deepEqual(parseTaskLines("\n \n\t"), []);
  assert.deepEqual(parseTaskLines(JSON.stringify({ ...record(" x "), title: "  Example  ", extra: true })), [{ id: "x", title: "Example", priority: 1, status: "todo" }]);
  for (const invalid of [null, [], true, 1, "task", {}, { ...record("x"), id: " " }, { ...record("x"), title: 2 }, { ...record("x"), priority: 1.5 }, { ...record("x"), priority: "1" }, { ...record("x"), status: "pending" }])
    assert.throws(() => parseTaskLines(`\n\n${JSON.stringify(invalid)}`), /line 3/i);
  assert.throws(() => parseTaskLines("\n{broken"), /line 2/i);
  assert.throws(() => parseTaskLines(`${JSON.stringify(record("same"))}\n\n\n${JSON.stringify(record(" same "))}`), /line 4/i);
  if (migration) {
    assert(!existsSync(join(root, "src/legacy.ts")), "old source module must be retired");
    assert(existsSync(join(root, "src/task-model.ts")) && existsSync(join(root, "src/priority.ts")));
    const model = readFileSync(join(root, "src/task-model.ts"), "utf8");
    assert(model.includes("./priority.js") && model.includes("compareTasks"), "model must use the extracted comparator");
    for (const file of ["src/index.ts", "src/commands.ts", "src/task-model.ts", "src/priority.ts"])
      assert(!readFileSync(join(root, file), "utf8").includes("./legacy.js"), `stale import in ${file}`);
    const { compareTasks } = await import(pathToFileURL(join(root, "dist/priority.js")));
    assert(compareTasks(Object.freeze(record("a", 2)), Object.freeze(record("b", 0))) < 0);
    assert.equal(compareTasks(record("a", 1), record("b", 1)), 0);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const term of ["src/task-model.ts", "src/priority.ts", "parseTaskLines"]) assert(readme.includes(term));
  }
  const probe = mkdtempSync(join(tmpdir(), "ccr-type-probe-"));
  try {
    const api = join(root, "dist/index.js").replaceAll("\\", "/");
    writeFileSync(join(probe, "consumer.mts"), `import {TaskCatalog,parseTaskLines,type Task} from ${JSON.stringify(api)};
const task:Task={id:'x',title:'X',priority:1,status:'todo'};
const priority:0|1|2=task.priority;
const status:'todo'|'done'=task.status;
const tasks:Task[]=parseTaskLines('');
const changed:boolean=new TaskCatalog(tasks).complete('x');
void [priority,status,changed];
// @ts-expect-error priority must stay a closed union
const badPriority:Task={id:'x',title:'X',priority:3,status:'todo'};
// @ts-expect-error status must stay a closed union
const badStatus:Task={id:'x',title:'X',priority:1,status:'later'};
void [badPriority,badStatus];`);
    writeFileSync(join(probe, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: [] }, files: ["consumer.mts"] }));
    run([compiler, "--project", join(probe, "tsconfig.json")], probe);
  } finally { rmSync(probe, { recursive: true, force: true }); }
  const trace = JSON.parse(readFileSync(answerPath, "utf8")).evaluation_trace;
  const calls = new Map();
  let failed = -1, firstChange = -1, changed = -1, built = -1, tested = -1, moved = -1;
  const isChange = (call) => {
    if (["bash", "powershell"].includes(call.name.toLowerCase())) return call.input.command.startsWith("git mv ");
    const file = call.input.file_path ?? call.input.filePath ?? call.input.path;
    return ["write", "edit", "multiedit"].includes(call.name.toLowerCase()) && typeof file === "string" && (file.replaceAll("\\", "/").includes("/src/") || relative(root, resolve(root, file)).replaceAll("\\", "/").startsWith("src/"));
  };
  for (const [index, event] of trace.entries()) {
    if (event.type === "tool_use") {
      calls.set(event.id, event);
      if (isChange(event) && firstChange < 0) firstChange = index;
    }
    if (event.type !== "tool_result") continue;
    const call = calls.get(event.tool_use_id);
    if (!call) continue;
    const output = typeof event.content === "string" ? event.content : JSON.stringify(event.content);
    if (!event.is_error && isChange(call)) changed = index;
    if (["bash", "powershell"].includes(call.name.toLowerCase())) {
      if (call.input.command === "node build.mjs" && event.is_error && output.includes("REPOSITORY_BUILD_FAILED") && failed < 0) failed = index;
      if (call.input.command === "node build.mjs" && !event.is_error && output.includes("REPOSITORY_BUILD_PASSED")) built = index;
      if (call.input.command === "node test.mjs" && !event.is_error && output.includes("REPOSITORY_TESTS_PASSED")) tested = index;
      if (call.input.command.startsWith("git mv ") && !event.is_error) moved = index;
    }
  }
  assert(failed >= 0 && firstChange > failed && changed > failed && built > changed && tested > built, "requires compiler failure -> source changes -> passing build -> passing tests evidence");
  if (migration) assert(moved > failed && moved < built, "requires an executed source move");
}
