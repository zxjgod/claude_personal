// ============================================================
// Tests: prompt cache break detection (Phase C, src/prompt-cache.ts)
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  checkResponseForCacheBreak,
  recordPromptState,
  resetPromptCacheState,
} from "../prompt-cache.js";
import { createTool } from "../tools/registry.js";
import type { Tool } from "../types.js";

function makeTool(name: string): Tool {
  return createTool({
    name,
    description: name,
    promptDescription: `${name} tool`,
    inputSchema: { type: "object", properties: {}, required: [] },
    isReadOnly: true,
    isConcurrencySafe: true,
    call: async () => ({ content: "" }),
  });
}

const snapshot = (
  tools: Tool[],
  model = "claude-opus",
): Parameters<typeof recordPromptState>[0] => ({
  systemPrompt: "static prefix\n\n--- SYSTEM PROMPT DYNAMIC BOUNDARY ---\n\ndynamic suffix",
  tools,
  model,
});

beforeEach(() => resetPromptCacheState());

describe("prompt cache break detection", () => {
  it("does not flag the first call (no baseline)", () => {
    recordPromptState(snapshot([makeTool("read")]));
    expect(checkResponseForCacheBreak(50_000, 0)).toBeNull();
  });

  it("does not flag when cache read stays high", () => {
    recordPromptState(snapshot([makeTool("read")]));
    checkResponseForCacheBreak(50_000, 0);
    recordPromptState(snapshot([makeTool("read")]));
    expect(checkResponseForCacheBreak(50_000, 0)).toBeNull();
  });

  it("flags a break and attributes it to TTL/server-side when the prompt is unchanged", () => {
    recordPromptState(snapshot([makeTool("read")]));
    checkResponseForCacheBreak(50_000, 0);
    recordPromptState(snapshot([makeTool("read")]));
    const r = checkResponseForCacheBreak(40_000, 0); // drop 10k (>5% and >2000)
    expect(r).not.toBeNull();
    expect(r!.reason).toContain("prompt unchanged");
  });

  it("attributes a break to a model change", () => {
    recordPromptState(snapshot([makeTool("read")], "model-a"));
    checkResponseForCacheBreak(50_000, 0);
    recordPromptState(snapshot([makeTool("read")], "model-b"));
    const r = checkResponseForCacheBreak(40_000, 0);
    expect(r!.reason).toContain("model changed (model-a → model-b)");
  });

  it("attributes a break to a tool-set change", () => {
    recordPromptState(snapshot([makeTool("read")]));
    checkResponseForCacheBreak(50_000, 0);
    recordPromptState(snapshot([makeTool("read"), makeTool("write")]));
    const r = checkResponseForCacheBreak(40_000, 0);
    expect(r!.reason).toContain("tools changed (+1/-0)");
  });

  it("ignores the dynamic suffix (boundary below) when hashing", () => {
    const a = snapshot([makeTool("read")]);
    recordPromptState(a);
    checkResponseForCacheBreak(50_000, 0);
    // Same static prefix, different dynamic suffix → NOT a prompt change.
    recordPromptState({
      ...a,
      systemPrompt: "static prefix\n\n--- SYSTEM PROMPT DYNAMIC BOUNDARY ---\n\ndifferent dynamic",
    });
    expect(checkResponseForCacheBreak(50_000, 0)).toBeNull();
  });
});
