import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { parseCliArgs } from "../cli-args.js";
import { headlessInputs, runHeadless } from "../headless.js";
import type { Message, ModelCaller } from "../types.js";

afterEach(() => {
  process.exitCode = 0;
});
it("delivers stream input before EOF and reports malformed input", async () => {
  const input = new PassThrough();
  const iterator = headlessInputs(parseCliArgs(["-p", "--input-format", "stream-json"]), input);
  const next = iterator.next();
  input.write(
    `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "live" }] } })}\n`,
  );
  expect(await next).toEqual({ done: false, value: "live" });
  input.end("malformed\n");
  await expect(iterator.next()).rejects.toThrow();
});
it("emits stable session results, validates structured output, and saves the conversation", async () => {
  const messages: Message[] = [];
  const emitted: string[] = [];
  const save = vi.fn(async () => {});
  const caller: ModelCaller = async function* () {
    yield { type: "text_delta", delta: '{"count":2}' };
    yield { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, finish_reason: "stop" };
  };
  await runHeadless({
    args: parseCliArgs([
      "-p",
      "fixture",
      "--output-format",
      "stream-json",
      "--json-schema",
      '{"type":"object","required":["count"],"properties":{"count":{"type":"integer"}}}',
    ]),
    input: Readable.from([]),
    emit: (value) => emitted.push(value),
    messages,
    tools: [],
    callModel: caller,
    config: { provider: "custom", model: "fixture", apiKey: "unused" },
    context: { workspaceRoot: process.cwd(), sessionId: "headless-probe", permissionMode: "plan" },
    save,
    systemPrompt: "",
  });
  const events = emitted.map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({ type: "system", subtype: "init" });
  expect(events.at(-1)).toMatchObject({
    type: "result",
    session_id: "headless-probe",
    is_error: false,
    structured_output: { count: 2 },
  });
  expect(save).toHaveBeenCalledOnce();
  expect(messages.some((message) => message.role === "assistant")).toBe(true);
});

const okCaller: ModelCaller = async function* () {
  yield { type: "text_delta", delta: "ok" };
  yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
};

function headlessDeps(overrides: {
  argv: string[];
  input: NodeJS.ReadableStream;
  emitted: string[];
  save?: (messages: Message[]) => Promise<void>;
}) {
  const messages: Message[] = [];
  return {
    args: parseCliArgs(overrides.argv),
    input: overrides.input,
    emit: (value: string) => overrides.emitted.push(value),
    messages,
    tools: [],
    callModel: okCaller,
    config: { provider: "custom" as const, model: "fixture", apiKey: "unused" },
    context: {
      workspaceRoot: process.cwd(),
      sessionId: "headless-fix",
      permissionMode: "plan" as const,
    },
    save: overrides.save ?? (async () => {}),
    systemPrompt: "",
  };
}

it("still emits the result frame when the session save fails", async () => {
  const emitted: string[] = [];
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runHeadless(
      headlessDeps({
        argv: ["-p", "hi", "--output-format", "stream-json"],
        input: Readable.from([]),
        emitted,
        save: async () => {
          throw new Error("disk full");
        },
      }),
    );
  } finally {
    errSpy.mockRestore();
  }
  const result = emitted.map((l) => JSON.parse(l)).find((e) => e.type === "result");
  expect(result).toMatchObject({ is_error: false, result: "ok" });
  expect(process.exitCode ?? 0).toBe(0);
});

it("emits a terminal error result frame for a malformed stream-json input line", async () => {
  const emitted: string[] = [];
  const input = new PassThrough();
  const run = runHeadless(
    headlessDeps({
      argv: ["-p", "hi", "--input-format", "stream-json", "--output-format", "stream-json"],
      input,
      emitted,
    }),
  );
  input.end("not-json\n");
  await run; // must NOT reject — the protocol terminates with an error frame
  // The "-p hi" prompt ran first (success frame); the malformed line's frame
  // is the ERROR one.
  const frames = emitted.map((l) => JSON.parse(l)).filter((e) => e.type === "result");
  const errorFrame = frames.find((e) => e.is_error);
  expect(errorFrame).toMatchObject({ subtype: "error_during_execution" });
  expect(process.exitCode).toBe(1);
});

it("json output mode emits ONE document even with multiple prompts", async () => {
  const emitted: string[] = [];
  // Multi-prompt input: two stream-json user lines (text-mode stdin is only
  // read when -p is absent, and even then it's a single prompt).
  const line = (text: string) =>
    `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
  await runHeadless(
    headlessDeps({
      argv: ["--input-format", "stream-json", "--output-format", "json"],
      input: Readable.from([`${line("first")}${line("second")}`]),
      emitted,
    }),
  );
  expect(emitted.length).toBe(1);
  const doc = JSON.parse(emitted[0]!);
  expect(Array.isArray(doc)).toBe(true);
  expect(doc).toHaveLength(2);
  expect(doc[0]).toMatchObject({ type: "result", is_error: false });
});

it("json output mode with a single prompt stays a bare object", async () => {
  const emitted: string[] = [];
  await runHeadless(
    headlessDeps({
      argv: ["-p", "only", "--output-format", "json"],
      input: Readable.from([]),
      emitted,
    }),
  );
  expect(emitted.length).toBe(1);
  const doc = JSON.parse(emitted[0]!);
  expect(doc).toMatchObject({ type: "result", is_error: false, result: "ok" });
});

it("a malformed --json-schema still terminates the stream-json protocol", async () => {
  // Pre-flight flag validation used to throw before the guarded section, so the
  // process died with a stack trace and a consumer reading frames waited for a
  // result that never came.
  const emitted: string[] = [];
  await expect(
    runHeadless(
      headlessDeps({
        argv: ["-p", "x", "--output-format", "stream-json", "--json-schema", "{not json"],
        input: Readable.from([]),
        emitted,
      }),
    ),
  ).rejects.toThrow();
  const frames = emitted.map((line) => JSON.parse(line));
  expect(frames.at(-1)).toMatchObject({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
  });
  expect(process.exitCode).toBe(1);
});

it("a non-positive --max-budget-usd still terminates the protocol", async () => {
  const emitted: string[] = [];
  await expect(
    runHeadless(
      headlessDeps({
        argv: ["-p", "x", "--output-format", "stream-json", "--max-budget-usd", "0"],
        input: Readable.from([]),
        emitted,
      }),
    ),
  ).rejects.toThrow(/max-budget-usd/);
  expect(JSON.parse(emitted.at(-1)!)).toMatchObject({ type: "result", is_error: true });
});
