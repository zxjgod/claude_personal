import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import { autoCompact } from "../auto-compact.js";
import { WriteTool } from "../tools/core/write.js";
import type { Message, ModelCaller, ModelConfig } from "../types.js";

const config: ModelConfig = { provider: "custom", model: "fixture", apiKey: "unused" };
const lossySummary: ModelCaller = async function* () {
  yield {
    type: "text_delta",
    delta: "Work progressed. The pending operation should now be completed.",
  };
  yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
};
function toolHistory(): Message[] {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "Finish the parser fix; preserve all public exports." }],
    },
  ];
  for (let batch = 0; batch < 30; batch++) {
    const ids = [`${batch}-a`, `${batch}-b`];
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: ids.map((id) => ({
        id,
        type: "function",
        function: { name: "read", arguments: "{}" },
      })),
    });
    for (const id of ids)
      messages.push({
        role: "tool",
        tool_call_id: id,
        name: "read",
        content: `${id}: inspected parser.ts and preserved existing changes. `.repeat(30),
      });
  }
  return messages;
}
function assertToolPairs(messages: Message[]) {
  const outstanding = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      expect(outstanding.size).toBe(0);
      for (const call of message.tool_calls ?? []) outstanding.add(call.id);
    } else if (message.role === "tool") {
      expect(outstanding.delete(message.tool_call_id)).toBe(true);
    } else expect(outstanding.size).toBe(0);
  }
  expect(outstanding.size).toBe(0);
}

it("compresses consecutive parallel tool batches while preserving call/result pairing", async () => {
  const history = toolHistory();
  const result = await autoCompact(history, lossySummary, config);
  expect(result.length).toBeLessThan(history.length / 2);
  assertToolPairs(result);
});

it("preserves the latest human request across repeated lossy summaries and synthetic continuations", async () => {
  const history = toolHistory();
  const original = history[0];
  history.push({
    role: "user",
    synthetic: true,
    content: [{ type: "text", text: "Continue working." }],
  });
  const first = await autoCompact(history, lossySummary, config);
  expect(first.filter((message) => message === original)).toHaveLength(1);
  const second = await autoCompact([...first, ...toolHistory().slice(1)], lossySummary, config);
  expect(second.filter((message) => message === original)).toHaveLength(1);
  assertToolPairs(second);
});

it("uses the original task to choose an actual file operation after forced compression", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-context-continuity-"));
  try {
    fs.writeFileSync(path.join(root, "protected.json"), "do not overwrite");
    const history: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Write only result.txt with content completed; keep protected.json unchanged.",
          },
        ],
      },
    ];
    for (let i = 0; i < 35; i++)
      history.push(
        { role: "assistant", content: `Inspected file ${i}. `.repeat(30) },
        {
          role: "user",
          synthetic: true,
          content: [{ type: "text", text: `Background observation ${i}; continue.` }],
        },
      );
    let called = false;
    let sawTask = false;
    const caller: ModelCaller = async function* (messages) {
      if (!called) {
        called = true;
        sawTask = messages.some(
          (message) =>
            message.role === "user" &&
            !message.synthetic &&
            JSON.stringify(message.content).includes("Write only result.txt"),
        );
        yield {
          type: "tool_use",
          id: "write-result",
          name: "write",
          input: {
            filePath: path.join(root, sawTask ? "result.txt" : "protected.json"),
            content: "completed",
          },
          rawArguments: JSON.stringify({
            filePath: path.join(root, sawTask ? "result.txt" : "protected.json"),
            content: "completed",
          }),
        };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
      } else {
        yield { type: "text_delta", delta: "completed" };
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
      }
    };
    const events = [];
    for await (const event of agentLoop(history, [WriteTool], caller, config, {
      systemPrompt: "",
      maxTurns: 3,
      autoCompactThreshold: 100,
      fastModel: { callModel: lossySummary, modelConfig: config },
      toolContext: {
        workspaceRoot: root,
        sessionId: `continuity-${path.basename(root)}`,
        permissionMode: "acceptEdits",
      },
    }))
      events.push(event.type);
    expect(events).toContain("compacted");
    expect(sawTask).toBe(true);
    expect(fs.readFileSync(path.join(root, "result.txt"), "utf8")).toBe("completed");
    expect(fs.readFileSync(path.join(root, "protected.json"), "utf8")).toBe("do not overwrite");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps recent human corrections and earlier constraints in order across lossy compactions", async () => {
  const history = toolHistory();
  const original = history[0];
  const correction: Message = {
    role: "user",
    content: [{ type: "text", text: "Use truncation for the amount calculation instead." }],
  };
  history.splice(40, 0, correction); // Between complete tool batches.
  const first = await autoCompact(history, lossySummary, config);
  const second = await autoCompact([...first, ...toolHistory().slice(1)], lossySummary, config);
  expect(second.filter((message) => message.role === "user" && !message.synthetic)).toEqual([
    original,
    correction,
  ]);
  assertToolPairs(second);
});

it("does not copy older attachments, oversized requests or user messages already in the tail", async () => {
  const history = toolHistory();
  const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
  const older = user("Earlier request already summarized");
  const oversized = user("x".repeat(12_001));
  const image: Message = {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } },
    ],
  };
  const latest = user("One last detail");
  history.splice(0, 0, older, oversized, image);
  history.splice(3, 1);
  history.push(latest);
  const result = await autoCompact(history, lossySummary, config);
  expect(result.filter((message) => message.role === "user")).toEqual([latest]);
  assertToolPairs(result);
});

it("does not commit a partial summary or start fallback after cancellation", async () => {
  const controller = new AbortController();
  const history = toolHistory();
  // Plain assistant text ensures the old implementation attempts a summary.
  history.splice(1, 0, { role: "assistant", content: "Started investigation." });
  const before = structuredClone(history);
  let fallbacks = 0;
  const fallback: ModelCaller = async function* () {
    fallbacks++;
    yield* lossySummary([], [], "", config);
  };
  const cancelled: ModelCaller = async function* () {
    controller.abort(new Error("summary cancelled"));
    yield { type: "text_delta", delta: "partial summary" };
  };
  await expect(
    autoCompact(history, fallback, config, controller.signal, {
      callModel: cancelled,
      modelConfig: config,
    }),
  ).rejects.toThrow("summary cancelled");
  expect(fallbacks).toBe(0);
  expect(history).toEqual(before);
});

it("does not start another task model call after cancellation during compression", async () => {
  const controller = new AbortController();
  let taskCalls = 0;
  const caller: ModelCaller = async function* () {
    taskCalls++;
    yield* lossySummary([], [], "", config);
  };
  const cancelled: ModelCaller = async function* () {
    controller.abort(new Error("summary cancelled"));
    yield { type: "text_delta", delta: "partial" };
  };
  for await (const _event of agentLoop(toolHistory(), [], caller, config, {
    systemPrompt: "",
    maxTurns: 2,
    autoCompactThreshold: 100,
    abortSignal: controller.signal,
    fastModel: { callModel: cancelled, modelConfig: config },
  })) {
    /* drain */
  }
  expect(taskCalls).toBe(0);
});
