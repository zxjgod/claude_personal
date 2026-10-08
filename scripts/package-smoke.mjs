import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

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
    "dist/pdf-worker.mjs",
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
  const { makePdf } = await tsImport("../src/__tests__/fixtures/pdf.ts", import.meta.url);
  run([
    "--input-type=module",
    "-e",
    `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createModelCaller } from './dist/llm-adapter.js';
let captured;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  captured = JSON.parse(Buffer.concat(chunks).toString());
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\\n\\ndata: [DONE]\\n\\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const config = { provider: 'custom', model: 'vision-fixture', apiKey: 'offline', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' };
  const history = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: process.argv[1] } }] }];
  for await (const event of createModelCaller(config)(history, [], 's', config)) { }
  assert(captured, 'Unpacked adapter did not send a request.');
  const payload = JSON.stringify(captured.messages);
  assert(payload.includes('Page 1 content'), 'Unpacked PDF text extraction failed.');
  assert(payload.includes('data:image/png;base64,'), 'Unpacked PDF rendering failed.');
  assert(!payload.includes('application/pdf'), 'Raw PDF reached the compatible endpoint.');
} finally {
  await new Promise(resolve => server.close(resolve));
}
`,
    makePdf().toString("base64"),
  ]);
  console.log(
    `package-smoke: PASSED (${pack.entryCount} files, ${(pack.unpackedSize / 1048576).toFixed(2)} MiB unpacked, ${(pack.size / 1048576).toFixed(2)} MiB archive)`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
