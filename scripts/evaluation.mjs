import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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

/** Every fixture attempt gets a fresh workspace; verifiers stay outside it. */
export async function runEvaluation(suite, options) {
  if (!Array.isArray(suite.cases) || suite.cases.length === 0)
    throw new Error("Suite requires non-empty cases[]");
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("repeat must be a positive integer");
  const prepared = suite.cases.map((entry) => {
    if (typeof entry.name !== "string" || typeof entry.prompt !== "string")
      throw new Error("Case requires name and prompt");
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
    const hash = createHash("sha256").update(
      JSON.stringify({ entry, limits, tools, version: suite.version }),
    );
    if (fixture) fingerprint(fixture, hash);
    return { entry, fixture, limits, tools, inputHash: hash.digest("hex") };
  });
  const results = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const { entry, fixture, limits, tools, inputHash } of prepared) {
      const started = Date.now();
      const temporary = fixture ? mkdtempSync(join(tmpdir(), "ccr-eval-")) : undefined;
      const cwd = temporary ? join(temporary, "workspace") : resolve(entry.cwd ?? ".");
      let final;
      let error;
      const assertions = [];
      try {
        if (fixture) {
          cpSync(join(fixture, "workspace"), cwd, { recursive: true });
          execFileSync("git", ["init", "--quiet", "--template=", cwd], { windowsHide: true });
        }
        for await (const message of options.query({
          prompt: entry.prompt,
          options: {
            cwd,
            env: {
              ...options.env,
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
            maxBudgetUsd: limits.maxBudgetUsd,
            ...tools,
            signal: AbortSignal.timeout(limits.timeoutMs),
            cliExecutable: options.cliExecutable,
          },
        })) {
          if (message.type === "result") final = message;
        }
        if (!final) throw new Error("no result frame — the CLI exited without reporting");
        if (final.is_error) throw new Error(final.errors?.join("; ") || "CLI reported failure");
        for (const assertion of entry.assertions) {
          try {
            let passed;
            if (assertion.type === "contains")
              passed = String(final.result ?? "").includes(assertion.text);
            else if (assertion.type === "fileContains")
              passed = readFileSync(inside(cwd, assertion.path), "utf8").includes(assertion.text);
            else {
              const answer = join(temporary, "answer.json");
              writeFileSync(answer, JSON.stringify(final));
              execFileSync(process.execPath, [inside(fixture, assertion.path), cwd, answer], {
                cwd: fixture,
                timeout: assertion.timeoutMs ?? 5000,
                windowsHide: true,
                stdio: "pipe",
              });
              passed = true;
            }
            assertions.push({ type: assertion.type, passed });
          } catch (failure) {
            assertions.push({ type: assertion.type, passed: false, error: String(failure) });
          }
        }
      } catch (failure) {
        error = String(failure);
      } finally {
        // This exact path was allocated under the OS temp directory above.
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      }
      results.push({
        name: entry.name,
        attempt,
        input_hash: inputHash,
        limits,
        tools,
        passed:
          !error &&
          assertions.length === entry.assertions.length &&
          assertions.every((assertion) => assertion.passed),
        ...(error && { error }),
        assertions,
        duration_ms: Date.now() - started,
        usage: final?.usage ?? null,
        cost_usd: final?.total_cost_usd ?? null,
      });
      options.onCase?.(results.at(-1));
    }
  }
  return {
    date: new Date().toISOString(),
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
