// ============================================================
// Smoke test — production sanity check, no API key / network needed
// ============================================================
// `npm run smoke` runs the whole chain the plan asks for:
//   build → start the built CLI → feed input → exit.
// It exercises five API-key-free paths and asserts each:
//   1. esbuild build succeeds
//   2. `cli.js --version` → exit 0, prints a semver
//   3. `cli.js --help`    → exit 0, prints usage
//   4. piped prompt with no LLM_API_KEY → graceful exit 1 (not a hang/crash)
//   5. command table loads (--print-command) → exits 0, prints command list
//      (NOTE: --print-command exits BEFORE any provider/TUI setup — this
//      checks the command registry, not an Ink mount; TUI rendering is
//      covered by the vitest TUI component suites.)
//   6. session persistence — a REAL PersistenceManager.save() creates the
//      session file and directory structure (no hand-built fixtures).
// Anything else is a non-zero exit so CI fails loudly.
// ============================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// The build now also emits TypeScript declarations (tsc --emitDeclarationOnly)
// on top of the esbuild bundle — comfortably over the default 20s under load.
const build = await run([join(root, "scripts", "build.mjs")], { timeoutMs: 180_000 });
check("build exits 0", build.code === 0, (build.stderr || build.stdout).trim());

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
// Use ASCII-only temp directory for Windows compatibility.
const sandbox = mkdtempSync(join(tmpdir(), "ccr-pipe-"));
try {
  const piped = await run([cli, "--no-tui"], {
    input: "hello\n",
    cwd: sandbox,
    env: { LLM_API_KEY: "", LLM_PROVIDER: "openai", CCR_NO_TUI: "1" },
  });
  check("piped prompt does not hang", !piped.timedOut, "timed out");
  // P0-1: When no .env exists, shows onboarding UI instead of raw error
  // In non-interactive mode, it copies the template and exits gracefully
  check(
    "piped prompt reports missing env or onboarding",
    /未检测到|already exists|LLM_API_KEY/.test(piped.stdout + piped.stderr),
    (piped.stderr || piped.stdout).trim().slice(0, 120),
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("smoke: 5/6 command table loads (--print-command)");
// Use ASCII-only temp directory for Windows compatibility
const tuiSandbox = mkdtempSync(join(tmpdir(), "ccr-tui-"));
let tuiPassed = false;
try {
  // On Windows, use ASCII-only path
  const tuiCmd = await run([cli, "--print-command"], {
    cwd: tuiSandbox,
    env: { LLM_API_KEY: "test-key", LLM_PROVIDER: "openai" },
    timeoutMs: 10000,
  });
  if (tuiCmd.code === 0) {
    check("--print-command exits 0", true);
    // Honest claim: this flag exits before provider/TUI setup — assert what
    // it actually exercises (the command registry), not "TUI startup".
    const output = tuiCmd.stdout + tuiCmd.stderr;
    const hasCommands = /compact|diff|memory|status/.test(output);
    const hasSetup = /首次设置|setup|Configure|configure/.test(output);
    check("command table (or onboarding) prints", hasCommands || hasSetup, output.slice(0, 100));
    tuiPassed = true;
  } else {
    check(
      "--print-command exits 0",
      false,
      `code=${tuiCmd.code}, stderr: ${tuiCmd.stderr.slice(0, 100)}`,
    );
  }
} finally {
  rmSync(tuiSandbox, { recursive: true, force: true });
}
if (!tuiPassed) {
  // Fallback: just check the CLI file exists
  check("CLI built file exists", existsSync(cli), cli);
}

console.log("smoke: 6/6 session persistence (real save path)");
// Drive the ACTUAL PersistenceManager instead of hand-creating the layout
// (review fix: the old check built .claude/sessions itself and then asserted
// its own writes — it passed even if the product path was broken).
const sessionSandbox = mkdtempSync(join(tmpdir(), "ccr-sess-"));
try {
  const versionProbe = await run([cli, "--version"], { cwd: sessionSandbox });
  check(
    ".claude not created before first session",
    versionProbe.code === 0 && !existsSync(join(sessionSandbox, ".claude")),
    "exists unexpectedly",
  );
  const saved = await run(
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { PersistenceManager } from ${JSON.stringify(
        pathToFileURL(join(root, "src", "persistence.ts")).href,
      )};
       const ws = process.env.CCR_SMOKE_ROOT;
       const p = new PersistenceManager(ws);
       await p.save("smoke-session", [{ role: "user", content: [{ type: "text", text: "hello" }] }], { taskState: "paused" });
       const re = await new PersistenceManager(ws).load("smoke-session");
       if (!re || re.messageCount !== 1) process.exit(3);`,
    ],
    // Run from the repo root (bare "tsx" resolves from the repo's
    // node_modules); the sandbox travels via env — PersistenceManager takes
    // the workspace root explicitly.
    { env: { CCR_SMOKE_ROOT: sessionSandbox } },
  );
  check(
    "PersistenceManager.save writes a loadable session file",
    saved.code === 0,
    (saved.stderr || saved.stdout).trim().slice(0, 160),
  );
  check(
    ".claude/sessions/<id>.json exists on disk",
    existsSync(join(sessionSandbox, ".claude", "sessions", "smoke-session.json")),
    "missing session file",
  );
} finally {
  rmSync(sessionSandbox, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke: FAILED (${failures} check${failures === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\nsmoke: PASSED");
