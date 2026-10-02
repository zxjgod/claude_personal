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
