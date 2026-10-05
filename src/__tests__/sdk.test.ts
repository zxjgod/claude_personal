import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { query } from "../sdk.js";

it("feeds prompts and yields protocol messages from a local CLI module", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sdk-"));
  const file = path.join(root, "fixture.mjs");
  fs.writeFileSync(
    file,
    `import readline from 'node:readline'; console.error('diagnostic'); for await (const line of readline.createInterface({input:process.stdin})) { const input=JSON.parse(line); console.log(JSON.stringify({type:'result',session_id:'fixture',result:input.message.content})); }`,
  );
  try {
    const output = [];
    async function* prompts() {
      yield "first";
      yield "second";
    }
    for await (const message of query({
      prompt: prompts(),
      options: {
        cwd: root,
        cliModule: file,
        model: "fixture",
        maxTurns: 3,
        allowedTools: ["Read"],
        jsonSchema: { type: "string" },
      },
    }))
      output.push(message);
    expect(output.map((message) => message.result)).toEqual(["first", "second"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("throws a descriptive error when the default CLI entry is missing", async () => {
  // From a source checkout there is no src/cli.js (only dist has one) — the
  // SDK must fail fast with guidance instead of spawning a doomed child that
  // later dies with "CLI exited 1: Cannot find module".
  await expect(async () => {
    for await (const message of query({ prompt: "hi" })) void message;
  }).rejects.toThrow(/no CLI entry/);
});

it("survives a non-JSON stdout line and still delivers the result frame", async () => {
  // A hook/tool printing straight to stdout used to throw a raw SyntaxError
  // out of the generator: every already-yielded message was lost and the
  // caller got no result frame at all.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sdk-noise-"));
  const file = path.join(root, "fixture.mjs");
  fs.writeFileSync(
    file,
    `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const input = JSON.parse(line);
  console.log('warning: stray line, not JSON');
  console.log(JSON.stringify({type:'result',session_id:'fixture',result:input.message.content}));
}`,
  );
  try {
    const output = [];
    for await (const message of query({ prompt: "hello", options: { cwd: root, cliModule: file } }))
      output.push(message);
    expect(output.some((m) => m.subtype === "non_json_stdout" && m.is_error === true)).toBe(true);
    expect(output.filter((m) => m.type === "result").map((m) => m.result)).toEqual(["hello"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
