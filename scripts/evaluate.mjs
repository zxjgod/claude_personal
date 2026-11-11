import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { resolveProviderConfig } from "../dist/llm-adapter.js";
import { query } from "../dist/sdk.js";
import { runEvaluation, writeEvaluation } from "./evaluation.mjs";

const suitePath = process.argv[2];
if (!suitePath)
  throw new Error(
    "Usage: npm run eval -- <suite.json> [--command=claude] [--model=name] [--repeat=2]",
  );
const flag = (name) =>
  process.argv
    .slice(3)
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
dotenv.config();
const suite = JSON.parse(readFileSync(resolve(suitePath), "utf8"));
const config = resolveProviderConfig({
  provider: process.env.LLM_PROVIDER ?? "openai",
  model: flag("model") ?? suite.model ?? process.env.LLM_MODEL,
  apiKey: process.env.LLM_API_KEY ?? "",
  baseURL: process.env.LLM_BASE_URL,
});
const report = await runEvaluation(suite, {
  suiteDirectory: dirname(resolve(suitePath)),
  repeat: Number(flag("repeat") ?? 1),
  cliExecutable: flag("command"),
  model: config.model,
  provider: config.provider,
  query,
  onCase: (result) =>
    console.error(
      JSON.stringify({
        case: result.name,
        attempt: result.attempt,
        passed: result.passed,
        duration_ms: result.duration_ms,
      }),
    ),
});
const output = writeEvaluation(report, resolve(".claude/evaluations"));
console.log(JSON.stringify({ output, passed: report.passed, total: report.total }));
if (report.passed !== report.total) process.exitCode = 1;
