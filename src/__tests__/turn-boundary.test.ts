// ============================================================
// Tests: Synthetic injections vs. checkpoint boundaries (M4)
// ============================================================
// Continuations of the CURRENT turn (length nudges, stop-hook errors,
// notifications, tool-result images) must not consume a checkpoint boundary:
// each boundary costs a turn number, a statSync per tracked file, and a slot
// in the 100-snapshot rewind window. Real queued user input still does.
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import { listTurns, resetAllCheckpoints } from "../checkpoint.js";
import type { Message, ModelCaller, ModelConfig, ToolContext } from "../types.js";

const testConfig: ModelConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

const ctx = (sessionId: string): ToolContext => ({
  workspaceRoot: process.cwd(),
  sessionId,
  permissionMode: "default",
  modelConfig: testConfig,
});

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

afterEach(() => {
  resetAllCheckpoints();
});

describe("synthetic injections do not open checkpoint boundaries", () => {
  it("a finish_reason=length continuation creates no boundary", async () => {
    let calls = 0;
    const caller: ModelCaller = async function* () {
      calls++;
      if (calls === 1) {
        yield { type: "text_delta", delta: "partial answer" };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 5 },
          finish_reason: "length",
        };
        return;
      }
      yield { type: "text_delta", delta: " done" };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 5 },
        finish_reason: "stop",
      };
    };
    for await (const _event of agentLoop([userMsg("hi")], [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 5,
      toolContext: ctx("m4-length"),
    })) {
      // drain
    }
    expect(calls).toBe(2);
    expect(listTurns("m4-length")).toHaveLength(0);
  });

  it("a background notification injection creates no boundary", async () => {
    let calls = 0;
    const notifications: string[] = ["job-1 finished"];
    const caller: ModelCaller = async function* () {
      calls++;
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    for await (const _event of agentLoop([userMsg("hi")], [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 5,
      toolContext: ctx("m4-notify"),
      drainNotifications: () => notifications.splice(0),
    })) {
      // drain
    }
    // First turn ended, notification was injected, second turn answered.
    expect(calls).toBe(2);
    expect(listTurns("m4-notify")).toHaveLength(0);
  });
});

describe("queued input still opens checkpoint boundaries", () => {
  it("a drained queued user message creates exactly one boundary", async () => {
    let calls = 0;
    let queued: string[] = [];
    const caller: ModelCaller = async function* () {
      calls++;
      if (calls === 1) queued = ["follow-up question"]; // prime before the end-turn drain
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    for await (const _event of agentLoop([userMsg("hi")], [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 5,
      toolContext: ctx("m4-queued"),
      drainQueuedInput: () => queued.splice(0),
    })) {
      // drain
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(listTurns("m4-queued")).toHaveLength(1);
  });
});
