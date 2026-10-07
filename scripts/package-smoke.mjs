import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run smoke:package.");
const options = { cwd: root, encoding: "utf8", timeout: 60000, windowsHide: true };
execFileSync(process.execPath, [join(root, "scripts/build.mjs")], options);
mkdirSync(join(root, ".review-tmp"), { recursive: true });
// Keeping the fixture below root lets it resolve the installed external dependencies.
const temporary = mkdtempSync(join(root, ".review-tmp/package-"));
try {
  const [pack] = JSON.parse(
    execFileSync(
      process.execPath,
      [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      options,
    ),
  );
  const paths = new Set(pack.files.map((file) => file.path));
  for (const entry of [
    "dist/cli.js",
    "dist/index.js",
    "dist/sdk.js",
    "dist/llm-adapter.js",
    "python/ccr_sdk.py",
    "examples/providers.json",
    "docs/CHANGELOG.md",
    ".env.example",
    "README.md",
  ])
    assert(paths.has(entry), `Missing published entry: ${entry}`);
  for (const file of paths) {
    assert(
      !/^(src|scripts|reference|sandbox|coverage|\.claude|\.github|\.husky)\//.test(file),
      `Development/local file published: ${file}`,
    );
    assert(!file.startsWith("docs/archive/"), `Historical document published: ${file}`);
    assert(!file.endsWith(".map"), `Source map published: ${file}`);
    assert(file !== ".env" && file !== ".mcp.json", `Local config published: ${file}`);
  }
  execFileSync("tar", ["-xf", join(temporary, pack.filename), "-C", temporary], options);
  const unpacked = join(temporary, "package");
  const pkg = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
  const env = {
    ...process.env,
    WORKSPACE_ROOT: unpacked,
    CCR_USER_CONFIG_DIR: join(temporary, "user"),
    LLM_API_KEY: "offline-package-fixture",
    LLM_PROVIDER: "custom",
    LLM_MODEL: "fixture",
    LLM_BASE_URL: "http://127.0.0.1:1/v1",
    NO_COLOR: "1",
  };
  const run = (args, input) =>
    execFileSync(process.execPath, args, {
      ...options,
      cwd: unpacked,
      env,
      input,
      timeout: 20000,
    });
  assert.equal(run(["dist/cli.js", "--version"]).trim(), pkg.version);
  assert.match(run(["dist/cli.js", "--help"]), /Usage:/);
  const notes = run(["dist/cli.js", "--no-tui", "--bare"], "/release-notes\nexit\n");
  assert(notes.includes(`v${pkg.version}`), "Unpacked CLI did not render its release notes.");
  assert(!notes.includes("No changelog is bundled"), "Unpacked CLI cannot find the changelog.");
  run([
    "--input-type=module",
    "-e",
    "const sdk = await import('./dist/index.js'); if (typeof sdk.query !== 'function' || typeof sdk.createModelCaller !== 'function') process.exit(1);",
  ]);
  run([
    "--input-type=module",
    "-e",
    "const adapter = await import('./dist/llm-adapter.js'); for (const name of ['createModelCaller', 'resolveProviderConfig', 'isRateLimitError', 'isAuthError', 'isProviderError']) if (typeof adapter[name] !== 'function') process.exit(1);",
  ]);
  console.log(
    `package-smoke: PASSED (${pack.entryCount} files, ${(pack.unpackedSize / 1048576).toFixed(2)} MiB unpacked, ${(pack.size / 1048576).toFixed(2)} MiB archive)`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
