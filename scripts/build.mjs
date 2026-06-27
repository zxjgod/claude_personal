// ============================================================
// Build — esbuild transpile (replaces `tsc` for emitting dist/)
// ============================================================
// Why transpile (bundle: false) and not a bundle / code-split:
//   - The CLI loads Ink + React 19 (ESM) which use dynamic require/
//     conditional imports; bundling those is fragile.
//   - src/lsp.ts uses `createRequire(import.meta.url)` — under a bundle,
//     import.meta.url points at the bundle file and breaks module
//     resolution. Per-file transpile keeps each file's own import.meta.url.
//   - The module graph at runtime stays identical to the old `tsc` output,
//     so behaviour is unchanged; we only drop type-checking + declarations.
//
// What this buys over `tsc`:
//   - Much faster (no type-checking, no .d.ts / .d.ts.map emit).
//   - Smaller dist/ (no declaration files).
// Type-checking is kept separate: `npm run typecheck` (tsc --noEmit) and CI.
// ============================================================

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import fg from "fast-glob";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist");

// Ship runtime source only — never the tests or type-declaration stubs.
const entryPoints = await fg(["src/**/*.ts", "src/**/*.tsx"], {
  cwd: root,
  absolute: true,
  ignore: ["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.d.ts"],
});

if (entryPoints.length === 0) {
  console.error("build: no entry points found under src/");
  process.exit(1);
}

// Fresh dist each build so stale files (e.g. renamed modules) never linger.
rmSync(outdir, { recursive: true, force: true });

const t0 = Date.now();
await build({
  entryPoints,
  outdir,
  outbase: resolve(root, "src"),
  // bundle:false → 1 input file = 1 output file, imports left as-is
  // (`./foo.js` resolves to the emitted foo.js, same as before).
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  jsx: "automatic",
  logLevel: "info",
});

console.log(`build: transpiled ${entryPoints.length} files → dist/ in ${Date.now() - t0}ms`);
