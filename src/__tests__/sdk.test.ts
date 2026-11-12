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

// Fixture CLI: asks can_use_tool for every user turn and embeds the peer's
// decision in the result frame, so the test observes the full round-trip.
const PERMISSION_FIXTURE = `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    console.log(JSON.stringify({type:'control_request',request_id:'perm-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'ls'},permission_suggestions:[]}}));
  } else if (msg.type === 'control_response') {
    console.log(JSON.stringify({type:'result',session_id:'fixture',result:JSON.stringify(msg.response.response ?? msg.response)}));
  }
}`;

function writeFixture(prefix: string, source: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(root, "fixture.mjs");
  fs.writeFileSync(file, source);
  return { root, file };
}

it("round-trips can_use_tool through the canUseTool callback", async () => {
  const { root, file } = writeFixture("ccr-sdk-perm-", PERMISSION_FIXTURE);
  try {
    const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
    const output = [];
    for await (const message of query({
      prompt: "go",
      options: {
        cwd: root,
        cliModule: file,
        canUseTool: async (name, input, context) => {
          seen.push({ name, input });
          expect(context.suggestions).toEqual([]);
          expect(context.signal.aborted).toBe(false);
          return { behavior: "allow", updatedInput: { command: "pwd" } };
        },
      },
    }))
      output.push(message);
    expect(seen).toEqual([{ name: "Bash", input: { command: "ls" } }]);
    // Control frames are SDK plumbing and must not surface as messages.
    expect(output.some((m) => m.type === "control_request" || m.type === "control_response")).toBe(
      false,
    );
    const result = output.find((m) => m.type === "result");
    expect(JSON.parse(result!.result!)).toEqual({
      behavior: "allow",
      updatedInput: { command: "pwd" },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("delivers a deny decision and fails closed when the callback throws", async () => {
  const { root, file } = writeFixture("ccr-sdk-deny-", PERMISSION_FIXTURE);
  try {
    const output = [];
    for await (const message of query({
      prompt: "go",
      options: {
        cwd: root,
        cliModule: file,
        canUseTool: async () => ({ behavior: "deny", message: "not allowed" }),
      },
    }))
      output.push(message);
    expect(JSON.parse(output.find((m) => m.type === "result")!.result!)).toEqual({
      behavior: "deny",
      message: "not allowed",
    });

    const errored = [];
    for await (const message of query({
      prompt: "go",
      options: {
        cwd: root,
        cliModule: file,
        canUseTool: async () => {
          throw new Error("callback exploded");
        },
      },
    }))
      errored.push(message);
    const errorFrame = JSON.parse(errored.find((m) => m.type === "result")!.result!);
    expect(errorFrame.subtype).toBe("error");
    expect(errorFrame.error).toContain("callback exploded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("interrupts a running turn through the control protocol", async () => {
  const { root, file } = writeFixture(
    "ccr-sdk-int-",
    `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'working'}]}}));
  } else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
    console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{}}}));
    console.log(JSON.stringify({type:'result',session_id:'fixture',result:'interrupted'}));
  }
}`,
  );
  try {
    const output = [];
    const q = query({ prompt: "go", options: { cwd: root, cliModule: file } });
    for await (const message of q) {
      output.push(message);
      if (message.type === "assistant") await q.interrupt();
    }
    expect(output.find((m) => m.type === "result")?.result).toBe("interrupted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("round-trips setModel and setPermissionMode control requests", async () => {
  const { root, file } = writeFixture(
    "ccr-sdk-ctl-",
    `import readline from 'node:readline';
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture'}));
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{echo:msg.request}}}));
  } else if (msg.type === 'user') {
    console.log(JSON.stringify({type:'result',session_id:'fixture',result:'done'}));
  }
}`,
  );
  try {
    const pending: Promise<void>[] = [];
    const q = query({ prompt: "go", options: { cwd: root, cliModule: file } });
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        // Do not await here: the response arrives on the stream being read.
        pending.push(q.setModel("new-model"), q.setPermissionMode("acceptEdits"));
      }
    }
    await Promise.all(pending);
    expect(pending).toHaveLength(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects control methods called before iteration starts", async () => {
  const { root, file } = writeFixture("ccr-sdk-early-", PERMISSION_FIXTURE);
  try {
    const q = query({ prompt: "go", options: { cwd: root, cliModule: file } });
    await expect(q.interrupt()).rejects.toThrow(/require the generator to be iterating/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("aborts a pending approval callback before delivering its turn's result", async () => {
  const { root, file } = writeFixture(
    "ccr-sdk-approval-ended-",
    `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg=JSON.parse(line);
  if (msg.type==='user') {
    console.log(JSON.stringify({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'write',input:{}}}));
    console.log(JSON.stringify({type:'result',result:'turn ended'}));
  }
}`,
  );
  let callbackSignal: AbortSignal | undefined;
  try {
    for await (const message of query({
      prompt: "go",
      options: {
        cwd: root,
        cliModule: file,
        canUseTool: async (_name, _input, context) => {
          callbackSignal = context.signal;
          return await new Promise((resolve) =>
            context.signal.addEventListener("abort", () => resolve({ behavior: "deny" }), {
              once: true,
            }),
          );
        },
      },
    })) {
      if (message.type === "result") expect(callbackSignal?.aborted).toBe(true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("waits for its CLI process to exit when the consumer closes the query early", async () => {
  const { root, file } = writeFixture(
    "ccr-sdk-owned-exit-",
    `
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
console.log(JSON.stringify({type:'assistant',pid:process.pid}));
`,
  );
  const q = query({ prompt: "go", options: { cwd: root, cliModule: file } });
  let pid: number | undefined;
  const alive = () => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const first = await q.next();
    if (!first.done && typeof first.value.pid === "number") pid = first.value.pid;
    expect(pid).toBeDefined();
    await q.return(undefined);
    expect(alive()).toBe(false);
  } finally {
    await q.return(undefined).catch(() => {});
    if (alive() && pid) process.kill(pid, "SIGKILL");
    for (let attempt = 0; attempt < 50 && alive(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

it("reports invalid JSON message envelopes and continues to a valid result", async () => {
  const { root, file } = writeFixture(
    "ccr-sdk-invalid-envelope-",
    `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  if (JSON.parse(line).type==='user') {
    for (const value of [null,[],"banner",{foo:"bar"}]) console.log(JSON.stringify(value));
    console.log(JSON.stringify({type:'result',result:'survived'}));
  }
}`,
  );
  try {
    const messages = [];
    for await (const message of query({ prompt: "go", options: { cwd: root, cliModule: file } }))
      messages.push(message);
    expect(
      messages.filter((message) => message.subtype === "invalid_protocol_message"),
    ).toHaveLength(4);
    expect(messages.find((message) => message.type === "result")?.result).toBe("survived");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  undefined,
  "unexpected",
])("rejects control replies with invalid subtype %s", async (subtype) => {
  const { root, file } = writeFixture(
    "ccr-sdk-control-envelope-",
    `import readline from 'node:readline';
console.log(JSON.stringify({type:'system',subtype:'init'}));
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg=JSON.parse(line);
  if(msg.type==='control_request') {
    console.log(JSON.stringify({type:'control_response',response:{subtype:${JSON.stringify(subtype) ?? "undefined"},request_id:msg.request_id,response:{}}}));
    console.log(JSON.stringify({type:'result',result:'done'}));
  }
}`,
  );
  const q = query({ prompt: "go", options: { cwd: root, cliModule: file } });
  try {
    for await (const message of q)
      if (message.type === "system" && message.subtype === "init")
        await expect(q.setModel("next")).rejects.toThrow(/Invalid control response subtype/);
  } finally {
    await q.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
