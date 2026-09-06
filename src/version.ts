// ============================================================
// version — the one runtime source of the package version
// ============================================================
// readFileSync at import time (NOT a JSON import): the build is a per-file
// esbuild transpile with bundle:false, so an inline `import pkg from
// "../../package.json"` would rely on resolveJsonModule + emit an extra .js
// shim that breaks the "1 input = 1 output" dist contract. Reading the file
// relative to this module resolves correctly in every layout:
//   repo dev (tsx src/cli.ts)      → <root>/package.json
//   local dist (node dist/cli.js)  → <root>/package.json
//   global install (ccr)           → <pkg-root>/package.json (dist/ sibling)
// ============================================================

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

/** The version from package.json ("0.0.0" only if the file is missing). */
export const APP_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts and dist/version.js (flat outbase layout) both sit ONE
  // level below the package root: ../package.json is the correct candidate in
  // dev, local dist, and global installs. The ../../ fallback only covers a
  // hypothetical nested emit layout — it must stay SECOND: in dev mode it
  // resolves to the REPO'S PARENT directory, and a stray package.json there
  // (monorepo root, home dir) would silently win if tried first.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require_(`${here}/${rel}`) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
})();
