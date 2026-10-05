// ============================================================
// Tests: sub-agent registry
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { setSubagentSettings } from "../subagent-settings.js";
import {
  AGENT_DESCRIPTION_TOKEN_LIMIT,
  agentDescriptionTokens,
  applyDisableExplorePlanEnv,
  buildSubagentSystemPrompt,
  enhanceSystemPromptWithEnvDetails,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  getSubagentType,
  listSubagentNames,
  listSubagentSelectionHints,
  normalizeSubagentTypeName,
  registerSubagentType,
  resolveSubagentTools,
  resolveSubagentType,
  setAgentMemoryLoader,
  setCoreToolsForSubagents,
  subagentModelConfig,
} from "../subagents.js";
import type { Message, ModelConfig, Tool } from "../types.js";

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

  it('general inherits everything like official general-purpose (tools ["*"])', () => {
    const type = getSubagentType("general")!;
    expect(type.inheritTools).toBe(true);
    expect(type.disallowedTools ?? []).toEqual([]);
    const available = [fakeTool("write"), fakeTool("edit"), fakeTool("bash")];
    expect(resolveSubagentTools(type, available).map((t) => t.name)).toEqual([
      "write",
      "edit",
      "bash",
    ]);
  });

  it("code-explorer (denylist, like official Explore) drops write/edit/spawn, keeps the rest", () => {
    const type = getSubagentType("code-explorer")!;
    const available = [
      fakeTool("read"),
      fakeTool("grep"),
      fakeTool("write"),
      fakeTool("Agent"),
      fakeTool("webfetch"),
    ];
    const resolved = resolveSubagentTools(type, available);
    expect(resolved.map((t) => t.name)).toEqual(["read", "grep", "webfetch"]);
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

describe("omitClaudeMd (official parity)", () => {
  it("skips the CLAUDE.md instructions block when the type opts out", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-omitmd-"));
    try {
      fs.writeFileSync(path.join(repo, "CLAUDE.md"), "UNIQUE-PROJECT-RULE-XYZ");
      const normal = { name: "n", description: "d", toolNames: [], systemPrompt: "BASE" };
      const skipping = { ...normal, name: "s", omitClaudeMd: true };
      const withMd = buildSubagentSystemPrompt(normal, "BASE", { workspaceRoot: repo });
      const without = buildSubagentSystemPrompt(skipping, "BASE", { workspaceRoot: repo });
      expect(withMd).toContain("UNIQUE-PROJECT-RULE-XYZ");
      expect(without).not.toContain("UNIQUE-PROJECT-RULE-XYZ");
      // The env block is not part of CLAUDE.md — it must survive opt-out.
      expect(without).toContain(repo);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("built-in code-explorer skips CLAUDE.md like official Explore", () => {
    expect(getSubagentType("code-explorer")?.omitClaudeMd).toBe(true);
    expect(getSubagentType("general")?.omitClaudeMd).toBeFalsy();
  });
});

describe("subagentModelConfig + CLAUDE_CODE_SUBAGENT_MODEL", () => {
  const parent: ModelConfig = { provider: "anthropic", model: "main-model" } as ModelConfig;
  const typed = {
    name: "t",
    description: "d",
    toolNames: [],
    systemPrompt: "BASE",
    model: "haiku",
  };

  it("frontmatter model resolves aliases on the anthropic provider", () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    expect(subagentModelConfig(typed, parent).model).toBe("claude-haiku-4-5");
  });

  it("the env var forces one model onto every definition-based sub-agent", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "opus";
    try {
      expect(subagentModelConfig(typed, parent).model).toBe("claude-opus-4-6");
      // An explicit `model: inherit` frontmatter loses to the env var too.
      expect(subagentModelConfig({ ...typed, model: "inherit" }, parent).model).toBe(
        "claude-opus-4-6",
      );
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
  });

  it("passes raw model names through on non-anthropic providers", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-chat";
    try {
      const openaiParent = { provider: "openai", model: "main" } as ModelConfig;
      expect(subagentModelConfig(typed, openaiParent).model).toBe("deepseek-chat");
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
  });

  it("forks (no type) keep the parent model even when the env var is set", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "opus";
    try {
      expect(subagentModelConfig(undefined, parent).model).toBe("main-model");
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
  });

  it("call-time model param overrides the frontmatter model (2.1.202 binary order)", () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    expect(subagentModelConfig(typed, parent, "call-model").model).toBe("call-model");
    // Frontmatter-only still applies when no param is passed.
    expect(subagentModelConfig(typed, parent).model).toBe("claude-haiku-4-5");
  });

  it("the env var beats the call-time param (2.1.202 binary B7: env > param)", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "opus";
    try {
      expect(subagentModelConfig(typed, parent, "call-model").model).toBe("claude-opus-4-6");
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
  });

  it("#21: typed sub-agents default to thinking OFF (explicit false beats adaptive)", () => {
    setSubagentSettings({ thinking: false });
    try {
      const thinkingParent = { ...parent, options: { thinking: { type: "adaptive" } } };
      expect(subagentModelConfig(typed, thinkingParent).options?.thinking).toBe(false);
    } finally {
      setSubagentSettings({ thinking: false });
    }
  });

  it("#21: the /agents global toggle re-enables thinking (parent config passes through)", () => {
    setSubagentSettings({ thinking: true });
    try {
      const thinkingParent = { ...parent, options: { thinking: { type: "adaptive" } } };
      expect(subagentModelConfig(typed, thinkingParent).options?.thinking).toEqual({
        type: "adaptive",
      });
    } finally {
      setSubagentSettings({ thinking: false });
    }
  });

  it("#21: frontmatter `thinking` beats the global toggle, forks keep parent thinking", () => {
    setSubagentSettings({ thinking: false });
    try {
      const thinker = { ...typed, thinking: true };
      const thinkingParent = { ...parent, options: { thinking: { type: "adaptive" } } };
      expect(subagentModelConfig(thinker, thinkingParent).options?.thinking).toEqual({
        type: "adaptive",
      });
      // Explicit frontmatter false pins it off even when the toggle is on.
      setSubagentSettings({ thinking: true });
      const pinned = { ...typed, thinking: false };
      expect(subagentModelConfig(pinned, thinkingParent).options?.thinking).toBe(false);
      // A fork (no type) IS the current agent — parent thinking untouched.
      expect(subagentModelConfig(undefined, thinkingParent).options?.thinking).toEqual({
        type: "adaptive",
      });
    } finally {
      setSubagentSettings({ thinking: false });
    }
  });
});

describe("agent description token budget (official 15k parity)", () => {
  it("counts non-built-in 'name: whenToUse' hints toward the total", () => {
    const before = agentDescriptionTokens();
    registerSubagentType({
      name: "verbose-budget-probe",
      description: "short",
      whenToUse: "x".repeat(80_000), // ~20k tokens at 4 chars/token
      toolNames: [],
      systemPrompt: "probe",
    });
    expect(agentDescriptionTokens() - before).toBeGreaterThan(AGENT_DESCRIPTION_TOKEN_LIMIT);
  });

  it("excludes built-in types from the budget", () => {
    const before = agentDescriptionTokens();
    registerSubagentType({
      name: "builtin-budget-probe",
      description: "y".repeat(80_000),
      toolNames: [],
      systemPrompt: "probe",
      source: "built-in",
    });
    expect(agentDescriptionTokens()).toBe(before);
  });

  it("falls back to description when whenToUse is absent", () => {
    const before = agentDescriptionTokens();
    registerSubagentType({
      name: "desc-only-budget-probe",
      description: "z".repeat(4_000),
      toolNames: [],
      systemPrompt: "probe",
    });
    expect(agentDescriptionTokens() - before).toBeGreaterThanOrEqual(1_000);
  });
});

describe("whenToUseLean selection (official Y$l)", () => {
  it("lean flag swaps whenToUse → whenToUseLean when defined", () => {
    registerSubagentType({
      name: "lean-probe",
      description: "d",
      whenToUse: "FULL hint text",
      whenToUseLean: "LEAN hint text",
      toolNames: [],
      systemPrompt: "probe",
    });
    const full = listSubagentSelectionHints(false).find((h) => h.name === "lean-probe");
    const lean = listSubagentSelectionHints(true).find((h) => h.name === "lean-probe");
    expect(full?.whenToUse).toBe("FULL hint text");
    expect(lean?.whenToUse).toBe("LEAN hint text");
  });

  it("lean flag falls back to whenToUse when no lean variant exists", () => {
    const hints = listSubagentSelectionHints(true);
    const general = hints.find((h) => h.name === "general");
    expect(general?.whenToUse).toContain("multi-step task");
  });

  it("built-in code-explorer exposes the official Explore lean variant", () => {
    const lean = listSubagentSelectionHints(true).find((h) => h.name === "code-explorer");
    expect(lean?.whenToUse).toContain("broad fan-out searches");
    const full = listSubagentSelectionHints(false).find((h) => h.name === "code-explorer");
    expect(full?.whenToUse).toContain("Fast read-only search agent");
  });

  it("code-explorer is denylist-based like official Explore (write/edit/spawn out, web stays)", () => {
    const explorer = getSubagentType("code-explorer");
    expect(explorer?.inheritTools).toBe(true);
    expect(explorer?.disallowedTools).toEqual(
      expect.arrayContaining(["agent", "task", "write", "edit", "notebookedit"]),
    );
  });
});

describe("subagent type-name normalization (official bTt)", () => {
  it("resolves case/space/dash/underscore variants to a unique match", () => {
    expect(resolveSubagentType("Code Explorer")).toMatchObject({
      kind: "found",
      normalized: true,
    });
    expect(resolveSubagentType("code_explorer")).toMatchObject({ kind: "found" });
    expect(resolveSubagentType("code-explorer")).toMatchObject({
      kind: "found",
      normalized: false,
    });
  });

  it("reports ambiguity when several registered names normalize the same", () => {
    registerSubagentType({
      name: "zz alpha",
      description: "a",
      toolNames: [],
      systemPrompt: "a",
    });
    registerSubagentType({
      name: "zz-alpha",
      description: "b",
      toolNames: [],
      systemPrompt: "b",
    });
    const r = resolveSubagentType("ZZ_ALPHA");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.matches).toEqual(expect.arrayContaining(["zz alpha", "zz-alpha"]));
    }
  });

  it("returns not-found for unknown names", () => {
    expect(resolveSubagentType("no-such-agent-anywhere").kind).toBe("not-found");
  });

  it("official built-in names alias to our equivalents (拍板 c=B)", () => {
    // Explore → code-explorer, general-purpose → general (any casing/dashes).
    const explore = resolveSubagentType("Explore");
    expect(explore).toMatchObject({ kind: "found", normalized: true });
    if (explore.kind === "found") expect(explore.type.name).toBe("code-explorer");
    const gp = resolveSubagentType("General-Purpose");
    expect(gp).toMatchObject({ kind: "found" });
    if (gp.kind === "found") expect(gp.type.name).toBe("general");
    // Plan has no local analog — honest not-found rather than a wrong mapping.
    expect(resolveSubagentType("Plan").kind).toBe("not-found");
    // A user-defined agent named "Explore" overrides the alias (exact hit wins).
    registerSubagentType({
      name: "Explore",
      description: "user agent shadowing the alias",
      toolNames: [],
      systemPrompt: "user",
    });
    const shadowed = resolveSubagentType("Explore");
    expect(shadowed).toMatchObject({ kind: "found", normalized: false });
    if (shadowed.kind === "found") {
      expect(shadowed.type.description).toContain("shadowing");
    }
  });

  it("NFKC-folds fullwidth and exotic characters before matching", () => {
    // Fullwidth "ＣＯＤＥ-ＥＸＰＬＯＲＥＲ" NFKC-normalizes to ASCII.
    expect(normalizeSubagentTypeName("ｃｏｄｅ－ｅｘｐｌｏｒｅｒ")).toBe("codeexplorer");
    expect(normalizeSubagentTypeName("Code Explorer")).toBe("codeexplorer");
  });
});

// Last: this suite mutates the registry irreversibly (deletes built-ins).
describe("CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS (official wjr gate)", () => {
  it("removes built-in Explore/Plan analogs but spares user agents of the same name", () => {
    registerSubagentType({
      name: "plan",
      description: "user's own plan agent",
      toolNames: [],
      systemPrompt: "user plan",
      // no source → not built-in → must survive
    });
    process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS = "1";
    try {
      const removed = applyDisableExplorePlanEnv();
      expect(removed).toContain("code-explorer");
      expect(getSubagentType("code-explorer")).toBeUndefined();
      expect(getSubagentType("plan")?.systemPrompt).toBe("user plan");
      // Second call is a no-op (env still set, nothing left to remove).
      expect(applyDisableExplorePlanEnv()).toEqual([]);
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS;
    }
  });

  it("is a no-op when the env var is unset", () => {
    expect(applyDisableExplorePlanEnv()).toEqual([]);
  });
});
