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
import { autoCompact } from "../auto-compact.js";
import { handleModelError, isFallbackableModelError } from "../error-recovery.js";
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

// ============================================================
// M31: light-to-heavy compaction pipeline
// ============================================================

describe("M31 compaction pipeline", () => {
  it("returns blocking_limit when autoCompact is disabled and over the hard limit", async () => {
    // A small caller that would succeed — but the loop should refuse to call it
    // because the prepared context exceeds contextHardLimit with autoCompact off.
    let modelCalled = false;
    const caller: ModelCaller = async function* () {
      modelCalled = true;
      yield { type: "text_delta", delta: "ok" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };

    // ~80 pairs × ~2500 chars ≈ 200k tool chars ≈ 50k tokens. The recent window
    // the cheap layers must leave intact keeps it over a low hard limit.
    const messages = buildHistoryEndingInToolResult(80);
    const types: string[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 3,
      autoCompactThreshold: Number.POSITIVE_INFINITY, // disable autoCompact
      contextHardLimit: 1000, // tiny ceiling → blocked
    })) {
      types.push(event.type);
    }

    expect(modelCalled).toBe(false);
    expect(types).toContain("error");
    expect(types).not.toContain("done");
  });

  it("runs the cheap layers (compacted notes) before calling the model when over threshold", async () => {
    const captured: Message[][] = [];
    const caller = makeRecordingCaller(captured);
    const messages = buildHistoryEndingInToolResult(40);

    const compactedSummaries: string[] = [];
    for await (const event of agentLoop(messages, [], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 1,
      // Above the cheap-layer trigger but autoCompact still enabled.
      autoCompactThreshold: 100,
    })) {
      if (event.type === "compacted") compactedSummaries.push(event.summary);
    }

    // At least one cheap-layer note or the autoCompact note fired.
    expect(compactedSummaries.length).toBeGreaterThan(0);
    // The model received a window with no orphan tool messages.
    for (const snapshot of captured) assertNoOrphanToolMessages(snapshot);
  });

  it("estimates context from reported usage without re-tokenizing the full history", async () => {
    // The model reports a HUGE prompt token usage on turn 1. Even though the raw
    // message chars are tiny, the usage baseline should carry that figure into
    // the next turn's estimate — so with a threshold below the reported usage,
    // turn 2 triggers compaction despite a small char count.
    let turn = 0;
    const caller: ModelCaller = async function* () {
      turn++;
      if (turn === 1) {
        // Ask for a tool so the loop continues to a second turn.
        yield { type: "tool_use", id: "c1", name: "noop", input: {} };
        yield {
          type: "done",
          usage: { input_tokens: 50_000, output_tokens: 10 },
          finish_reason: "tool_calls",
        };
        return;
      }
      yield { type: "text_delta", delta: "done" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };

    const noop = {
      name: "noop",
      description: "noop",
      promptDescription: "noop",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "small" }),
      formatResult: (r: any) => r.content,
      checkPermissions: async () => ({ allowed: true as const }),
    };

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const types: string[] = [];
    for await (const event of agentLoop(messages, [noop as any], caller, testConfig, {
      systemPrompt: "sys",
      maxTurns: 3,
      // Below the 50k reported usage → turn 2 should see "over threshold" purely
      // from the baseline, not from the (tiny) char count.
      autoCompactThreshold: 10_000,
    })) {
      types.push(event.type);
    }

    // Turn 2's prep saw the baseline (50k) > threshold (10k) and compacted.
    expect(types).toContain("compacting");
  });
});

describe("autoCompact failure safety", () => {
  // Regression: adapters signal mid-stream failures by YIELDING an error event
  // (not throwing). autoCompact used to ignore it and commit whatever partial/
  // empty summary resulted — silently deleting all old messages permanently.

  function longHistory(pairs = 30): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < pairs; i++) {
      messages.push({ role: "user", content: [{ type: "text", text: `q${i}` }] });
      messages.push({ role: "assistant", content: `a${i}` });
    }
    return messages;
  }

  it("throws (instead of destroying history) when the summary stream yields an error", async () => {
    const failingCaller: ModelCaller = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: "partial summary" };
      yield { type: "error", error: new Error("stream blew up") };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    const messages = longHistory();
    await expect(autoCompact(messages, failingCaller, testConfig)).rejects.toThrow(
      "stream blew up",
    );
  });

  it("throws when the model returns an empty summary", async () => {
    const emptyCaller: ModelCaller = async function* (): AsyncGenerator<StreamEvent> {
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    await expect(autoCompact(longHistory(), emptyCaller, testConfig)).rejects.toThrow(
      /empty summary/,
    );
  });

  it("still compacts normally on a healthy stream", async () => {
    const okCaller: ModelCaller = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: "A faithful summary." };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    const messages = longHistory();
    const compacted = await autoCompact(messages, okCaller, testConfig);
    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[0].role).toBe("system");
    expect(
      typeof compacted[0].content === "string" && compacted[0].content.includes("faithful"),
    ).toBe(true);
  });
});

// ============================================================
// Top10 #3: context overflow across BOTH provider dialects
// ============================================================
// Two compound bugs on the Anthropic native route: (H1) the usage baseline
// read raw input_tokens, which EXCLUDES cache_read — high cache-hit sessions
// under-counted the live context and proactive compaction never fired;
// (H2) isContextLengthError only matched OpenAI wording, so Anthropic's
// "prompt is too long" 400 skipped compact_and_retry and instead burned the
// whole fallback chain with the same oversized prompt before aborting.
// ============================================================

describe("context overflow — provider dialect coverage (Top10 #3)", () => {
  const anthropicConfig: ModelConfig = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKey: "test-key",
  };

  const noopTool = {
    name: "noop",
    description: "noop",
    promptDescription: "noop",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async () => ({ content: "small" }),
    formatResult: (r: any) => r.content,
    checkPermissions: async () => ({ allowed: true as const }),
  };

  it("compacts and recovers on Anthropic wording 'prompt is too long'", async () => {
    let calls = 0;
    const caller: ModelCaller = async function* (messages: Message[]) {
      calls++;
      if (calls === 1) {
        const e = new Error("prompt is too long: 210000 tokens > 200000 maximum");
        (e as any).status = 400;
        yield { type: "error", error: e };
        return;
      }
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
    for await (const event of agentLoop(messages, [], caller, anthropicConfig, {
      systemPrompt: "sys",
      maxTurns: 5,
      autoCompactThreshold: Number.POSITIVE_INFINITY, // disable proactive compaction
    })) {
      types.push(event.type);
    }

    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
    expect(types).toContain("compacted");
    expect(types).toContain("done");
  });

  it("anthropic high-cache-hit usage feeds the baseline and triggers proactive compaction", async () => {
    // RED under the old code: done reported input_tokens:10 with a 120k
    // cache_read prefix; the baseline stored 10, so turn 2 never crossed the
    // 50k threshold and compaction never fired on the native route.
    let turn = 0;
    const caller: ModelCaller = async function* () {
      turn++;
      if (turn === 1) {
        yield { type: "tool_use", id: "c1", name: "noop", input: {} };
        yield {
          type: "done",
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            cache_read_input_tokens: 120_000,
            cache_creation_input_tokens: 0,
          },
          finish_reason: "tool_calls",
        };
        return;
      }
      yield { type: "text_delta", delta: "done" };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const types: string[] = [];
    for await (const event of agentLoop(messages, [noopTool as any], caller, anthropicConfig, {
      systemPrompt: "sys",
      maxTurns: 3,
      autoCompactThreshold: 50_000,
    })) {
      types.push(event.type);
    }

    expect(types).toContain("compacting");
  });

  it("never re-sends an oversized prompt down the fallback chain", async () => {
    // Every call fails with the Anthropic overflow wording. Whatever the path
    // (compact_and_retry whose summarization also fails → abort), the error is
    // NOT fallbackable: no model switch, no chain burn, fast terminal.
    let calls = 0;
    const caller: ModelCaller = async function* () {
      calls++;
      const e = new Error("prompt is too long: 210000 tokens > 200000 maximum");
      (e as any).status = 400;
      yield { type: "error", error: e };
    };
    const config: ModelConfig = { ...anthropicConfig, fallbackModels: ["backup-model"] };
    const messages = buildHistoryEndingInToolResult(10);
    const summaries: string[] = [];
    const types: string[] = [];
    for await (const event of agentLoop(messages, [], caller, config, {
      systemPrompt: "sys",
      maxTurns: 5,
      autoCompactThreshold: Number.POSITIVE_INFINITY,
    })) {
      types.push(event.type);
      if (event.type === "compacted") summaries.push(event.summary);
    }
    expect(summaries.some((s) => s.includes("Switched to fallback"))).toBe(false);
    // Bounded by the context-length retry budget (maxContextLengthRetries=3 →
    // at most 4 main attempts); the chain's "backup-model" is never tried.
    expect(calls).toBeLessThanOrEqual(4);
    expect(types).toContain("error");
    expect(types).not.toContain("done");
  });

  it("isFallbackableModelError rejects context overflow in both wordings", async () => {
    const anthropicErr = Object.assign(
      new Error("prompt is too long: 210000 tokens > 200000 maximum"),
      { status: 400 },
    );
    const openaiErr = Object.assign(new Error("context_length_exceeded: maximum context length"), {
      status: 400,
    });
    expect(isFallbackableModelError(anthropicErr)).toBe(false);
    expect(isFallbackableModelError(openaiErr)).toBe(false);
    // A genuinely model-specific 400 remains fallbackable.
    expect(
      isFallbackableModelError(Object.assign(new Error("unsupported parameter"), { status: 400 })),
    ).toBe(true);

    // handleModelError routes both wordings to compact_and_retry.
    const state = {
      rateLimitRetries: 0,
      contextLengthRetries: 0,
      transientRetries: 0,
      maxRateLimitRetries: 3,
      maxContextLengthRetries: 3,
      maxTransientRetries: 1,
    };
    expect(await handleModelError(anthropicErr, { ...state })).toBe("compact_and_retry");
    expect(await handleModelError(openaiErr, { ...state })).toBe("compact_and_retry");
  });
});
