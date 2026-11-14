import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { query } from "../sdk.js";

const { runEvaluation } = await import(pathToFileURL(path.resolve("scripts/evaluation.mjs")).href);
const suiteDirectory = path.resolve("examples");
const summary = (revised: boolean) => `import { normalizeSku } from "./sku.mjs";
export function summarizePaidOrders(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.status !== "paid") continue;
    const sku = normalizeSku(row.sku);
    const key = ${revised ? "sku.toLowerCase()" : "sku"};
    const group = groups.get(key);
    if (group) group.quantity += row.quantity;
    else groups.set(key, { sku, quantity: row.quantity });
  }
  return [...groups.values()];
}
`;
const bash = (stage: string) =>
  ["bash", { command: `node collaborate.mjs ${stage}`, description: stage }] as const;
const read = (file_path: string) => ["read", { file_path }] as const;
const write = (file_path: string, content: string) => ["write", { file_path, content }] as const;
const orderSource = "src/orders.mjs";
const paidRule = 'return order.status === "paid"';
const quantityRule = `${paidRule} && order.quantity > 0`;
const currencyRule = ' && order.currency === "CNY"';
const editRule = (oldRule: string, newRule: string) =>
  [
    "edit",
    { file_path: orderSource, old_string: `${oldRule};`, new_string: `${newRule};` },
  ] as const;
const conflictStage = (stage: string) =>
  ["bash", { command: `node conflict.mjs ${stage}`, description: stage }] as const;
const worker = (prompt: string) =>
  ["Agent", { prompt, subagent_type: "rule-worker", isolation: "worktree" }] as const;

it.each([
  ["resume", "resumes the reviewed worktree through a new CLI"],
  ["conflict", "merges overlapping changes from two concurrently running worktrees"],
])("%s: %s", async (mode) => {
  const suite = JSON.parse(
    fs.readFileSync(path.join(suiteDirectory, `collaboration-${mode}-suite.json`), "utf8"),
  );
  const task = suite.cases[0];
  const harness = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-collaboration-cli-"));
  const launchLog = path.join(harness, "launches.jsonl");
  const entry = path.join(harness, "cli.mjs");
  fs.writeFileSync(
    entry,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({
  pid: process.pid, resume: process.argv.includes("--resume"),
}) + "\\n");
await import(${JSON.stringify(pathToFileURL(path.resolve("src/cli.ts")).href)});
`,
  );
  let requestId = 0;
  let restoredReview = false;
  const workersAtBarrier = new Set<string>();
  let releaseWorkers!: () => void;
  const workersReady = new Promise<void>((resolve) => {
    releaseWorkers = resolve;
  });
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const messages: Array<{ role: string; content: unknown }> = JSON.parse(body).messages;
    let userIndex = messages.length - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex--;
    const user = JSON.stringify(messages[userIndex]?.content ?? "");
    const results = messages.slice(userIndex + 1).filter((message) => message.role === "tool");
    let actions: ReadonlyArray<readonly [string, object]> = [];
    let batch: typeof actions | undefined;
    let report = "fixture task completed";

    if (user.includes("QUANTITY_RULE") || user.includes("CURRENCY_RULE")) {
      const quantity = user.includes("QUANTITY_RULE");
      if (results.length === 0) {
        // Both worker loops must reach the provider before either can proceed.
        workersAtBarrier.add(quantity ? "quantity" : "currency");
        if (workersAtBarrier.size === 2) releaseWorkers();
        await workersReady;
      }
      actions = [
        read(orderSource),
        editRule(paidRule, quantity ? quantityRule : paidRule + currencyRule),
      ];
    } else if (user.includes("Integrate two changes from independent Agent worktrees")) {
      const steps = [
        [conflictStage("baseline")],
        [worker("QUANTITY_RULE"), worker("CURRENCY_RULE")],
        [], // The two simultaneous Agent results advance the count from 1 to 3.
        [conflictStage("apply-quantity")],
        [conflictStage("apply-currency")],
        [read(orderSource)],
        [editRule(quantityRule, quantityRule + currencyRule)],
        [conflictStage("test")],
      ];
      batch = steps[results.length];
    } else if (user.includes("WORKER_DRAFT")) {
      actions = [
        read("src/sku.mjs"),
        read("src/summary.mjs"),
        write("src/sku.mjs", "export const normalizeSku = sku => sku.trim();\n"),
        write("src/summary.mjs", summary(false)),
      ];
    } else if (user.includes("WORKER_REVIEW")) {
      actions = [read("src/summary.mjs"), write("src/summary.mjs", summary(true))];
    } else if (user.includes("Start the paid order summary task")) {
      actions = [
        bash("baseline"),
        ["Agent", { prompt: "WORKER_DRAFT", subagent_type: "order-worker", isolation: "worktree" }],
        bash("draft"),
      ];
    } else if (user.includes("Continue from the review already in this session")) {
      const history = messages.slice(0, userIndex).filter((message) => message.role === "tool");
      const original = history.map((message) => String(message.content)).join("\n");
      const agentId = original.match(/Agent id: (order-worker-[\w-]+)/)?.[1];
      restoredReview = Boolean(agentId && original.includes("COLLAB_REVIEW_REQUIRED"));
      actions = [
        [
          "Agent",
          {
            prompt: "WORKER_REVIEW: Match SKUs case-insensitively and keep the first spelling.",
            resume: agentId,
          },
        ],
        bash("revised"),
        bash("integrate"),
        bash("test"),
      ];
    } else if (user.includes("security classifier")) {
      report = "SAFE";
    }

    const action = actions[results.length];
    const requested = batch ?? (action ? [action] : []);
    const delta = requested.length
      ? {
          tool_calls: requested.map(([name, input], index) => ({
            index,
            id: `fixture-${++requestId}`,
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
          })),
        }
      : { content: report };
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `${[
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: requested.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`,
        "data: [DONE]",
      ].join("\n\n")}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await runEvaluation(
      { ...suite, cases: [{ ...task, timeoutMs: 50000 }] },
      {
        suiteDirectory,
        env: {
          LLM_PROVIDER: "custom",
          LLM_MODEL: "fixture",
          LLM_API_KEY: "fixture-unused",
          LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          CCR_AUTO_MEMORY_EXTRACT: "0",
        },
        query: (input: Parameters<typeof query>[0]) =>
          query({
            ...input,
            options: {
              ...input.options,
              cliModule: entry,
              env: {
                ...input.options?.env,
                NODE_OPTIONS: `--import=${pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href}`,
              },
            },
          }),
      },
    );
    expect(
      report.passed,
      `${JSON.stringify(report.cases[0].assertions)} ${report.cases[0].error}`,
    ).toBe(1);
    expect(report.cases[0].patch_replay_verified).toBe(true);
    const launches = fs
      .readFileSync(launchLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (mode === "resume") {
      expect(restoredReview).toBe(true);
      expect(launches.map(({ resume }) => resume)).toEqual([false, true]);
      expect(launches[0].pid).not.toBe(launches[1].pid);
    } else {
      expect(workersAtBarrier).toEqual(new Set(["quantity", "currency"]));
      expect(launches.map(({ resume }) => resume)).toEqual([false]);
    }
  } finally {
    releaseWorkers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(harness, { recursive: true, force: true });
  }
}, 60000);
