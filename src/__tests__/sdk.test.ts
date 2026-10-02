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
