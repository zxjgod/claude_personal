import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
const authoredPaths = [".", ":(exclude).claude"];

function inside(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
    throw new Error(`Path escapes workspace: ${path}`);
  return target;
}

function fingerprint(directory, hash) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    hash.update(JSON.stringify([entry.name, entry.isDirectory() ? "directory" : "file"]));
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Fixture symlink: ${path}`);
    if (entry.isDirectory()) fingerprint(path, hash);
    else hash.update(createHash("sha256").update(readFileSync(path)).digest());
  }
}

function initializeGit(cwd) {
  execFileSync("git", ["init", "--quiet", "--template=", cwd], { windowsHide: true });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd, windowsHide: true });
}

function prepareFixture(fixture, cwd, initialEdits) {
  cpSync(join(fixture, "workspace"), cwd, { recursive: true });
  initializeGit(cwd);
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    }).trim();
  git(["add", "--", "."]);
  if (initialEdits.length) {
    git([
      "-c",
      "user.name=Evaluation Fixture",
      "-c",
      "user.email=fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${join(cwd, ".git", "no-hooks")}`,
      "commit",
      "--quiet",
      "-m",
      "Fixture baseline",
    ]);
    for (const { path, content } of initialEdits) {
      const file = inside(cwd, path);
      if (!statSync(file).isFile() || !git(["ls-files", "--", path]))
        throw new Error(`Initial edit must target a tracked fixture file: ${path}`);
      writeFileSync(file, content);
    }
    git(["add", "--", "."]);
  }
  const initialTree = git(["write-tree"]);
  if (initialEdits.length) git(["restore", "--staged", "--", "."]);
  return initialTree;
}

function capturePatch(cwd, initialTree) {
  const added = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...authoredPaths],
    {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
    },
  )
    .split("\0")
    .filter(Boolean);
  for (let offset = 0; offset < added.length; offset += 50)
    execFileSync("git", ["add", "--intent-to-add", "--", ...added.slice(offset, offset + 50)], {
      cwd,
      windowsHide: true,
      timeout: 5000,
    });
  return execFileSync(
    "git",
    [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      initialTree,
      "--",
      ...authoredPaths,
    ],
    {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

/** Every fixture attempt gets a fresh workspace; verifiers stay outside it. */
export async function runEvaluation(suite, options) {
  if (!Array.isArray(suite.cases) || suite.cases.length === 0)
    throw new Error("Suite requires non-empty cases[]");
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("repeat must be a positive integer");
  const prepared = suite.cases.map((entry) => {
    if (typeof entry.name !== "string" || typeof entry.prompt !== "string")
      throw new Error("Case requires name and prompt");
    if (
      entry.resumePrompt !== undefined &&
      (typeof entry.resumePrompt !== "string" || !entry.resumePrompt.trim() || !entry.fixture)
    )
      throw new Error("resumePrompt requires a non-empty continuation and an isolated fixture");
    if (!Array.isArray(entry.assertions) || entry.assertions.length === 0)
      throw new Error(`Case ${entry.name} requires non-empty assertions`);
    const fixture = entry.fixture ? resolve(options.suiteDirectory, entry.fixture) : undefined;
    for (const assertion of entry.assertions) {
      if (!["contains", "fileContains", "verifier"].includes(assertion.type))
        throw new Error(`Unsupported assertion: ${assertion.type}`);
      if (assertion.type === "verifier" && !fixture)
        throw new Error("Executable verifiers require an isolated fixture");
    }
    const limits = {
      maxTurns: entry.maxTurns ?? suite.maxTurns ?? 8,
      timeoutMs: entry.timeoutMs ?? suite.timeoutMs ?? 120000,
      maxOutputTokens: entry.maxOutputTokens ?? suite.maxOutputTokens ?? 4096,
      maxBudgetUsd: entry.maxBudgetUsd ?? suite.maxBudgetUsd,
    };
    for (const [key, value] of Object.entries(limits))
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new Error(`${key} must be positive`);
    for (const key of ["maxTurns", "timeoutMs", "maxOutputTokens"])
      if (!Number.isInteger(limits[key])) throw new Error(`${key} must be an integer`);
    const tools = {
      allowedTools: entry.allowedTools ?? suite.allowedTools ?? ["Read", "Glob", "Grep"],
      disallowedTools: entry.disallowedTools ??
        suite.disallowedTools ?? ["Write", "Edit", "Bash", "PowerShell"],
    };
    const shellCommands = entry.shellCommands ?? [];
    if (
      !Array.isArray(shellCommands) ||
      shellCommands.some((command) => typeof command !== "string" || !command.trim())
    )
      throw new Error("shellCommands must contain non-empty command strings");
    if (shellCommands.length && !fixture)
      throw new Error("shellCommands requires an isolated fixture");
    const initialEdits = entry.initialEdits ?? [];
    if (
      !Array.isArray(initialEdits) ||
      initialEdits.some(
        (edit) =>
          typeof edit?.path !== "string" ||
          !/^[\w.-]+(?:\/[\w.-]+)*$/.test(edit.path) ||
          edit.path
            .split("/")
            .some((part) => [".", "..", ".git", ".claude"].includes(part.toLowerCase())) ||
          typeof edit.content !== "string",
      )
    )
      throw new Error("initialEdits must list fixture-relative file paths and text content");
    if (initialEdits.length && !fixture)
      throw new Error("initialEdits requires an isolated fixture");
    const patchReplay = entry.patchReplay ?? suite.patchReplay ?? false;
    if (typeof patchReplay !== "boolean") throw new Error("patchReplay must be a boolean");
    if (
      patchReplay &&
      (!fixture || !entry.assertions.some((assertion) => assertion.type === "verifier"))
    )
      throw new Error("patchReplay requires an isolated fixture and executable verifier");
    const requestedToolchain = entry.toolchain ?? suite.toolchain;
    if (requestedToolchain !== undefined && requestedToolchain !== "typescript")
      throw new Error(`Unsupported evaluation toolchain: ${requestedToolchain}`);
    let toolchain;
    let toolchainEnv = {};
    if (requestedToolchain) {
      if (!fixture) throw new Error("Evaluation toolchains require an isolated fixture");
      const compiler = require.resolve("typescript/lib/tsc.js");
      const hash = createHash("sha256");
      fingerprint(dirname(compiler), hash);
      toolchain = {
        name: "typescript",
        version: JSON.parse(readFileSync(require.resolve("typescript/package.json"), "utf8"))
          .version,
        library_hash: hash.digest("hex"),
      };
      toolchainEnv = { CCR_EVAL_TSC: compiler };
    }
    const hash = createHash("sha256").update(
      JSON.stringify({
        entry,
        limits,
        tools,
        shellCommands,
        shellApproval: shellCommands.length ? "all-shell-ask-v1" : undefined,
        toolchain,
        patchReplay,
        version: suite.version,
      }),
    );
    if (fixture) fingerprint(fixture, hash);
    return {
      entry,
      fixture,
      limits,
      tools,
      shellCommands,
      initialEdits,
      toolchain,
      toolchainEnv,
      patchReplay,
      inputHash: hash.digest("hex"),
    };
  });
  const results = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const {
      entry,
      fixture,
      limits,
      tools,
      shellCommands,
      initialEdits,
      toolchain,
      toolchainEnv,
      patchReplay,
      inputHash,
    } of prepared) {
      const started = Date.now();
      const temporary = fixture ? mkdtempSync(join(tmpdir(), "ccr-eval-")) : undefined;
      const cwd = temporary ? join(temporary, "workspace") : resolve(entry.cwd ?? ".");
      let final;
      let error;
      let patch;
      let initialTree;
      const trace = [];
      const queries = [];
      const assertions = [];
      try {
        if (fixture) {
          initialTree = prepareFixture(fixture, cwd, initialEdits);
          if (shellCommands.length) {
            const user = join(temporary, "user");
            mkdirSync(user, { recursive: true });
            writeFileSync(
              join(user, "settings.json"),
              JSON.stringify({ permissions: { ask: ["Bash", "PowerShell"] } }),
            );
          }
        }
        const signal = AbortSignal.timeout(limits.timeoutMs);
        const prompts = entry.resumePrompt ? [entry.prompt, entry.resumePrompt] : [entry.prompt];
        let remainingBudget = limits.maxBudgetUsd;
        for (const prompt of prompts) {
          const resume = queries.at(-1)?.session_id;
          const traceStart = trace.length;
          let processFailure;
          final = undefined;
          for await (const message of options.query({
            prompt,
            options: {
              ...(resume && { resume }),
              cwd,
              env: {
                ...options.env,
                ...toolchainEnv,
                WORKSPACE_ROOT: cwd,
                LLM_MAX_TOKENS: String(limits.maxOutputTokens),
                PERMISSION_MODE: "default",
                ...(temporary && {
                  CCR_USER_CONFIG_DIR: join(temporary, "user"),
                  CCR_CONFIG_TRUST_STORE: join(temporary, "trust.json"),
                }),
              },
              model: options.model,
              maxTurns: limits.maxTurns,
              maxBudgetUsd: remainingBudget,
              ...tools,
              ...(shellCommands.length && {
                canUseTool: async (name, input) =>
                  ["bash", "powershell"].includes(name.toLowerCase()) &&
                  shellCommands.includes(input.command) &&
                  !input.run_in_background
                    ? { behavior: "allow" }
                    : {
                        behavior: "deny",
                        message: "Command is outside this evaluation's fixed command list",
                      },
              }),
              signal,
              cliExecutable: options.cliExecutable,
            },
          })) {
            if (["assistant", "user"].includes(message.type)) {
              const content = message.message?.content;
              for (const block of Array.isArray(content) ? content : []) {
                if (block.type === "tool_use" || block.type === "tool_result") trace.push(block);
              }
            }
            if (message.type === "result") final = message;
            if (message.type === "system" && message.subtype === "abnormal_exit")
              processFailure = String(message.message ?? "CLI abnormal exit after result");
          }
          if (processFailure) throw new Error(processFailure);
          if (!final) throw new Error("no result frame — the CLI exited without reporting");
          if (final.is_error) throw new Error(final.errors?.join("; ") || "CLI reported failure");
          if (entry.resumePrompt) {
            if (
              typeof final.session_id !== "string" ||
              !final.session_id ||
              (resume && final.session_id !== resume)
            )
              throw new Error("The CLI did not report the expected session id for continuation");
            queries.push({
              session_id: final.session_id,
              trace_start: traceStart,
              trace_end: trace.length,
              usage: final.usage ?? null,
              cost_usd: final.total_cost_usd ?? null,
            });
            if (!resume && remainingBudget !== undefined) {
              if (!Number.isFinite(final.total_cost_usd) || final.total_cost_usd < 0)
                throw new Error(
                  "Cannot continue a budgeted evaluation without the first query cost",
                );
              remainingBudget -= final.total_cost_usd;
              if (remainingBudget <= 0)
                throw new Error("Evaluation budget exhausted before continuation");
            }
          }
        }
        if (fixture) patch = capturePatch(cwd, initialTree);
        let replay;
        if (patchReplay) {
          replay = join(temporary, "replay");
          if (initialEdits.length) prepareFixture(fixture, replay, initialEdits);
          else {
            cpSync(join(fixture, "workspace"), replay, { recursive: true });
            initializeGit(replay);
          }
          const candidate = join(temporary, "candidate.patch");
          writeFileSync(candidate, patch);
          if (patch.trim())
            execFileSync("git", ["apply", "--binary", candidate], {
              cwd: replay,
              windowsHide: true,
              timeout: 5000,
            });
        }
        for (const assertion of entry.assertions) {
          let workspacePassed = false;
          let replayStarted = false;
          try {
            let passed;
            if (assertion.type === "contains")
              passed = String(final.result ?? "").includes(assertion.text);
            else if (assertion.type === "fileContains")
              passed = readFileSync(inside(cwd, assertion.path), "utf8").includes(assertion.text);
            else {
              const answer = join(temporary, "answer.json");
              writeFileSync(
                answer,
                JSON.stringify({
                  ...final,
                  evaluation_trace: trace,
                  ...(entry.resumePrompt && { evaluation_queries: queries }),
                }),
              );
              execFileSync(
                process.execPath,
                [inside(fixture, assertion.path), cwd, answer, "workspace"],
                {
                  cwd: fixture,
                  timeout: assertion.timeoutMs ?? 5000,
                  windowsHide: true,
                  stdio: "pipe",
                  env: { ...process.env, ...toolchainEnv },
                },
              );
              workspacePassed = true;
              if (replay) {
                replayStarted = true;
                execFileSync(
                  process.execPath,
                  [inside(fixture, assertion.path), replay, answer, "patch-replay"],
                  {
                    cwd: fixture,
                    timeout: assertion.timeoutMs ?? 5000,
                    windowsHide: true,
                    stdio: "pipe",
                    env: { ...process.env, ...toolchainEnv },
                  },
                );
              }
              passed = true;
            }
            assertions.push({
              type: assertion.type,
              passed,
              ...(replay && assertion.type === "verifier" && { patch_replay_passed: true }),
            });
          } catch (failure) {
            assertions.push({
              type: assertion.type,
              passed: false,
              phase: replayStarted ? "patch-replay" : "workspace",
              workspace_passed: workspacePassed,
              error: String(failure),
            });
          }
        }
      } catch (failure) {
        error = String(failure);
      } finally {
        if (fixture && initialTree && patch === undefined) {
          try {
            patch = capturePatch(cwd, initialTree);
          } catch (failure) {
            error ??= `Cannot capture candidate patch: ${String(failure)}`;
          }
        }
        // This exact path was allocated under the OS temp directory above.
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      }
      results.push({
        name: entry.name,
        attempt,
        input_hash: inputHash,
        limits,
        tools,
        ...(shellCommands.length && { shell_commands: shellCommands }),
        ...(shellCommands.length && { shell_approval: "all-shell-ask-v1" }),
        ...(toolchain && { toolchain }),
        tool_trace: trace,
        ...(entry.resumePrompt && { queries }),
        ...(initialTree && { patch_base_tree: initialTree }),
        ...(patchReplay && {
          patch_replay_verified:
            assertions.some((assertion) => assertion.patch_replay_passed) &&
            assertions
              .filter((assertion) => assertion.type === "verifier")
              .every((assertion) => assertion.patch_replay_passed),
        }),
        ...(patch !== undefined && { patch }),
        passed:
          !error &&
          assertions.length === entry.assertions.length &&
          assertions.every((assertion) => assertion.passed),
        ...(error && { error }),
        assertions,
        duration_ms: Date.now() - started,
        usage: entry.resumePrompt ? null : (final?.usage ?? null),
        cost_usd: entry.resumePrompt
          ? queries.length === 2 && queries.every((query) => Number.isFinite(query.cost_usd))
            ? queries[0].cost_usd + queries[1].cost_usd
            : null
          : (final?.total_cost_usd ?? null),
      });
      options.onCase?.(results.at(-1));
    }
  }
  return {
    date: new Date().toISOString(),
    evaluator_version: 5,
    patch_scope: "workspace tracked and unignored new files, excluding .claude runtime",
    suite_version: suite.version ?? "unversioned",
    model: options.model ?? "configured model",
    provider: options.provider ?? "configured provider",
    command: options.cliExecutable ?? "ccr",
    repeat,
    cases: results,
    passed: results.filter((result) => result.passed).length,
    total: results.length,
  };
}

export function writeEvaluation(report, directory) {
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `${Date.now()}-${process.pid}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  return output;
}
