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
  expect(report.cases[0].error).toMatch(/no result frame|budget exhausted/);
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
