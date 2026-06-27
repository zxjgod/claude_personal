// ============================================================
// Tests: sub-agent registry
// ============================================================

import { describe, expect, it } from "vitest";
import {
  getCoreToolsForSubagents,
  getSubagentType,
  listSubagentNames,
  registerSubagentType,
  resolveSubagentTools,
  setCoreToolsForSubagents,
} from "../subagents.js";
import type { Tool } from "../types.js";

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    promptDescription: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async () => ({ content: "" }),
    checkPermissions: async () => ({ allowed: true }),
    formatResult: (r) => r.content,
  };
}

describe("subagent registry", () => {
  it("ships built-in types", () => {
    const names = listSubagentNames();
    expect(names).toContain("code-explorer");
    expect(names).toContain("code-reviewer");
    expect(names).toContain("general");
  });

  it("code-reviewer is read-only (no write/edit/bash)", () => {
    const type = getSubagentType("code-reviewer")!;
    expect(type.toolNames).not.toContain("write");
    expect(type.toolNames).not.toContain("edit");
    expect(type.toolNames).not.toContain("bash");
  });

  it("general can write and edit", () => {
    const type = getSubagentType("general")!;
    expect(type.toolNames).toContain("write");
    expect(type.toolNames).toContain("edit");
  });

  it("resolves tool names against the available set, skipping unknowns", () => {
    const type = getSubagentType("code-explorer")!;
    const available = [fakeTool("read"), fakeTool("grep")]; // glob/bash missing
    const resolved = resolveSubagentTools(type, available);
    expect(resolved.map((t) => t.name)).toEqual(["read", "grep"]);
  });

  it("supports registering a custom type", () => {
    registerSubagentType({
      name: "tester",
      description: "runs tests",
      toolNames: ["bash"],
      systemPrompt: "You run tests.",
    });
    expect(listSubagentNames()).toContain("tester");
    expect(getSubagentType("tester")!.toolNames).toEqual(["bash"]);
  });

  it("returns undefined for unknown types", () => {
    expect(getSubagentType("nope")).toBeUndefined();
  });

  // 16.9: core tools are injected (CLI) or lazily imported (fallback) rather
  // than each sub-agent module dynamically importing tools.ts.
  it("setCoreToolsForSubagents injects the tool set read by getCoreToolsForSubagents", async () => {
    const injected = [fakeTool("read"), fakeTool("bash")];
    setCoreToolsForSubagents(injected);
    const got = await getCoreToolsForSubagents();
    expect(got).toBe(injected);
  });
});
