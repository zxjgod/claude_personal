import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { tsImport } from "tsx/esm/api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run smoke:package.");
const options = { cwd: root, encoding: "utf8", timeout: 180000, windowsHide: true };

// Raw step logs need auth to read, but `::error` annotations come through the
// public checks API — on failure, surface the failing phase, an environment
// fingerprint and the child's output tail there before rethrowing.
let phase = "build";
let stagingRoot;
const context = [];
const annotateFailure = (error) => {
  const detail = [`phase=${phase}`, `node=${process.version}`];
  try {
    detail.push(
      `tar=${execFileSync("tar", ["--version"], { encoding: "utf8", timeout: 10_000 }).split("\n")[0]}`,
    );
  } catch {
    detail.push("tar=unavailable");
  }
  if (stagingRoot) {
    try {
      detail.push(`staging=${readdirSync(stagingRoot).slice(0, 30).join(",")}`);
    } catch {
      detail.push("staging=unreadable");
    }
  }
  for (const [label, value] of [
    ["status", error?.status],
    ["signal", error?.signal],
    ["code", error?.code],
  ])
    if (value !== undefined && value !== null) detail.push(`${label}=${value}`);
  if (error?.command) detail.push(`command=${error.command.join(" ")}`);
  if (error?.stdout) detail.push(`stdout-tail=${String(error.stdout).slice(-400)}`);
  if (error?.stderr) detail.push(`stderr-tail=${String(error.stderr).slice(-400)}`);
  detail.push(String(error?.message ?? error));
  if (context.length) detail.push(context.join(" ; "));
  const flat = detail.join(" | ").replaceAll("\r", "").replaceAll("\n", " ⏎ ");
  console.log(`::error::${flat.slice(0, 800)}`);
};

// Unpack without the system tar. npm writes raw UTF-8 into ustar name fields
// (no pax record) whenever the name fits, and windows-latest' bsdtar 3.8.x
// converts header names through the ANSI codepage: under an en-US locale every
// non-ASCII entry dies as "Archive entry has empty or unreadable filename"
// and tar exits 1 (run 40196005733). Real consumers untar with Node already,
// so parse the gunzipped ustar/pax stream here — no locale, no PATH needs.
const tarField = (header, start, end) => {
  const raw = header.subarray(start, end);
  const nul = raw.indexOf(0);
  return nul < 0 ? raw : raw.subarray(0, nul);
};
const tarSize = (field) => {
  if (field[0] & 0x80) {
    let value = 0n;
    for (const byte of field) value = (value << 8n) | BigInt(byte & 0x7f);
    return Number(value);
  }
  return Number.parseInt(field.toString("ascii").replace(/\0.*$/s, "").trim(), 8) || 0;
};
const paxRecords = (block) => {
  const records = new Map();
  let cursor = 0;
  while (cursor < block.length) {
    const spaceAt = block.indexOf(32, cursor);
    if (spaceAt < 0) break;
    const length = Number(block.toString("ascii", cursor, spaceAt));
    if (!Number.isInteger(length) || length <= 0 || cursor + length > block.length) break;
    const record = block.toString("utf8", spaceAt + 1, cursor + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    cursor += length;
  }
  return records;
};
const extractTar = (archive, dest) => {
  const tar = gunzipSync(readFileSync(archive));
  let offset = 0;
  let pending = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarSize(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === "x" || typeflag === "g") {
      if (typeflag === "x") pending = { path: paxRecords(data).get("path") };
      continue;
    }
    if (typeflag === "L" || typeflag === "K") {
      pending = { path: data.toString("utf8").replace(/\0$/, "") };
      continue;
    }
    let name = pending.path ?? tarField(header, 0, 100).toString("utf8");
    const prefix = tarField(header, 345, 500);
    if (!pending.path && prefix.length) name = `${prefix.toString("utf8")}/${name}`;
    pending = {};
    if (typeflag === "1" || typeflag === "2")
      throw new Error(`package tarball contains a link entry: ${name}`);
    const target = join(dest, name);
    assert(
      target === dest || target.startsWith(dest + sep),
      `package tarball escapes the staging directory: ${name}`,
    );
    if (typeflag === "5" || name.endsWith("/")) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
  }
};

try {
  execFileSync(process.execPath, [join(root, "scripts/build.mjs")], options);
  // The pack below runs with --ignore-scripts (so the prepack build doesn't run
  // a second time and its stdout can't corrupt the --json parse). That means
  // smoke never EXERCISES the prepack path — guard against silent removal with
  // a static assertion instead: without `prepack`, a clean checkout publishes
  // a package with no dist/ at all (dist is gitignored).
  phase = "prepack-assert";
  const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    pkgJson.scripts?.prepack,
    "node scripts/build.mjs",
    "package.json must keep scripts.prepack = build so a clean checkout publishes a runnable package",
  );
  mkdirSync(join(root, ".review-tmp"), { recursive: true });
  // Keeping the fixture below root lets it resolve the installed external dependencies.
  const temporary = mkdtempSync(join(root, ".review-tmp/package-"));
  stagingRoot = temporary;
  try {
    phase = "npm-pack";
    const packOutput = execFileSync(
      process.execPath,
      [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      options,
    );
    // npm 10 runs `prepare` even under `--ignore-scripts` (npm 11 does not),
    // and that script's stdout lands in ours — parse from the first top-level
    // JSON array instead of assuming the whole buffer is the document.
    const jsonStart = packOutput.indexOf("[");
    assert(jsonStart >= 0, "npm pack produced no JSON output");
    const [pack] = JSON.parse(packOutput.slice(jsonStart));
    phase = "pack-contents";
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
    // Extract in-process (extractTar above): system tar proved locale-fragile
    // for the UTF-8 filenames npm writes into ustar headers, and the archive
    // path on the command line trips GNU tar's host:path parsing on Windows.
    phase = "tar-extract";
    extractTar(join(temporary, pack.filename), temporary);
    phase = "unpack-read";
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
    phase = "cli-version";
    assert.equal(run(["dist/cli.js", "--version"]).trim(), pkg.version);
    phase = "cli-help";
    assert.match(run(["dist/cli.js", "--help"]), /Usage:/);
    phase = "cli-release-notes";
    const notes = run(["dist/cli.js", "--no-tui", "--bare"], "/release-notes\nexit\n");
    assert(notes.includes(`v${pkg.version}`), "Unpacked CLI did not render its release notes.");
    assert(!notes.includes("No changelog is bundled"), "Unpacked CLI cannot find the changelog.");
    phase = "sdk-import";
    run([
      "--input-type=module",
      "-e",
      "const sdk = await import('./dist/index.js'); if (typeof sdk.query !== 'function' || typeof sdk.createModelCaller !== 'function') process.exit(1);",
    ]);
    phase = "adapter-import";
    run([
      "--input-type=module",
      "-e",
      "const adapter = await import('./dist/llm-adapter.js'); for (const name of ['createModelCaller', 'resolveProviderConfig', 'isRateLimitError', 'isAuthError', 'isProviderError']) if (typeof adapter[name] !== 'function') process.exit(1);",
    ]);
    phase = "pdf-fixture";
    const { makePdf } = await tsImport("../src/__tests__/fixtures/pdf.ts", import.meta.url);
    phase = "pdf-pipeline";
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
} catch (error) {
  annotateFailure(error);
  throw error;
}
