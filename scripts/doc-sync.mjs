#!/usr/bin/env node
// ============================================================
// doc-sync — authoritative project metrics, one click.
//
// Purpose: the repo repeatedly suffered "doc number drift"
// (see docs/模块维护方案.md "文档与计数同步责任"). This script
// replaces hand-counted numbers in docs with real measurements.
//
// Usage:
//   node --import tsx scripts/doc-sync.mjs          # print live metrics
//   node --import tsx scripts/doc-sync.mjs --check  # compare vs docs, exit 1 on drift
//   node --import tsx scripts/doc-sync.mjs --with-tests  # also run vitest for test-case count
//
// --check is wired into .husky/pre-commit as a WARNING (non-blocking).
//
// Counts:
//   version   — package.json version (the single source of truth)
//   srcLines  — non-test .ts/.tsx lines under src/
//   srcFiles  — non-test .ts/.tsx files under src/
//   testFiles — test files under src/__tests__ (*.test.ts / *.test.tsx)
//   commands  — COMMANDS.length (imported from src/commands/registry.ts via tsx)
//   tools     — CORE_TOOLS.length (imported from src/tools/core-tools.ts via tsx)
//   tests     — static ≈ count of test()/it() call sites, OR authoritative
//               vitest count when --with-tests is passed.
// ============================================================

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { checkArchitectureDocs } from "./architecture-docs.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const withTests = process.argv.includes("--with-tests");
const check = process.argv.includes("--check");

// --- Filesystem helpers -------------------------------------------------

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const lineCountOf = (p) => readFileSync(p, "utf8").split("\n").length;

// Test suites as actually run by `npm test` (see vitest.config.ts include:
// "src/**/*.test.ts" + "src/**/*.test.tsx").
const isTestFile = (p) => /\.test\.(ts|tsx)$/.test(p);
const underTests = (p) => p.includes(`${sep}__tests__${sep}`);

const srcFiles = walk(src).filter((p) => !underTests(p));
const testFiles = walk(src).filter(isTestFile);
const srcLines = srcFiles.reduce((n, p) => n + lineCountOf(p), 0);

// --- Imported counts (commands / tools) via tsx loader ------------------
// Requires `node --import tsx`. Falls back to static regex if the import
// fails so the script degrades gracefully.
let commands = null;
let tools = null;
try {
  const { COMMANDS } = await import("../src/commands/registry.ts");
  const { CORE_TOOLS } = await import("../src/tools/core-tools.ts");
  commands = COMMANDS.length;
  tools = CORE_TOOLS.length;
} catch {
  // Read the actual array expressions; no hard-coded bundle size or comment-sensitive regex.
  const countArray = (relative, name) => {
    const file = join(src, relative);
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.name.getText(ast) !== name ||
          !declaration.initializer ||
          !ts.isArrayLiteralExpression(declaration.initializer)
        )
          continue;
        return declaration.initializer.elements.reduce((count, element) => {
          if (!ts.isSpreadElement(element)) return count + 1;
          const bundle = element.expression.getText(ast);
          const bundles = {
            TEAM_TOOLS: "tools/breadth/team.ts",
            ORCHESTRATION_TOOLS: "tools/breadth/orchestration.ts",
          };
          if (!bundles[bundle]) throw new Error(`Unknown tool bundle ${bundle}`);
          return count + countArray(bundles[bundle], bundle);
        }, 0);
      }
    }
    throw new Error(`Array ${name} not found in ${relative}`);
  };
  commands = countArray("commands/registry.ts", "COMMANDS");
  tools = countArray("tools/core-tools.ts", "CORE_TOOLS");
}

// --- Test-case count ----------------------------------------------------

let tests = null;
let testsNote = "static ≈ (use --with-tests for vitest's authoritative count)";
if (withTests) {
  // Invoke the vitest CLI directly via the current node binary — `npx` is a
  // .cmd shim on Windows and can't be spawned via execFileSync without a shell.
  const vitestCli = join(root, "node_modules", "vitest", "vitest.mjs");
  const out = execFileSync(process.execPath, [vitestCli, "run", "--config", "vitest.config.ts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const clean = out.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI color codes
  const passed = clean.match(/Tests\s+(\d+)\s+passed/);
  const failed = clean.match(/(\d+)\s+failed/);
  if (passed) tests = Number(passed[1]) + (failed ? Number(failed[1]) : 0);
  testsNote = "vitest run";
} else {
  tests = testFiles.reduce(
    (n, p) => n + (readFileSync(p, "utf8").match(/^\s*(?:test|it)\(/gm) ?? []).length,
    0,
  );
}

// --- Version ------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

// --- Report -------------------------------------------------------------

const metrics = { version, srcLines, srcFiles, testFiles, commands, tools, tests };

if (check) {
  checkAgainstDocs(metrics);
} else {
  console.log("doc-sync — live project metrics");
  console.log("--------------------------------");
  console.log(`version    : ${version}`);
  console.log(`srcLines   : ${srcLines}  (non-test .ts/.tsx)`);
  console.log(`srcFiles   : ${srcFiles.length}  (non-test .ts/.tsx files)`);
  console.log(`testFiles  : ${testFiles.length}  (*.test.ts / *.test.tsx, matches vitest include)`);
  console.log(`commands   : ${commands}  (COMMANDS.length)`);
  console.log(`tools      : ${tools}  (CORE_TOOLS.length)`);
  console.log(`tests      : ${tests}  (${testsNote})`);
  console.log("--------------------------------");
  console.log("Run with --check to compare against docs, --with-tests for vitest count.");
}

// --- --check: compare against the numbers written in docs ----------------

function checkAgainstDocs(metrics) {
  const docPath = join(root, "docs", "项目总览.md");
  const doc = readFileSync(docPath, "utf8");
  let failures = 0;
  const architectureErrors = checkArchitectureDocs(root);
  for (const error of architectureErrors) console.warn(`✗ ${error}`);
  failures += architectureErrors.length;

  const expect = (label, actual, pattern) => {
    const m = doc.match(pattern);
    const claimed = m ? m[1].replace(/,/g, "") : null; // ignore thousands separators
    const ok = claimed !== null && String(actual) === claimed;
    if (!ok) {
      failures++;
      console.warn(`✗ ${label}: docs say "${m ? m[1] : null}", actual ${actual}`);
    } else {
      console.log(`✓ ${label}: ${actual}`);
    }
  };

  expect("version", metrics.version, />\s*\*\*版本\*\*:\s*v?([\d.]+)/);
  expect("srcLines", metrics.srcLines, /\*\*代码行数\*\*\s*\|\s*~?([\d,]+)/);
  expect("srcFiles", metrics.srcFiles.length, /\*\*源文件\*\*\s*\|\s*([\d,]+)/);
  expect("testFiles", metrics.testFiles.length, /\*\*测试文件\*\*\s*\|\s*([\d,]+)/);
  expect("commands", metrics.commands, /\*\*命令数\*\*\s*\|\s*([\d,]+)/);
  expect("tools", metrics.tools, /\*\*工具数\*\*\s*\|\s*([\d,]+)/);
  if (withTests) {
    expect("tests", metrics.tests, /\*\*测试用例\*\*\s*\|\s*([\d,]+)/);
  } else {
    console.log("↷ tests: skip (static count is approximate; use --with-tests)");
  }

  if (failures > 0) {
    console.warn(
      `\ndoc-sync --check: ${failures} doc number(s) drifted. ` +
        "Run `npm run docs:sync` and update docs/项目总览.md (see 模块维护方案.md).",
    );
    process.exit(1);
  }
  console.log("\ndoc-sync --check: all documented numbers are in sync.");
}
