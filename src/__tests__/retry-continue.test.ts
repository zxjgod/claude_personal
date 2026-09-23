// ============================================================
// Tests: continuation-style retry (M1) — CCR_RETRY_CONTINUE
// ============================================================
// A transient failure after substantial text (and no tool calls) on an
// OpenAI-compatible provider should COMMIT the partial output and nudge the
// model to continue, instead of discarding tokens the user already paid for.
// Default-off; Anthropic excluded (signed thinking cannot be resumed).
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import type { Message, ModelCaller, ModelConfig } from "../types.js";

const openaiConfig: ModelConfig = {
  provider: "openai",
  model: "gpt-test",
  apiKey: "k",
};

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Stream ≥1000 chars of text, then fail with a transient connection error. */
function failingThenContinuing(tail: string): ModelCaller & { calls: Message[][] } {
  const calls: Message[][] = [];
  let n = 0;
  const caller = async function* (messages: Message[]): AsyncGenerator<{
    type: string;
    delta?: string;
    error?: Error;
    usage?: unknown;
    finish_reason?: string;
  }> {
    calls.push(messages.map((m) => ({ ...m })));
    n++;
    if (n === 1) {
      yield { type: "text_delta", delta: "A".repeat(1500) };
      const e = new Error("socket hang up");
      (e as { code?: string }).code = "ECONNRESET";
      yield { type: "error", error: e };
      return;
    }
    yield { type: "text_delta", delta: tail };
    yield {
      type: "done",
      usage: { input_tokens: 1, output_tokens: 1 },
      finish_reason: "stop",
    };
  } as ModelCaller;
  return Object.assign(caller, { calls });
}

beforeEach(() => {
  process.env.CCR_RETRY_CONTINUE = undefined;
});

afterEach(() => {
  delete process.env.CCR_RETRY_CONTINUE;
});

describe("continuation retry (M1)", () => {
  it("commits the partial text and continues when enabled", async () => {
    process.env.CCR_RETRY_CONTINUE = "1";
    const caller = failingThenContinuing(" …and the conclusion.");
    for await (const _event of agentLoop(
      [userMsg("write a long answer")],
      [],
      caller,
      openaiConfig,
      {
        systemPrompt: "sys",
        maxTurns: 5,
      },
    )) {
      // drain
    }
    expect(caller.calls).toHaveLength(2);
    const second = caller.calls[1]!;
    // Partial text was committed as an assistant message before the retry.
    const partial = second.find((m) => m.role === "assistant" && m.content === "A".repeat(1500));
    expect(partial).toBeTruthy();
    // A continuation nudge follows it.
    const nudge = second[second.length - 1];
    expect(nudge?.role).toBe("user");
    const nudgeText = Array.isArray(nudge?.content)
      ? nudge.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : "";
    expect(nudgeText).toContain("Continue EXACTLY");
  });

  it("regenerates from scratch when the flag is off (default)", async () => {
    const caller = failingThenContinuing(" done.");
    for await (const _event of agentLoop(
      [userMsg("write a long answer")],
      [],
      caller,
      openaiConfig,
      {
        systemPrompt: "sys",
        maxTurns: 5,
      },
    )) {
      // drain
    }
    const second = caller.calls[1]!;
    expect(second.find((m) => m.role === "assistant")).toBeUndefined();
    expect(second).toHaveLength(1); // just the original user message
  });

  it("does not continue on the Anthropic provider even when enabled", async () => {
    process.env.CCR_RETRY_CONTINUE = "1";
    const anthropicConfig: ModelConfig = { ...openaiConfig, provider: "anthropic" };
    const caller = failingThenContinuing(" done.");
    for await (const _event of agentLoop([userMsg("hi")], [], caller, anthropicConfig, {
      systemPrompt: "sys",
      maxTurns: 5,
    })) {
      // drain
    }
    const second = caller.calls[1]!;
    expect(second.find((m) => m.role === "assistant")).toBeUndefined();
  });

  it("does not continue when a tool call already streamed", async () => {
    process.env.CCR_RETRY_CONTINUE = "1";
    const calls: Message[][] = [];
    let n = 0;
    const caller: ModelCaller = async function* (messages) {
      calls.push(messages.map((m) => ({ ...m })));
      n++;
      if (n === 1) {
        yield { type: "text_delta", delta: "B".repeat(1500) };
        yield { type: "tool_use", id: "t1", name: "read", input: { filePath: "a" } };
        const e = new Error("socket hang up");
        (e as { code?: string }).code = "ECONNRESET";
        yield { type: "error", error: e };
        return;
      }
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    for await (const _event of agentLoop([userMsg("hi")], [], caller, openaiConfig, {
      systemPrompt: "sys",
      maxTurns: 5,
    })) {
      // drain
    }
    const second = calls[1] ?? [];
    // No committed partial assistant text — tool side effects may have begun,
    // so the retry must regenerate cleanly.
    expect(
      second.find((m) => m.role === "assistant" && m.content === "B".repeat(1500)),
    ).toBeUndefined();
  });
});
