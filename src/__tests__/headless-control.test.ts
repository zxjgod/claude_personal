import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { parseCliArgs } from "../cli-args.js";
import { runHeadless } from "../headless.js";
import type { Message, ModelCaller, ModelConfig, Tool, ToolContext } from "../types.js";

afterEach(() => {
  process.exitCode = 0;
});

const STDIO_FLAGS = [
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--permission-prompt-tool",
  "stdio",
];
const STREAM_FLAGS = ["--input-format", "stream-json", "--output-format", "stream-json"];

function probeTool(calls: Record<string, unknown>[]): Tool {
  return {
    name: "probe",
    description: "probe tool",
    promptDescription: "probe",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    isEnabled: () => true,
    isReadOnly: () => false,
    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    validateInput: (input) => {
      if (typeof input.value !== "string") throw new Error("value must be a string");
      return { value: input.value };
    },
    checkPermissions: async () => ({ allowed: true }),
    call: async (input) => {
      calls.push(input);
      return { content: `ran:${input.value}` };
    },
    formatResult: (result) => result.content,
  };
}

/** A bash-named tool whose recursive-delete command hits the catastrophic
 *  dangerous pattern, so the ask fires on the Step-3b safety floor (not the
 *  Step-6 standard ask). */
function dangerousBashTool(calls: Record<string, unknown>[]): Tool {
  return {
    ...probeTool(calls),
    name: "bash",
    promptDescription: "bash",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    validateInput: (input) => {
      if (typeof input.command !== "string") throw new Error("command must be a string");
      return { command: input.command };
    },
  };
}

/** First model call requests the tool (batch path via rawArguments), second answers. */
function toolCaller(input: Record<string, unknown>, toolName = "probe"): ModelCaller {
  let called = false;
  return async function* () {
    if (!called) {
      called = true;
      yield {
        type: "tool_use",
        id: "call-1",
        name: toolName,
        input,
        rawArguments: JSON.stringify(input),
      };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "tool_calls",
      };
    } else {
      yield { type: "text_delta", delta: "finished" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    }
  };
}

const okCaller: ModelCaller = async function* () {
  yield { type: "text_delta", delta: "ok" };
  yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
};

function harness(opts: { argv: string[]; caller: ModelCaller; tools: Tool[] }) {
  const input = new PassThrough();
  const emitted: string[] = [];
  const messages: Message[] = [];
  const config: ModelConfig = { provider: "custom", model: "fixture", apiKey: "unused" };
  const context: ToolContext = {
    workspaceRoot: process.cwd(),
    sessionId: "control-test",
    permissionMode: "default",
  };
  const run = runHeadless({
    args: parseCliArgs(opts.argv),
    input,
    emit: (value) => emitted.push(value),
    messages,
    tools: opts.tools,
    callModel: opts.caller,
    config,
    context,
    save: async () => {},
    systemPrompt: "",
  });
  const frames = () => emitted.map((line) => JSON.parse(line));
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  const userLine = (text: string) =>
    send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  return { input, run, frames, send, userLine, context, config, messages };
}

function permissionRequest(frames: ReturnType<ReturnType<typeof harness>["frames"]>) {
  return frames.find(
    (frame) => frame.type === "control_request" && frame.request?.subtype === "can_use_tool",
  );
}

it("routes permission asks through can_use_tool and executes on allow", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STDIO_FLAGS,
    caller: toolCaller({ value: "original" }),
    tools: [probeTool(calls)],
  });
  h.userLine("go");
  await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
  const request = permissionRequest(h.frames())!;
  expect(request.request.tool_name).toBe("probe");
  expect(request.request.input).toEqual({ value: "original" });
  h.send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: request.request_id,
      response: { behavior: "allow" },
    },
  });
  h.input.end();
  await h.run;
  expect(calls).toEqual([{ value: "original" }]);
  expect(h.frames().find((frame) => frame.type === "result")?.is_error).toBe(false);
});

it("applies updatedInput from the approval response before execution", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STDIO_FLAGS,
    caller: toolCaller({ value: "original" }),
    tools: [probeTool(calls)],
  });
  h.userLine("go");
  await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
  h.send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: permissionRequest(h.frames())!.request_id,
      response: { behavior: "allow", updatedInput: { value: "rewritten" } },
    },
  });
  h.input.end();
  await h.run;
  expect(calls).toEqual([{ value: "rewritten" }]);
});

it("honors updatedInput on the dangerous-pattern safety-floor ask", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STDIO_FLAGS,
    caller: toolCaller({ command: "rm -rf /tmp/target" }, "bash"),
    tools: [dangerousBashTool(calls)],
  });
  h.userLine("go");
  await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
  const request = permissionRequest(h.frames())!;
  expect(request.request.tool_name).toBe("bash");
  expect(request.request.input).toEqual({ command: "rm -rf /tmp/target" });
  h.send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: request.request_id,
      response: { behavior: "allow", updatedInput: { command: "echo rewritten" } },
    },
  });
  h.input.end();
  await h.run;
  // The rewrite survived the safety-floor recheck (the central permission
  // check re-ran against the rewritten command) and is what executed.
  expect(calls).toEqual([{ command: "echo rewritten" }]);
});

it("denies execution when the approval response denies", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STDIO_FLAGS,
    caller: toolCaller({ value: "x" }),
    tools: [probeTool(calls)],
  });
  h.userLine("go");
  await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
  h.send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: permissionRequest(h.frames())!.request_id,
      response: { behavior: "deny", message: "not allowed" },
    },
  });
  h.input.end();
  await h.run;
  expect(calls).toEqual([]);
  const toolResult = h
    .frames()
    .find((frame) => frame.type === "user" && frame.message?.content?.[0]?.type === "tool_result");
  expect(toolResult?.message.content[0].is_error).toBe(true);
});

it("fails parked approvals closed when stdin reaches EOF unanswered", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STDIO_FLAGS,
    caller: toolCaller({ value: "x" }),
    tools: [probeTool(calls)],
  });
  h.userLine("go");
  await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
  h.input.end(); // EOF without a control_response must not hang the turn
  await h.run;
  expect(calls).toEqual([]);
  expect(h.frames().find((frame) => frame.type === "result")).toBeDefined();
});

it.each([
  undefined,
  "unexpected",
])("rejects an approval envelope with subtype %s even when its payload says allow", async (subtype) => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STDIO_FLAGS,
    caller: toolCaller({ value: "unapproved" }),
    tools: [probeTool(calls)],
  });
  h.userLine("go");
  await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
  h.send({
    type: "control_response",
    response: {
      subtype,
      request_id: permissionRequest(h.frames())?.request_id,
      response: { behavior: "allow" },
    },
  });
  h.input.end();
  await h.run;
  expect(calls).toEqual([]);
  const result = h
    .frames()
    .find((frame) => frame.type === "user" && frame.message?.content?.[0]?.type === "tool_result");
  expect(result?.message.content[0].is_error).toBe(true);
});

it("interrupts a parked approval, ignores its late allow, and approves the next turn", async () => {
  const calls: Record<string, unknown>[] = [];
  let call = 0;
  const caller: ModelCaller = async function* () {
    call++;
    if (call <= 2) {
      yield {
        type: "tool_use",
        id: `call-${call}`,
        name: "probe",
        input: { value: `turn-${call}` },
        rawArguments: JSON.stringify({ value: `turn-${call}` }),
      };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "tool_calls",
      };
    } else {
      yield { type: "text_delta", delta: "ok" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    }
  };
  const h = harness({ argv: STDIO_FLAGS, caller, tools: [probeTool(calls)] });
  try {
    h.userLine("first");
    await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
    const first = permissionRequest(h.frames());
    h.send({ type: "control_request", request_id: "cancel", request: { subtype: "interrupt" } });
    await vi.waitFor(() =>
      expect(h.frames().filter((frame) => frame.type === "result")).toHaveLength(1),
    );
    expect(h.frames().find((frame) => frame.type === "result")?.is_error).toBe(true);
    expect(calls).toEqual([]);
    h.userLine("second");
    await vi.waitFor(() =>
      expect(h.frames().filter((frame) => frame.type === "control_request")).toHaveLength(2),
    );
    const second = h.frames().filter((frame) => frame.type === "control_request")[1];
    const approve = (requestId: string) =>
      h.send({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: { behavior: "allow" } },
      });
    approve(first.request_id);
    h.send({ type: "control_request", request_id: "barrier", request: { subtype: "initialize" } });
    await vi.waitFor(() =>
      expect(h.frames().some((frame) => frame.response?.request_id === "barrier")).toBe(true),
    );
    expect(calls).toEqual([]);
    approve(second.request_id);
    h.input.end();
    await h.run;
    expect(calls).toEqual([{ value: "turn-2" }]);
    expect(
      h
        .frames()
        .filter((frame) => frame.type === "result")
        .map((frame) => frame.is_error),
    ).toEqual([true, false]);
    expect(process.exitCode).toBe(0);
  } finally {
    h.input.end();
    await h.run;
  }
});

it("auto-denies without --permission-prompt-tool and emits no approval frames", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STREAM_FLAGS,
    caller: toolCaller({ value: "x" }),
    tools: [probeTool(calls)],
  });
  h.userLine("go");
  h.input.end();
  await h.run;
  expect(calls).toEqual([]);
  expect(permissionRequest(h.frames())).toBeUndefined();
  expect(h.frames().find((frame) => frame.type === "result")).toBeDefined();
});

it("interrupts a running turn and still emits the result frame", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const caller: ModelCaller = async function* (_messages, _tools, _prompt, _config, signal) {
    markStarted();
    yield { type: "text_delta", delta: "working" };
    // Real adapters raise AbortError when the signal fires mid-stream.
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const h = harness({ argv: STREAM_FLAGS, caller, tools: [] });
  h.userLine("go");
  await started;
  h.send({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } });
  h.input.end();
  await h.run;
  const ack = h
    .frames()
    .find((frame) => frame.type === "control_response" && frame.response?.request_id === "int-1");
  expect(ack?.response.subtype).toBe("success");
  const result = h.frames().find((frame) => frame.type === "result");
  expect(result?.is_error).toBe(true);
  // A clean interrupt must not poison the process exit code: a non-zero exit
  // after the result frame makes the SDK emit a spurious abnormal_exit frame.
  expect(process.exitCode).toBe(0);
});

it("shutdown closes an idle input stream without waiting for EOF", async () => {
  const h = harness({ argv: STREAM_FLAGS, caller: okCaller, tools: [] });
  h.send({
    type: "control_request",
    request_id: "shutdown-idle",
    request: { subtype: "shutdown" },
  });
  await h.run;
  expect(h.input.destroyed).toBe(true);
  expect(
    h.frames().find((frame) => frame.response?.request_id === "shutdown-idle")?.response.subtype,
  ).toBe("success");
  expect(h.frames().filter((frame) => frame.type === "result")).toEqual([]);
});

it("shutdown cancels a parked approval and discards queued and buffered user input", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness({
    argv: STDIO_FLAGS,
    caller: toolCaller({ value: "must not run" }),
    tools: [probeTool(calls)],
  });
  h.userLine("first");
  await vi.waitFor(() => expect(permissionRequest(h.frames())).toBeDefined());
  const approval = permissionRequest(h.frames());
  h.userLine("queued");
  h.input.write(
    `${[
      { type: "control_request", request_id: "shutdown-active", request: { subtype: "shutdown" } },
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: approval?.request_id,
          response: { behavior: "allow" },
        },
      },
      { type: "user", message: { role: "user", content: "buffered" } },
    ]
      .map((frame) => JSON.stringify(frame))
      .join("\n")}\n`,
  );
  await h.run;
  expect(calls).toEqual([]);
  expect(h.messages.filter((message) => message.role === "user")).toHaveLength(1);
  const results = h.frames().filter((frame) => frame.type === "result");
  expect(results).toHaveLength(1);
  expect(results[0].is_error).toBe(true);
  expect(process.exitCode).toBe(0);
});

it("answers initialize/set_model/set_permission_mode and rejects unknown subtypes", async () => {
  const h = harness({ argv: STREAM_FLAGS, caller: okCaller, tools: [] });
  h.send({ type: "control_request", request_id: "i", request: { subtype: "initialize" } });
  h.send({
    type: "control_request",
    request_id: "m",
    request: { subtype: "set_model", model: "other" },
  });
  h.send({
    type: "control_request",
    request_id: "p",
    request: { subtype: "set_permission_mode", mode: "acceptEdits" },
  });
  h.send({ type: "control_request", request_id: "bad", request: { subtype: "nope" } });
  h.send({
    type: "control_request",
    request_id: "badmode",
    request: { subtype: "set_permission_mode", mode: "root" },
  });
  h.send({
    type: "control_request",
    request_id: "reset",
    request: { subtype: "set_model" },
  });
  h.send({
    type: "control_request",
    request_id: "blank",
    request: { subtype: "set_model", model: "  " },
  });
  h.input.end();
  await h.run;
  const responses = Object.fromEntries(
    h
      .frames()
      .filter((frame) => frame.type === "control_response")
      .map((frame) => [frame.response.request_id, frame.response]),
  );
  expect(responses.i.subtype).toBe("success");
  expect(responses.i.response.models).toContain("fixture");
  expect(responses.m.subtype).toBe("success");
  expect(responses.p.subtype).toBe("success");
  expect(responses.bad.subtype).toBe("error");
  expect(responses.badmode.subtype).toBe("error");
  // Resets and blanks are answered with an error frame, never a silent no-op.
  expect(responses.reset.subtype).toBe("error");
  expect(responses.reset.error).toMatch(/resetting the default model is not supported/);
  expect(responses.blank.subtype).toBe("error");
  expect(h.config.model).toBe("other");
  expect(h.context.permissionMode).toBe("acceptEdits");
});

it("reports unknown cost after set_model switches to an unpriced model", async () => {
  const h = harness({ argv: STREAM_FLAGS, caller: okCaller, tools: [] });
  // Priced model first, then an unpriced one: the cost estimate must drop to
  // unknown (null), not keep accruing at the previous model's rates.
  h.send({
    type: "control_request",
    request_id: "priced",
    request: { subtype: "set_model", model: "claude-opus-4-8" },
  });
  h.send({
    type: "control_request",
    request_id: "unpriced",
    request: { subtype: "set_model", model: "fixture" },
  });
  h.userLine("go");
  h.input.end();
  await h.run;
  const result = h.frames().find((frame) => frame.type === "result");
  expect(result?.total_cost_usd).toBeNull();
});

it("rejects non-stdio permission prompt tools with a terminal error frame", async () => {
  const h = harness({
    argv: [...STREAM_FLAGS, "--permission-prompt-tool", "mcp__permissions__approve"],
    caller: okCaller,
    tools: [],
  });
  h.input.end();
  await expect(h.run).rejects.toThrow(/only "stdio" is supported/);
  const result = h.frames().find((frame) => frame.type === "result");
  expect(result?.is_error).toBe(true);
});

it("requires stream-json io for --permission-prompt-tool stdio", async () => {
  const h = harness({
    argv: ["--output-format", "stream-json", "--permission-prompt-tool", "stdio"],
    caller: okCaller,
    tools: [],
  });
  h.input.end();
  await expect(h.run).rejects.toThrow(/requires --input-format stream-json/);
});

it("processes queued user messages as sequential turns", async () => {
  const h = harness({ argv: STREAM_FLAGS, caller: okCaller, tools: [] });
  h.userLine("first");
  h.userLine("second");
  h.input.end();
  await h.run;
  const results = h.frames().filter((frame) => frame.type === "result");
  expect(results).toHaveLength(2);
  expect(results.every((result) => result.is_error === false)).toBe(true);
  expect(h.messages.filter((message) => message.role === "user")).toHaveLength(2);
});
