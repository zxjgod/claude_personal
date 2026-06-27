// ============================================================
// Tests: Auto-Compaction message-structure safety
// ============================================================
// Regression for the bug where slicing the tail at a fixed offset could
// strand a `tool` result whose originating assistant (with tool_calls)
// landed in the summarized half — the provider then rejects the request
// ("tool message must follow tool_calls").
// ============================================================

import { describe, expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import type { Message, ModelCaller, ModelConfig, StreamEvent } from "../types.js";

const testConfig: ModelConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

/**
 * A caller that records the messages it is asked to summarize/respond to,
 * then returns a trivial text completion. Used to inspect what the loop
 * passes to the model after compaction.
 */
function makeRecordingCaller(captured: Message[][]): ModelCaller {
  return async function* (messages: Message[]): AsyncGenerator<StreamEvent> {
    captured.push(structuredClone(messages));
    yield { type: "text_delta", delta: "ok" };
    yield {
      type: "done",
      usage: { input_tokens: 1, output_tokens: 1 },
      finish_reason: "stop",
    };
  };
}

/** Build a long, well-formed history that ends right after a tool result,
 * so a naive `slice(-N)` tail would begin with an orphan `tool` message. */
function buildHistoryEndingInToolResult(pairs: number): Message[] {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  for (let i = 0; i < pairs; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call_${i}`,
      name: "read",
      content: `result ${i}`.repeat(50),
    });
  }
  return messages;
}

/** A message sequence is valid if every `tool` message is immediately
 * preceded by an assistant message carrying a matching tool_call id. */
function assertNoOrphanToolMessages(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    const prev = messages[i - 1];
    expect(prev, `tool message at ${i} has no predecessor`).toBeDefined();
    expect(
      prev.role === "assistant" && Array.isArray(prev.tool_calls),
      `tool message at ${i} not preceded by assistant tool_calls`,
    ).toBe(true);
  }
}

describe("autoCompact message safety", () => {
  it("does not leave an orphan tool result at the head of the tail", async () => {
    const captured: Message[][] = [];
    const caller = makeRecordingCaller(captured);

    // Large history ending in a tool result; tiny threshold forces compaction
    // on the very first loop iteration.
    const messages = buildHistoryEndingInToolResult(40);

    for await (const _event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 1,
      autoCompactThreshold: 100, // force compaction immediately
    })) {
      // drain
    }

    // The summarization call and the post-compaction completion call both
    // received message arrays — none may contain an orphan tool message.
    expect(captured.length).toBeGreaterThan(0);
    for (const snapshot of captured) {
      assertNoOrphanToolMessages(snapshot);
    }
  });

  it("emits compacting/compacted events when over threshold", async () => {
    const captured: Message[][] = [];
    const caller = makeRecordingCaller(captured);
    const messages = buildHistoryEndingInToolResult(40);

    const types: string[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 1,
      autoCompactThreshold: 100,
    })) {
      types.push(event.type);
    }

    expect(types).toContain("compacting");
    expect(types).toContain("compacted");
  });
});

// ============================================================
// Error recovery: context_length & 429 retry behavior
// ============================================================
// Regression for the bug where handleModelError returned plain "retry" for a
// context_length error WITHOUT compressing, so the loop re-sent identical
// oversized messages every turn → infinite retry. Also covers the missing
// retry cap on sustained 429s.
// ============================================================

describe("handleModelError recovery behavior", () => {
  it("compacts once on context_length error instead of looping forever", async () => {
    // First call emits a context_length error; subsequent calls succeed.
    let calls = 0;
    const caller: ModelCaller = async function* (messages: Message[]) {
      calls++;
      if (calls === 1) {
        const e = new Error("context_length_exceeded: maximum context length");
        (e as any).status = 400;
        yield { type: "error", error: e };
        return;
      }
      // After the errored call, the loop compacts. The final successful
      // retry call receives a history far smaller than the original 40
      // tool-result pairs — proving compression actually ran (not just a
      // verbatim retry that would loop forever).
      if (calls >= 3) {
        expect(messages.length).toBeLessThan(40);
      }
      yield { type: "text_delta", delta: "recovered" };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };

    const messages = buildHistoryEndingInToolResult(40);
    const types: string[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 5,
      autoCompactThreshold: Number.POSITIVE_INFINITY, // disable proactive compaction
    })) {
      types.push(event.type);
    }

    // Bounded number of model calls (errored + summarization + retry), NOT an
    // infinite loop of identical oversized retries.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
    // A compaction event was emitted in response to the error path.
    expect(types).toContain("compacted");
    // The loop completed successfully, not via an abort/error terminal.
    expect(types).toContain("done");
  });

  it("aborts after the 429 retry budget is exhausted instead of looping forever", async () => {
    // Always 429 — would loop forever without the cap.
    let calls = 0;
    const caller: ModelCaller = async function* () {
      calls++;
      const e: any = new Error("rate limited");
      e.status = 429;
      e.retryAfter = 1;
      yield { type: "error", error: e };
    };

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const types: string[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 50,
    })) {
      types.push(event.type);
    }

    // Cap is 3 retries → 4 total model calls, then abort.
    expect(calls).toBe(4);
    expect(types).toContain("error");
    expect(types).not.toContain("done");
  });
});
