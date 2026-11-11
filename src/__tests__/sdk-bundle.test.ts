import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("finds the default CLI from a shared SDK chunk after bundling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sdk-bundle-"));
  try {
    const source = path.resolve("src/sdk.ts");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(root, "index.mjs"),
      `export { query } from ${JSON.stringify(source.replaceAll("\\", "/"))};`,
    );
    await build({
      entryPoints: { sdk: source, index: path.join(root, "index.mjs") },
      outdir: path.join(root, "dist"),
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "node",
      chunkNames: "chunks/[name]-[hash]",
    });
    fs.writeFileSync(
      path.join(root, "dist/cli.js"),
      `
import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const input=JSON.parse(line);
  console.log(JSON.stringify({type:'result',result:input.message.content}));
}`,
    );
    expect(fs.readdirSync(path.join(root, "dist/chunks")).length).toBeGreaterThan(0);
    const moduleUrl = pathToFileURL(path.join(root, "dist/sdk.js")).href;
    const { query } = await import(moduleUrl);
    const messages = [];
    for await (const message of query({ prompt: "bundled SDK works", options: { cwd: root } }))
      messages.push(message);
    expect(messages.map((message) => message.result)).toEqual(["bundled SDK works"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
