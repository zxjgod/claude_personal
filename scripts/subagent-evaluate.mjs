import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import dotenv from "dotenv";
import { resolveProviderConfig } from "../src/llm-adapter.ts";
import { registerSubagentType, setCoreToolsForSubagents } from "../src/subagents.ts";
import { ReadTool } from "../src/tools/core/read.ts";
import { WriteTool } from "../src/tools/core/write.ts";
import { AgentTool } from "../src/tools/extended/agent.ts";
import { writeEvaluation } from "./evaluation.mjs";

dotenv.config();
const repeat = Number(process.argv[2] ?? 2);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("repeat must be a positive integer");
const config = resolveProviderConfig({
  provider: process.env.LLM_PROVIDER ?? "openai",
  apiKey: process.env.LLM_API_KEY ?? "",
  model: process.env.LLM_MODEL,
  baseURL: process.env.LLM_BASE_URL,
  maxTokens: 2048,
});
registerSubagentType({
  name: "handoff-worker",
  description: "Repair an isolated fixture",
  systemPrompt:
    "Repair the requested source files in your active worktree. Preserve tests. Report changed files and unchecked scope. You have file tools only, so do not claim you ran tests.",
  toolNames: ["read", "write"],
  maxTurns: 8,
  omitClaudeMd: true,
});
setCoreToolsForSubagents([ReadTool, WriteTool]);
const task =
  "Fix src/unique.mjs and src/batches.mjs. stableUnique must deduplicate using SameValueZero equality while preserving first occurrence order without mutating input. uniqueBatches must preserve each batch's order. Read the source before overwriting. Do not change check.mjs or create extra files. Finish the implementation and give a self-contained report with paths. You cannot run shell tests; the parent will verify independently.";
const cases = [];
for (let attempt = 1; attempt <= repeat; attempt++) {
  const root = mkdtempSync(join(tmpdir(), "ccr-subagent-eval-"));
  const started = Date.now();
  let error, result, patch, inputHash;
  const progress = [];
  try {
    cpSync(resolve("examples/eval-fixtures/coding-loop/workspace"), root, { recursive: true });
    const files = ["src/unique.mjs", "src/batches.mjs", "check.mjs"];
    const baseline = files.map((file) => readFileSync(join(root, file), "utf8"));
    inputHash = createHash("sha256")
      .update(JSON.stringify({ task, baseline, maxTurns: 8, maxTokens: 2048, timeoutMs: 180000 }))
      .digest("hex");
    const git = (args, cwd = root) =>
      execFileSync("git", args, {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        timeout: 15000,
        stdio: "pipe",
      });
    git(["init", "--quiet", "--template="]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.hooksPath", join(root, ".git", "no-hooks")]);
    git(["add", "--", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture baseline",
    ]);
    result = await AgentTool.call(
      { prompt: task, subagent_type: "handoff-worker", isolation: "worktree" },
      {
        workspaceRoot: root,
        sessionId: `handoff-${process.pid}-${attempt}`,
        permissionMode: "acceptEdits",
        modelConfig: config,
        abortSignal: AbortSignal.timeout(180000),
        onSubAgentProgress: (event) => progress.push(event),
      },
    );
    if (result.metadata?.worktreePath) {
      const worktree = resolve(result.metadata.worktreePath);
      assert(worktree.startsWith(resolve(root, ".claude", "worktrees") + sep));
      patch = git(["diff", "--no-ext-diff", "--no-textconv", "--", "src"], worktree);
    }
    assert.equal(result.error, undefined);
    assert.equal(result.metadata?.incomplete, undefined);
    assert.equal(result.metadata?.worktreeRetained, true);
    const worktree = resolve(result.metadata.worktreePath);
    assert(result.metadata.worktreeBranch.startsWith("codex/"));
    for (const [index, file] of files.entries())
      assert.equal(
        readFileSync(join(root, file), "utf8"),
        baseline[index],
        "primary checkout must stay unchanged",
      );
    assert.equal(readFileSync(join(worktree, "check.mjs"), "utf8"), baseline[2]);
    assert(patch.includes("src/unique.mjs") && patch.includes("src/batches.mjs"));
    execFileSync(process.execPath, ["check.mjs"], {
      cwd: worktree,
      env: {},
      timeout: 5000,
      windowsHide: true,
      stdio: "pipe",
    });
    execFileSync(
      process.execPath,
      [resolve("examples/eval-fixtures/single-file/verify.mjs"), worktree],
      { cwd: worktree, env: {}, timeout: 5000, windowsHide: true, stdio: "pipe" },
    );
  } catch (failure) {
    error = String(failure);
  }
  cases.push({
    name: "worktree-handoff",
    attempt,
    input_hash: inputHash,
    passed: !error,
    ...(error && { error }),
    duration_ms: Date.now() - started,
    cost_usd: null,
    usage: null,
    result,
    progress,
    patch,
  });
  // This entire repository, including nested worktrees, was allocated above.
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
  console.error(JSON.stringify({ attempt, passed: !error, duration_ms: Date.now() - started }));
}
const report = {
  date: new Date().toISOString(),
  suite_version: "subagent-handoff-v1",
  model: config.model,
  provider: config.provider,
  repeat,
  cases,
  passed: cases.filter((entry) => entry.passed).length,
  total: cases.length,
};
const output = writeEvaluation(report, resolve(".claude/evaluations"));
console.log(JSON.stringify({ output, passed: report.passed, total: report.total }));
if (report.passed !== report.total) process.exitCode = 1;
