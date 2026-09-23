// ============================================================
// Tests: WebFetch fetchInfo execution (S6)
// ============================================================
// fetchInfo must actually run a bounded model extraction over the page text
// (fast model when configured) instead of merely echoing the instruction in
// the header. Failures and missing modelConfig degrade to the raw content.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ caller: vi.fn() }));
// Keep the REAL module (resolveFastModelConfig now calls resolveProviderConfig
// from it for cross-provider fast models) and swap only the caller factory.
vi.mock("../llm-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createModelCaller: () => fake.caller };
});
// public-http speaks node:http directly — stub the module, not global fetch.
vi.mock("../tools/utils/public-http.js", () => ({
  publicHttpGet: async () =>
    new Response(PAGE_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
}));

const PAGE_HTML = `<html><body><h1>Release 2.1</h1><p>Fixed the login bug. Ships on 2026-10-01.</p></body></html>`;

import { WebFetchTool } from "../tools/extended/web-fetch.js";
import type { ModelCaller, ToolContext } from "../types.js";

function ctx(withModel: boolean): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "wf-extract",
    permissionMode: "default",
    ...(withModel ? { modelConfig: { provider: "openai", model: "gpt-test", apiKey: "k" } } : {}),
  };
}

beforeEach(() => {
  fake.caller.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("WebFetch fetchInfo extraction (S6)", () => {
  it("runs the instruction through the model and returns the extract", async () => {
    const caller: ModelCaller = async function* () {
      yield { type: "text_delta", delta: "Ships on 2026-10-01; fixes the login bug." };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    fake.caller.mockImplementation(caller);
    const result = await WebFetchTool.call(
      { url: "https://example.com/release", fetchInfo: "release date and fixes" },
      ctx(true),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Ships on 2026-10-01");
    expect(result.content).toContain("Raw preview");
    // The model saw the page text and the instruction.
    const prompt = fake.caller.mock.calls[0]?.[0] as unknown;
    expect(JSON.stringify(prompt)).toContain("release date and fixes");
    expect(JSON.stringify(prompt)).toContain("Fixed the login bug");
    expect(result.metadata?.summary).toBe("Extracted per fetchInfo");
  });

  it("degrades to raw content when the model pass fails", async () => {
    // Throw at CALL time (a yield-less generator trips lint/correctness/
    // useYield); web-fetch invokes the caller inside its try block, so the
    // degrade path is exercised identically.
    fake.caller.mockImplementation(() => {
      throw new Error("model down");
    });
    const result = await WebFetchTool.call(
      { url: "https://example.com/release", fetchInfo: "release date" },
      ctx(true),
    );
    expect(result.error).toBeUndefined();
    // Raw content present (HTML stripped).
    expect(result.content).toContain("Fixed the login bug");
    expect(result.content).not.toContain("Raw preview");
  });

  it("skips the model entirely when context has no modelConfig", async () => {
    const result = await WebFetchTool.call(
      { url: "https://example.com/release", fetchInfo: "release date" },
      ctx(false),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Fixed the login bug");
    expect(fake.caller).not.toHaveBeenCalled();
  });

  it("prefers the configured fast model", async () => {
    // Cross-provider fast model requires its own key (the main config's
    // baseURL/apiKey belong to the main provider's endpoint).
    vi.stubEnv("CCR_FAST_MODEL", "deepseek/deepseek-chat");
    vi.stubEnv("CCR_FAST_MODEL_API_KEY", "fast-key");
    const caller: ModelCaller = async function* (_m, _t, _s, config) {
      yield { type: "text_delta", delta: `model=${config.model}` };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    fake.caller.mockImplementation(caller);
    const result = await WebFetchTool.call(
      { url: "https://example.com/release", fetchInfo: "anything" },
      ctx(true),
    );
    expect(result.content).toContain("model=deepseek-chat");
  });
});
