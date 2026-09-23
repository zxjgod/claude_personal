// ============================================================
// Tests: sub-agent registry
// ============================================================

import { describe, expect, it } from "vitest";
import {
  buildSubagentSystemPrompt,
  enhanceSystemPromptWithEnvDetails,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  getSubagentType,
  listSubagentNames,
  listSubagentSelectionHints,
  registerSubagentType,
  resolveSubagentTools,
  setAgentMemoryLoader,
  setCoreToolsForSubagents,
} from "../subagents.js";
import type { Message, Tool } from "../types.js";

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

  it("resolves the mcp__* wildcard to every MCP tool (S3)", () => {
    registerSubagentType({
      name: "mcp-worker",
      description: "uses mcp",
      toolNames: ["read", "mcp__*"],
      systemPrompt: "You use MCP tools.",
    });
    const available = [
      fakeTool("read"),
      fakeTool("mcp__github__create_issue"),
      fakeTool("mcp__db__query"),
      fakeTool("write"), // not declared → excluded
    ];
    const resolved = resolveSubagentTools(getSubagentType("mcp-worker")!, available);
    expect(resolved.map((t) => t.name).sort()).toEqual([
      "mcp__db__query",
      "mcp__github__create_issue",
      "read",
    ]);
  });

  it("resolves a server-scoped wildcard (mcp__github__*)", () => {
    registerSubagentType({
      name: "gh-worker",
      description: "uses github mcp only",
      toolNames: ["mcp__github__*"],
      systemPrompt: "GitHub only.",
    });
    const available = [
      fakeTool("mcp__github__create_issue"),
      fakeTool("mcp__github__list_prs"),
      fakeTool("mcp__db__query"),
    ];
    const resolved = resolveSubagentTools(getSubagentType("gh-worker")!, available);
    expect(resolved.map((t) => t.name).sort()).toEqual([
      "mcp__github__create_issue",
      "mcp__github__list_prs",
    ]);
  });

  it("a wildcard with no matches resolves to an empty set without error", () => {
    registerSubagentType({
      name: "mcp-none",
      description: "no mcp present",
      toolNames: ["mcp__*"],
      systemPrompt: "Empty.",
    });
    expect(resolveSubagentTools(getSubagentType("mcp-none")!, [fakeTool("read")])).toEqual([]);
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
    expect(got).toEqual(injected);
  });
});

// ============================================================
// M34 · Context protection (kernel §4)
// ============================================================

describe("extractLastAssistantText (M34)", () => {
  it("returns ONLY the final assistant text, not accumulated narration", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      // Turn 1: thought out loud, then called a tool
      { role: "assistant", content: "Let me look at the files first." },
      { role: "assistant", content: null, tool_calls: [] as any },
      { role: "tool", tool_call_id: "t1", content: "raw tool output A" },
      // Turn 2: more narration
      { role: "assistant", content: "Found it, checking one more thing." },
      // Final turn: the actual report
      { role: "assistant", content: "Report: the bug is in foo.ts line 10." },
    ];
    const out = extractLastAssistantText(messages);
    expect(out).toBe("Report: the bug is in foo.ts line 10.");
    // Crucially, the intermediate narration is NOT included.
    expect(out).not.toContain("look at the files");
    expect(out).not.toContain("raw tool output");
  });

  it("falls back to the nearest earlier assistant text when the loop stopped on tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: "Here is my summary so far." },
      // Stopped on a tool call (null content) — common when maxTurns hits.
      { role: "assistant", content: null, tool_calls: [] as any },
      { role: "tool", tool_call_id: "t1", content: "raw output" },
    ];
    expect(extractLastAssistantText(messages)).toBe("Here is my summary so far.");
  });

  it("ignores whitespace-only assistant content", () => {
    const messages: Message[] = [
      { role: "assistant", content: "real answer" },
      { role: "assistant", content: "   \n  " },
    ];
    expect(extractLastAssistantText(messages)).toBe("real answer");
  });

  it("returns empty string when there is no assistant text at all", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    expect(extractLastAssistantText(messages)).toBe("");
  });
});

describe("enhanceSystemPromptWithEnvDetails (M34)", () => {
  it("appends an env block and a self-contained-report Notes footnote", () => {
    const out = enhanceSystemPromptWithEnvDetails("BASE PROMPT", {
      workspaceRoot: "/my/workspace",
    });
    expect(out).toContain("BASE PROMPT");
    expect(out).toContain("/my/workspace");
    expect(out).toContain("absolute paths");
    // The footnote must steer the agent toward a self-contained final report.
    expect(out.toLowerCase()).toContain("final reply");
  });
});

describe("listSubagentSelectionHints (M34)", () => {
  it("exposes a whenToUse hint per built-in type", () => {
    const hints = listSubagentSelectionHints();
    const explorer = hints.find((h) => h.name === "code-explorer");
    expect(explorer).toBeDefined();
    expect(explorer!.whenToUse.length).toBeGreaterThan(0);
  });
});

describe("buildSubagentSystemPrompt + memory (M35)", () => {
  it("composes env details and injects memory when the type declares a scope", () => {
    setAgentMemoryLoader((scope, type) => `MEM[${scope}/${type}]`);
    const type = {
      name: "mem-agent",
      description: "d",
      toolNames: [],
      systemPrompt: "BASE",
      memory: "project" as const,
    };
    const out = buildSubagentSystemPrompt(type, "BASE", { workspaceRoot: "/ws" });
    expect(out).toContain("BASE");
    expect(out).toContain("/ws"); // env block
    expect(out).toContain("MEM[project/mem-agent]");
    setAgentMemoryLoader(() => null); // reset for other tests
  });

  it("omits the memory block when the type declares no scope", () => {
    setAgentMemoryLoader(() => "SHOULD-NOT-APPEAR");
    const type = { name: "plain", description: "d", toolNames: [], systemPrompt: "BASE" };
    const out = buildSubagentSystemPrompt(type, "BASE", { workspaceRoot: "/ws" });
    expect(out).not.toContain("SHOULD-NOT-APPEAR");
    setAgentMemoryLoader(() => null);
  });
});
