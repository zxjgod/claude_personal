import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { MemoryStore } from "../memory-extract.js";

const execute = promisify(execFile);
it("serializes cross-process dedupe and index updates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-memory-concurrency-"));
  const script = path.join(root, "writer.mjs");
  const moduleUrl = pathToFileURL(path.resolve("src/memory-extract.ts")).href;
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';import {MemoryStore} from ${JSON.stringify(moduleUrl)};
    const [root,name]=process.argv.slice(2);fs.writeFileSync(root+'/ready-'+name,'ready');
    while(!fs.existsSync(root+'/go'))await new Promise(r=>setTimeout(r,10));
    new MemoryStore(root).append([{source:'manual',text:'shared fact'},{source:'manual',text:name}]);`,
  );
  const store = new MemoryStore(root);
  store.append([{ source: "manual", text: "initial" }]);
  const writers = Promise.all(
    ["writer-a", "writer-b"].map((name) =>
      execute(process.execPath, ["--import", "tsx", script, root, name], {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 15000,
      }),
    ),
  );
  void writers.catch(() => {});
  try {
    const deadline = Date.now() + 10000;
    while (
      !fs.existsSync(path.join(root, "ready-writer-a")) ||
      !fs.existsSync(path.join(root, "ready-writer-b"))
    ) {
      if (Date.now() >= deadline) throw new Error("Writer startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fs.writeFileSync(path.join(root, "go"), "start");
    await writers;
    expect(
      store
        .list()
        .map((entry) => entry.text)
        .sort(),
    ).toEqual(["initial", "shared fact", "writer-a", "writer-b"]);
    expect(store.append([{ source: "manual", text: "shared fact" }])).toEqual([]);
    const index = fs.readFileSync(path.join(root, ".claude", "memory", "MEMORY.md"), "utf8");
    expect(index).toContain("writer-a");
    expect(index).toContain("writer-b");
  } finally {
    fs.writeFileSync(path.join(root, "go"), "start");
    await writers.catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
