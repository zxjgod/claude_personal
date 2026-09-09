import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPartialReport } from "../tools/extended/subagent-report.js";
import type { Message, ModelCaller, ModelConfig } from "../types.js";

const config: ModelConfig = { provider: "openai", model: "test", apiKey: "fake" };
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded subagent handoff", () => {
  it("requests evidence and unchecked scope without tools or history mutation", async () => {
    const history: Message[] = [{ role: "user", content: [{ type: "text", text: "review" }] }];
    const caller: ModelCaller = async function* (messages, tools) {
      expect(tools).toEqual([]);
      expect(JSON.stringify(messages.at(-1))).toContain("unchecked scope");
      yield { type: "text_delta", delta: "Partial: inspected a.ts; b.ts remains unchecked." };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    expect(await collectPartialReport(history, caller, config, "system")).toContain("b.ts");
    expect(history).toHaveLength(1);
  });

  it("does not call a model after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const caller = vi.fn();
    expect(await collectPartialReport([], caller, config, "s", controller.signal)).toBe("");
    expect(caller).not.toHaveBeenCalled();
  });

  it("stops waiting after 60 seconds even when the caller ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const caller: ModelCaller = async function* (_m, _t, _s, _c, s) {
      signal = s;
      await new Promise(() => {});
    };
    const pending = collectPartialReport([], caller, config, "s");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toBe("");
    expect(signal?.aborted).toBe(true);
  });

  it("does not present narration followed by a tool call as a report", async () => {
    const caller: ModelCaller = async function* () {
      yield { type: "text_delta", delta: "I will read more files" };
      yield { type: "tool_use", id: "1", name: "read", input: {} };
    };
    expect(await collectPartialReport([], caller, config, "s")).toBe("");
  });
});
