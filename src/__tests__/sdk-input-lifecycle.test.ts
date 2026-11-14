import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { query } from "../sdk.js";

function fixture(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sdk-input-"));
  const file = path.join(root, "fixture.mjs");
  fs.writeFileSync(file, source);
  return { root, file };
}

function parkedInput() {
  let finishNext!: (result: IteratorResult<string>) => void;
  let returned = false;
  let calls = 0;
  const pending = new Promise<IteratorResult<string>>((resolve) => {
    finishNext = resolve;
  });
  const source: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return ++calls === 1 ? { value: "first", done: false } : pending;
    },
    async return() {
      returned = true;
      return { value: undefined, done: true };
    },
  };
  return { source, finishNext, returned: () => returned, calls: () => calls };
}

async function settlesWithin<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        // Query completion now waits for native process-tree cleanup too.
        // Allow its bounded OS deadline while still catching parked-input hangs.
        timer = setTimeout(() => resolve({ settled: false }), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("finishes after CLI exit even while the prompt producer is parked", async () => {
  const { root, file } = fixture(`import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})) {
  console.log(JSON.stringify({type:'result',result:JSON.parse(line).message.content}));
  process.exit(0);
}`);
  const input = parkedInput();
  const stream = query({ prompt: input.source, options: { cwd: root, cliModule: file } });
  let outcome: Awaited<ReturnType<typeof settlesWithin<IteratorResult<unknown>>>>;
  try {
    expect((await stream.next()).value?.result).toBe("first");
    outcome = await settlesWithin(stream.next());
  } finally {
    input.finishNext({ value: undefined, done: true });
    await stream.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(outcome.settled).toBe(true);
  expect(input.returned()).toBe(true);
});

it("return preempts a pending read and closes the prompt iterator without sending late input", async () => {
  const { root, file } = fixture(`import fs from 'node:fs';
import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})) {
  fs.appendFileSync('prompts',JSON.parse(line).message.content+'\\n');
  console.log(JSON.stringify({type:'system',subtype:'ready'}));
}`);
  const input = parkedInput();
  const stream = query({ prompt: input.source, options: { cwd: root, cliModule: file } });
  let outcome: Awaited<ReturnType<typeof settlesWithin<IteratorResult<unknown>>>>;
  try {
    expect((await stream.next()).value?.subtype).toBe("ready");
    const next = stream.next();
    const closed = stream.return(undefined);
    outcome = await settlesWithin(closed);
    input.finishNext({ value: "late", done: false });
    await next;
    await closed;
    expect(fs.readFileSync(path.join(root, "prompts"), "utf8")).toBe("first\n");
  } finally {
    input.finishNext({ value: undefined, done: true });
    await stream.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(outcome.settled).toBe(true);
  expect(input.returned()).toBe(true);
  expect(input.calls()).toBe(2);
});

it("rejects clean CLI exit when a submitted prompt never received a result", async () => {
  const { root, file } = fixture(`process.stdin.once('data',()=>process.exit(0));`);
  try {
    await expect(async () => {
      for await (const message of query({ prompt: "go", options: { cwd: root, cliModule: file } }))
        void message;
    }).rejects.toThrow(/before all query results/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  "correlated",
  "legacy",
])("%s duplicate results cannot complete a queued prompt", async (mode) => {
  const { root, file } = fixture(`import readline from 'node:readline';
const emit=frame=>console.log(JSON.stringify(frame));
const tagged=${mode === "correlated"};
if(tagged) emit({type:'system',subtype:'init',capabilities:{result_input_id:true}});
const prompts=[];
for await(const line of readline.createInterface({input:process.stdin})) {
  prompts.push(JSON.parse(line));
  if(prompts.length!==2) continue;
  const first={type:'result',uuid:'first-frame',result:'first',...(tagged&&{input_id:prompts[0].input_id})};
  if(tagged) emit({type:'result',input_id:prompts[1].input_id,result:'out of order'});
  emit(first);
  emit({...first,uuid:tagged?'duplicate-with-new-uuid':first.uuid});
  if(tagged) emit({type:'result',result:'untagged'});
  process.stdin.destroy();
  break;
}`);
  async function* prompts() {
    yield "first";
    yield "second";
  }
  const results: unknown[] = [];
  const diagnostics: unknown[] = [];
  try {
    await expect(async () => {
      for await (const frame of query({
        prompt: prompts(),
        options: { cwd: root, cliModule: file, signal: AbortSignal.timeout(10000) },
      })) {
        if (frame.type === "result") results.push(frame.result);
        if (frame.subtype === "invalid_protocol_message") diagnostics.push(frame);
      }
    }).rejects.toThrow("before all query results (1/2)");
    expect(results).toEqual(["first"]);
    expect(diagnostics).toHaveLength(mode === "correlated" ? 3 : 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves an input producer failure as the query error", async () => {
  const { root, file } = fixture(`process.stdin.resume();`);
  async function* prompts() {
    yield "first";
    throw new Error("producer failed with original detail");
  }
  try {
    await expect(async () => {
      for await (const message of query({
        prompt: prompts(),
        options: { cwd: root, cliModule: file },
      }))
        void message;
    }).rejects.toThrow("producer failed with original detail");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves even an undefined input producer rejection instead of reporting success", async () => {
  const { root, file } = fixture(`process.stdin.resume();`);
  async function* prompts(): AsyncGenerator<string> {
    yield "first";
    throw undefined;
  }
  try {
    await expect(async () => {
      for await (const message of query({
        prompt: prompts(),
        options: { cwd: root, cliModule: file },
      }))
        void message;
    }).rejects.toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("throw preempts a pending read and preserves the caller's error", async () => {
  const { root, file } = fixture(
    `process.stdin.once('data',()=>console.log(JSON.stringify({type:'system',subtype:'ready'})));`,
  );
  const input = parkedInput();
  const stream = query({ prompt: input.source, options: { cwd: root, cliModule: file } });
  try {
    await stream.next();
    const next = stream.next();
    const failed = stream
      .throw(new Error("consumer stopped with detail"))
      .catch((error: Error) => error);
    const outcome = await settlesWithin(failed);
    expect(outcome.settled).toBe(true);
    if (outcome.settled) expect(outcome.value).toEqual(new Error("consumer stopped with detail"));
    expect((await next).done).toBe(true);
    expect(input.returned()).toBe(true);
  } finally {
    input.finishNext({ value: undefined, done: true });
    await stream.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("external abort releases the parked input producer and preserves AbortError", async () => {
  const { root, file } = fixture(
    `process.stdin.once('data',()=>console.log(JSON.stringify({type:'system',subtype:'ready'})));`,
  );
  const input = parkedInput();
  const abort = new AbortController();
  const stream = query({
    prompt: input.source,
    options: { cwd: root, cliModule: file, signal: abort.signal },
  });
  try {
    await stream.next();
    abort.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(input.returned()).toBe(true);
  } finally {
    input.finishNext({ value: undefined, done: true });
    await stream.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not wait forever for a prompt iterator's uncooperative return", async () => {
  const { root, file } = fixture(
    `process.stdin.once('data',()=>console.log(JSON.stringify({type:'system',subtype:'ready'})));process.stdin.resume();`,
  );
  const input = parkedInput();
  input.source.return = () => new Promise(() => {});
  const stream = query({ prompt: input.source, options: { cwd: root, cliModule: file } });
  try {
    await stream.next();
    expect((await settlesWithin(stream.return(undefined))).settled).toBe(true);
  } finally {
    input.finishNext({ value: undefined, done: true });
    await stream.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("allows the CLI to finish normal EOF cleanup before sending termination signals", async () => {
  const { root, file } = fixture(`import fs from 'node:fs';import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})) {
  console.log(JSON.stringify({type:'result',result:'ready'}));
}
await new Promise(resolve=>setTimeout(resolve,50));fs.writeFileSync('cleanup','finished');`);
  const input = parkedInput();
  const stream = query({ prompt: input.source, options: { cwd: root, cliModule: file } });
  try {
    await stream.next();
    await stream.return(undefined);
    expect(fs.readFileSync(path.join(root, "cleanup"), "utf8")).toBe("finished");
  } finally {
    input.finishNext({ value: undefined, done: true });
    await stream.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not let EOF execute queued work when closing before pending results", async () => {
  const { root, file } = fixture(`import fs from 'node:fs';import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})) {
  console.log(JSON.stringify({type:'system',subtype:'ready'}));
}
fs.writeFileSync('queued-effect','executed after cancellation');`);
  async function* prompts() {
    yield "first";
    yield "queued";
  }
  const stream = query({ prompt: prompts(), options: { cwd: root, cliModule: file } });
  try {
    await stream.next();
    await stream.return(undefined);
    expect(fs.existsSync(path.join(root, "queued-effect"))).toBe(false);
  } finally {
    await stream.return(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
