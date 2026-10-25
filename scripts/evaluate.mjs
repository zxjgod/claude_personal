import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { query } from "../dist/sdk.js";

const suitePath = process.argv[2];
if (!suitePath) throw new Error("Usage: npm run eval -- <suite.json> [--command=claude]");
const suite = JSON.parse(readFileSync(resolve(suitePath), "utf8"));
const cliExecutable = process.argv.find((argument) => argument.startsWith("--command="))?.slice(10);
if (!Array.isArray(suite.cases))
  throw new Error("Suite requires cases[] with prompt and assertions");
const results = [];
for (const entry of suite.cases) {
  if (typeof entry.prompt !== "string") throw new Error("Case requires prompt");
  const started = Date.now();
  let final;
  try {
    for await (const message of query({
      prompt: entry.prompt,
      options: {
        cwd: resolve(entry.cwd ?? "."),
        maxTurns: entry.maxTurns ?? 8,
        allowedTools: entry.allowedTools ?? ["Read", "Glob", "Grep"],
        disallowedTools: entry.disallowedTools ?? ["Write", "Edit", "Bash", "PowerShell"],
        signal: AbortSignal.timeout(entry.timeoutMs ?? 120000),
        cliExecutable,
      },
    }))
      if (message.type === "result") final = message;
    const assertions = (entry.assertions ?? []).map((assertion) => {
      if (assertion.type === "contains")
        return String(final?.result ?? "").includes(assertion.text);
      if (assertion.type === "fileContains")
        return readFileSync(resolve(entry.cwd ?? ".", assertion.path), "utf8").includes(
          assertion.text,
        );
      throw new Error(`Unsupported assertion: ${assertion.type}`);
    });
    results.push({
      name: entry.name,
      // Review fix ("无结果帧被记为通过"): `!final?.is_error` is true when NO
      // result frame ever arrived — a run that died silently used to count
      // as a pass. Require a final frame AND clean assertions.
      passed: Boolean(final) && !final.is_error && assertions.every(Boolean),
      ...(final ? {} : { error: "no result frame — the CLI exited without reporting" }),
      assertions,
      duration_ms: Date.now() - started,
      usage: final?.usage,
      cost_usd: final?.total_cost_usd,
    });
  } catch (error) {
    results.push({
      name: entry.name,
      passed: false,
      error: String(error),
      duration_ms: Date.now() - started,
    });
  }
}
const report = {
  date: new Date().toISOString(),
  model: process.env.LLM_MODEL ?? "configured model",
  cases: results,
  passed: results.filter((result) => result.passed).length,
  total: results.length,
};
mkdirSync(resolve(".claude/evaluations"), { recursive: true });
const output = join(resolve(".claude/evaluations"), `${Date.now()}.json`);
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, passed: report.passed, total: report.total }));
if (report.passed !== report.total) process.exitCode = 1;
