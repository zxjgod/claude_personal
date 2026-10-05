// ============================================================
// Build — esbuild bundle (single dist/, code-split chunks)
// ============================================================
// History: this used to be a per-file transpile (bundle:false) because two
// bundling risks were feared (see the old header in git history):
//   1. Ink/React ESM conditional imports — RESOLVED: the only unresolvable
//      one is ink's optional `react-devtools-core` (not installed; ink lazy-
//      imports it), kept external. CJS deps' `require()` calls are covered
//      by the per-chunk createRequire banner below.
//   2. lsp.ts createRequire(import.meta.url) resolving tsserver — RESOLVED:
//      chunks live in dist/ (one level below the package root, same as the
//      old flat layout), so require.resolve("typescript/lib/tsserver.js")
//      walks up to the same node_modules. version.ts / cli-env.ts read
//      ../package.json the same way — identical layout assumptions.
//
// What bundling buys (measured, docs/个人复刻-需求台账-20261005.md round 4):
//   - Interactive/REPL startup ~2.7s → ~2.0s (~27%) on Windows.
//   - 582 dist files → ~90 (4 entries + shared chunks); every dynamic
//     import (cli-main, TUI run, openai/anthropic SDKs, markdown/highlight)
//     becomes an on-demand chunk, preserving the lazy-loading architecture.
//   - `--version` stays ~110ms (the slim entry's static graph is tiny).
//
// Entries beyond cli.ts exist for consumers with deep imports:
//   sdk.ts        → scripts/evaluate.mjs, TS SDK users (dist/sdk.js)
//   index.ts      → package.json "main" (dist/index.js)
//   llm-adapter.ts → scripts/provider-smoke.mjs (dist/llm-adapter.js)
// Type-checking stays separate: `npm run typecheck` (tsc --noEmit) and CI.
// ============================================================

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist");

// Fresh dist each build so stale files (renamed chunks/modules) never linger.
rmSync(outdir, { recursive: true, force: true });

const t0 = Date.now();
await build({
  entryPoints: [
    resolve(root, "src/cli.ts"),
    resolve(root, "src/sdk.ts"),
    resolve(root, "src/index.ts"),
    resolve(root, "src/llm-adapter.ts"),
  ],
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outdir,
  sourcemap: true,
  jsx: "automatic",
  logLevel: "info",
  banner: {
    // CJS deps (dotenv, proper-lockfile…) call require("fs") etc. In ESM
    // output esbuild's __require shim throws unless a real require exists
    // in scope — provide one per chunk.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: [
    // Locates its rg binary relative to its own package dir — bundling the
    // shim breaks the path. Loaded via dynamic import in tools/core/grep.ts.
    "@vscode/ripgrep",
    // ink's optional devtools hook (not installed; ink only imports it
    // conditionally). Keep it out of the bundle so the lazy path stays lazy.
    "react-devtools-core",
  ],
});

console.log(`build: bundled 4 entries → dist/ in ${Date.now() - t0}ms`);
