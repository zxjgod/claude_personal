// ============================================================
// Smoke test — production sanity check, no API key / network needed
// ============================================================
// `npm run smoke` runs the whole chain the plan asks for:
//   build → start the built CLI → feed input → exit.
// It exercises four API-key-free paths and asserts each:
//   1. esbuild build succeeds
//   2. `cli.js --version` → exit 0, prints a semver
//   3. `cli.js --help`    → exit 0, prints usage
//   4. piped prompt with no LLM_API_KEY → graceful exit 1 (not a hang/crash)
// Anything else is a non-zero exit so CI fails loudly.
// ============================================================

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Run a node script, capture output, enforce a timeout (kills on overrun). */
function run(args, { input, env, cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: cwd ?? root,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

console.log("smoke: 1/4 build");
const build = await run([join(root, "scripts", "build.mjs")]);
check("build exits 0", build.code === 0, build.stderr.trim());

console.log("smoke: 2/4 --version");
const version = await run([cli, "--version"]);
check("--version exits 0", version.code === 0, `code=${version.code}`);
check(
  "--version prints semver",
  /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
  version.stdout.trim(),
);

console.log("smoke: 3/4 --help");
const help = await run([cli, "--help"]);
check("--help exits 0", help.code === 0, `code=${help.code}`);
check("--help prints usage", /Usage:/.test(help.stdout), help.stdout.slice(0, 80));

console.log("smoke: 4/4 piped prompt, no API key (graceful failure)");
// Run in a throwaway cwd so a real .env in the repo can't supply a key and
// turn this into a live model call.
const sandbox = mkdtempSync(join(tmpdir(), "ccr-smoke-"));
try {
  const piped = await run([cli, "--no-tui"], {
    input: "hello\n",
    cwd: sandbox,
    env: { LLM_API_KEY: "", LLM_PROVIDER: "openai", CCR_NO_TUI: "1" },
  });
  check("piped prompt does not hang", !piped.timedOut, "timed out");
  check("piped prompt exits non-zero without key", piped.code !== 0, `code=${piped.code}`);
  check(
    "piped prompt reports missing key",
    /LLM_API_KEY/.test(piped.stderr) || /LLM_API_KEY/.test(piped.stdout),
    (piped.stderr || piped.stdout).trim().slice(0, 120),
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke: FAILED (${failures} check${failures === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\nsmoke: PASSED");
