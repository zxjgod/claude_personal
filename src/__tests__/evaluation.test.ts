import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const runnerPath = pathToFileURL(path.resolve("scripts/evaluation.mjs")).href;
const { runEvaluation } = await import(runnerPath);
const suiteDirectory = path.resolve("examples");
const suite = JSON.parse(
  fs.readFileSync(path.join(suiteDirectory, "core-eval-suite.json"), "utf8"),
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const success = {
  type: "result",
  is_error: false,
  result: "done",
  usage: { input_tokens: 3, output_tokens: 2 },
};

it("captures staged moves, new files and root documentation in a replayable patch", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-eval-patch-"));
  roots.push(fixture);
  fs.mkdirSync(path.join(fixture, "workspace", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "workspace", "src", "legacy.mjs"),
    "export const value = 1;\n",
  );
  fs.writeFileSync(path.join(fixture, "workspace", "README.md"), "Old API\n");
  const report = await runEvaluation(
    {
      cases: [
        {
          name: "migrate",
          prompt: "move API",
          fixture: ".",
          assertions: [{ type: "fileContains", path: "src/new.mjs", text: "value" }],
        },
      ],
    },
    {
      suiteDirectory: fixture,
      query: async function* ({ options }: { options: { cwd: string } }) {
        execFileSync("git", ["mv", "src/legacy.mjs", "src/model.mjs"], {
          cwd: options.cwd,
          windowsHide: true,
        });
        fs.writeFileSync(
          path.join(options.cwd, "src/new.mjs"),
          "export { value } from './model.mjs';\n",
        );
        fs.writeFileSync(path.join(options.cwd, "README.md"), "New API: src/new.mjs\n");
        // Runtime material must not ride along with an authored candidate patch.
        fs.mkdirSync(path.join(options.cwd, ".claude"));
        fs.writeFileSync(path.join(options.cwd, ".claude", "runtime.json"), "private runtime");
        yield success;
      },
    },
  );
  expect(report.passed).toBe(1);
  const replay = path.join(fixture, "replay");
  fs.cpSync(path.join(fixture, "workspace"), replay, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--template=", replay], { windowsHide: true });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: replay, windowsHide: true });
  fs.writeFileSync(path.join(fixture, "candidate.patch"), report.cases[0].patch);
  execFileSync("git", ["apply", path.join(fixture, "candidate.patch")], {
    cwd: replay,
    windowsHide: true,
  });
  expect(fs.existsSync(path.join(replay, "src/legacy.mjs"))).toBe(false);
  expect(fs.readFileSync(path.join(replay, "src/model.mjs"), "utf8")).toBe(
    "export const value = 1;\n",
  );
  expect(fs.readFileSync(path.join(replay, "src/new.mjs"), "utf8")).toContain("'./model.mjs'");
  expect(fs.readFileSync(path.join(replay, "README.md"), "utf8")).toContain("New API");
  expect(fs.existsSync(path.join(replay, ".claude"))).toBe(false);
});

it.each([
  "complete",
  "claim-only",
  "pass-only",
  "changed-tests",
])("requires real failure, repair and passing evidence for coding-loop mode %s", async (mode) => {
  const loopSuite = JSON.parse(
    fs.readFileSync(path.join(suiteDirectory, "coding-loop-suite.json"), "utf8"),
  );
  const report = await runEvaluation(loopSuite, {
    suiteDirectory,
    query: async function* ({ options }: any) {
      expect(await options.canUseTool("bash", { command: "node check.mjs" })).toEqual({
        behavior: "allow",
      });
      expect(
        (await options.canUseTool("bash", { command: "node check.mjs && echo bypass" })).behavior,
      ).toBe("deny");
      expect(
        (await options.canUseTool("bash", { command: "node check.mjs", run_in_background: true }))
          .behavior,
      ).toBe("deny");
      const use = (id: string, name: string, input: unknown) => ({
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name, input }] },
      });
      const result = (id: string, content: string, is_error = false) => ({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
      });
      const run = () =>
        execFileSync(process.execPath, ["check.mjs"], {
          cwd: options.cwd,
          windowsHide: true,
          encoding: "utf8",
          stdio: "pipe",
        });
      if (mode !== "claim-only" && mode !== "pass-only") {
        yield use("first-test", "bash", { command: "node check.mjs" });
        try {
          run();
          throw new Error("broken fixture unexpectedly passed");
        } catch (failure) {
          const output = String((failure as { stderr?: string }).stderr);
          expect(output).toContain("CODING_LOOP_TESTS_FAILED");
          yield result("first-test", output, true);
        }
      }
      fs.writeFileSync(
        path.join(options.cwd, "src/unique.mjs"),
        "export const stableUnique = xs => [...new Set(xs)];",
      );
      fs.writeFileSync(
        path.join(options.cwd, "src/batches.mjs"),
        "import { stableUnique } from './unique.mjs'; export const uniqueBatches = xs => xs.map(stableUnique);",
      );
      if (mode !== "claim-only") {
        yield use("edit", "write", { filePath: "src/unique.mjs" });
        yield result("edit", "written");
        yield use("second-test", "bash", { command: "node check.mjs" });
        yield result("second-test", run());
      }
      if (mode === "changed-tests")
        fs.appendFileSync(path.join(options.cwd, "check.mjs"), "\n// changed\n");
      yield { ...success, result: "Tests passed" };
    },
  });
  expect(report.passed).toBe(mode === "complete" ? 1 : 0);
  expect(report.cases[0].patch).toContain("src/unique.mjs");
  expect(report.cases[0].tool_trace.length > 0).toBe(mode !== "claim-only");
});

it("rejects the unmodified repair fixtures with executable verifiers", async () => {
  const report = await runEvaluation(suite, {
    suiteDirectory,
    query: async function* () {
      yield { ...success, result: '{"file":"src/order.mjs","function":"normalizeLineItems"}' };
    },
  });
  expect(report.cases.map((entry: any) => entry.passed)).toEqual([true, false, false]);
  expect(report.cases[1].assertions[0].error).toContain("AssertionError");
});

it("copies clean fixtures for each repetition and keeps verifiers outside the model workspace", async () => {
  const workspaces: string[] = [];
  const report = await runEvaluation(
    { ...suite, cases: [suite.cases[1]] },
    {
      suiteDirectory,
      repeat: 2,
      model: "test-model",
      query: async function* ({ options }: any) {
        const cwd = options.cwd;
        workspaces.push(cwd);
        expect(fs.existsSync(path.join(cwd, ".git"))).toBe(true);
        expect(fs.existsSync(path.join(cwd, "verify.mjs"))).toBe(false);
        expect(fs.readFileSync(path.join(cwd, "src/unique.mjs"), "utf8")).toContain(".sort()");
        expect(options.model).toBe("test-model");
        expect(options.maxTurns).toBe(10);
        expect(options.env.LLM_MAX_TOKENS).toBe("2048");
        fs.writeFileSync(
          path.join(cwd, "src/unique.mjs"),
          "export const stableUnique = xs => [...new Set(xs)];",
        );
        yield success;
      },
    },
  );
  expect(report.passed).toBe(2);
  expect(report.cases[0].input_hash).toBe(report.cases[1].input_hash);
  expect(report.cases[0].cost_usd).toBeNull();
  expect(new Set(workspaces).size).toBe(2);
  expect(workspaces.every((cwd) => !fs.existsSync(cwd))).toBe(true);
});

it.each([
  { messages: [] },
  { messages: [{ ...success, is_error: true, errors: ["budget exhausted"] }] },
  {
    messages: [
      success,
      {
        type: "system",
        subtype: "abnormal_exit",
        is_error: true,
        message: "CLI abnormal exit after result",
      },
    ],
  },
])("does not count missing or failed terminal frames as success", async ({ messages }) => {
  const report = await runEvaluation(
    {
      cases: [{ name: "failure", prompt: "go", assertions: [{ type: "contains", text: "done" }] }],
    },
    {
      suiteDirectory,
      query: async function* () {
        yield* messages;
      },
    },
  );
  expect(report.passed).toBe(0);
  expect(report.cases[0].error).toMatch(/no result frame|budget exhausted|abnormal exit/);
  expect(report.cases[0].cost_usd).toBeNull();
});

it("keeps usage metadata and removes the workspace after a query failure", async () => {
  let workspace = "";
  const report = await runEvaluation(
    { ...suite, cases: [suite.cases[1]] },
    {
      suiteDirectory,
      query: async function* ({ options }: any) {
        workspace = options.cwd;
        yield success;
        throw new Error("transport closed");
      },
    },
  );
  expect(report.passed).toBe(0);
  expect(report.cases[0].usage).toEqual(success.usage);
  expect(fs.existsSync(workspace)).toBe(false);
});

it("continues after the first query closes and replays its patch over the same unstaged edits", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-eval-dirty-baseline-"));
  roots.push(fixture);
  const workspace = path.join(fixture, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "notes.md"), "committed note\n");
  fs.writeFileSync(path.join(workspace, "main.mjs"), "export const answer = 0;\n");
  fs.writeFileSync(
    path.join(fixture, "verify.mjs"),
    `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [root, answerPath, phase] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git('show', 'HEAD:notes.md'), 'committed note');
assert.equal(git('diff', '--cached', '--name-only'), '');
assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'user draft\\n');
assert.equal(readFileSync(join(root, 'main.mjs'), 'utf8'), 'export const answer = 42;\\n');
assert.equal(phase, root.endsWith('replay') ? 'patch-replay' : 'workspace');
const answer = JSON.parse(readFileSync(answerPath, 'utf8'));
assert.deepEqual(answer.evaluation_queries.map(query => [query.session_id, query.trace_start, query.trace_end]), [
  ['fixture-session', 0, 1], ['fixture-session', 1, 2],
]);
`,
  );
  let firstClosed = false;
  let firstSignal: AbortSignal | undefined;
  const report = await runEvaluation(
    {
      patchReplay: true,
      maxBudgetUsd: 1,
      cases: [
        {
          name: "dirty baseline",
          prompt: "Review the original",
          resumePrompt: "Change main only",
          fixture: ".",
          initialEdits: [{ path: "notes.md", content: "user draft\n" }],
          assertions: [{ type: "verifier", path: "verify.mjs" }],
        },
      ],
    },
    {
      suiteDirectory: fixture,
      query: async function* ({
        prompt,
        options,
      }: {
        prompt: string;
        options: { cwd: string; resume?: string; signal: AbortSignal; maxBudgetUsd?: number };
      }) {
        if (prompt === "Review the original") {
          expect(options.resume).toBeUndefined();
          expect(options.maxBudgetUsd).toBe(1);
          firstSignal = options.signal;
        } else {
          expect(firstClosed).toBe(true);
          expect(options.resume).toBe("fixture-session");
          expect(options.signal).toBe(firstSignal);
          expect(options.maxBudgetUsd).toBe(0.75);
          fs.writeFileSync(path.join(options.cwd, "main.mjs"), "export const answer = 42;\n");
        }
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: prompt }] } };
        yield { ...success, session_id: "fixture-session", total_cost_usd: 0.25 };
        firstClosed = true;
      },
    },
  );
  expect(report.cases[0].assertions).toEqual([
    { type: "verifier", passed: true, patch_replay_passed: true },
  ]);
  expect(report.cases[0].patch).toContain("diff --git a/main.mjs b/main.mjs");
  expect(report.cases[0].patch).not.toContain("notes.md");
  expect(report.cases[0].cost_usd).toBe(0.5);
});

it("does not continue after a result followed by an abnormal process exit", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-eval-abnormal-resume-"));
  roots.push(fixture);
  fs.mkdirSync(path.join(fixture, "workspace"));
  let queryCount = 0;
  const report = await runEvaluation(
    {
      cases: [
        {
          name: "abnormal first query",
          prompt: "Review",
          resumePrompt: "Continue",
          fixture: ".",
          assertions: [{ type: "contains", text: "done" }],
        },
      ],
    },
    {
      suiteDirectory: fixture,
      query: async function* () {
        queryCount++;
        yield { ...success, session_id: "fixture-session" };
        yield { type: "system", subtype: "abnormal_exit", message: "first CLI exited with code 1" };
      },
    },
  );
  expect(queryCount).toBe(1);
  expect(report.cases[0].passed).toBe(false);
  expect(report.cases[0].error).toContain("first CLI exited with code 1");
});

it("rejects vacuous suites and unsupported assertions before starting a model", async () => {
  const query = () => {
    throw new Error("must not run");
  };
  await expect(runEvaluation({ cases: [] }, { suiteDirectory, query })).rejects.toThrow(
    "non-empty cases",
  );
  await expect(
    runEvaluation(
      { cases: [{ name: "empty", prompt: "go", assertions: [] }] },
      { suiteDirectory, query },
    ),
  ).rejects.toThrow("non-empty assertions");
  await expect(
    runEvaluation(
      { cases: [{ name: "typo", prompt: "go", assertions: [{ type: "typo" }] }] },
      { suiteDirectory, query },
    ),
  ).rejects.toThrow("Unsupported assertion");
  await expect(
    runEvaluation({ ...suite, toolchain: "unknown" }, { suiteDirectory, query }),
  ).rejects.toThrow("Unsupported evaluation toolchain");
  await expect(
    runEvaluation(
      {
        cases: [
          {
            name: "invalid replay",
            prompt: "go",
            patchReplay: true,
            assertions: [{ type: "contains", text: "done" }],
          },
        ],
      },
      { suiteDirectory, query },
    ),
  ).rejects.toThrow("patchReplay requires");
});

it("bounds verifier execution and refuses assertion paths outside the workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-eval-runner-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(path.join(root, "hang.mjs"), "while (true) {}");
  const report = await runEvaluation(
    {
      cases: [
        {
          name: "bounded",
          prompt: "go",
          fixture: ".",
          assertions: [
            { type: "verifier", path: "hang.mjs", timeoutMs: 100 },
            { type: "fileContains", path: "../outside.txt", text: "anything" },
          ],
        },
      ],
    },
    {
      suiteDirectory: root,
      query: async function* () {
        yield success;
      },
    },
  );
  expect(report.passed).toBe(0);
  expect(report.cases[0].assertions[0].error).toMatch(/ETIMEDOUT/);
  expect(report.cases[0].assertions[1].error).toContain("Path escapes workspace");
});

it("the cross-file verifier accepts a correct integer-cent implementation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-eval-money-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src/money.mjs"),
    `
export function parseMoney(value) {
  if (typeof value !== "string" || !/^\\d+(?:\\.\\d{1,2})?$/.test(value.trim())) throw Error("invalid");
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw Error("unsafe");
  return cents;
}
export function formatMoney(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw Error("invalid");
  return Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
}`,
  );
  fs.writeFileSync(
    path.join(root, "src/invoice.mjs"),
    `
import { parseMoney, formatMoney } from "./money.mjs";
export const invoiceTotal = items => formatMoney(items.reduce((n, item) => n + parseMoney(item.price), 0));`,
  );
  expect(() =>
    execFileSync(
      process.execPath,
      [path.join(suiteDirectory, "eval-fixtures/cross-file/verify.mjs"), root],
      { windowsHide: true },
    ),
  ).not.toThrow();
});
