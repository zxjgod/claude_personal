// ============================================================
// Tests: Fork-skill execution — context:'fork' runs in a sub-agent (M37)
// ============================================================
// Mocks the llm-adapter so the sub-agent loop yields a canned final text,
// letting us verify that a fork skill spawns a sub-agent and returns only its
// final report (kernel §6 context protection) rather than injecting inline.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () =>
    async function* () {
      yield { type: "text_delta", delta: "fork sub-agent final report" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    },
}));

import { registerSkill, resetSkills } from "../skills.js";
import { SkillTool } from "../tools/breadth/orchestration.js";
import type { ModelConfig, ToolContext } from "../types.js";

const modelConfig: ModelConfig = { provider: "deepseek", model: "deepseek-chat", apiKey: "k" };

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "fork-skill-sess",
    permissionMode: "default",
    modelConfig,
    ...overrides,
  };
}

beforeEach(() => resetSkills());

describe("SkillTool — fork execution", () => {
  it("runs a context:'fork' skill in a sub-agent and returns its final report", async () => {
    registerSkill({
      name: "forked-audit",
      description: "audit",
      context: "fork",
      agent: "code-explorer",
      getPromptForCommand: async () => "Audit the repo.",
    });
    const r = await SkillTool.call({ skill: "forked-audit" }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("(fork) completed");
    expect(r.content).toContain("fork sub-agent final report");
  });

  it("falls back to inline injection when modelConfig is absent", async () => {
    registerSkill({
      name: "forked-noconfig",
      description: "audit",
      context: "fork",
      getPromptForCommand: async () => "Audit the repo.",
    });
    // No modelConfig → SkillTool can't fork, so it injects inline instead.
    const r = await SkillTool.call({ skill: "forked-noconfig" }, ctx({ modelConfig: undefined }));
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("Audit the repo.");
    expect(r.content).not.toContain("(fork) completed");
  });

  it("inline skills never spawn a sub-agent", async () => {
    registerSkill({ name: "plain", description: "d", prompt: "Just instructions." });
    const r = await SkillTool.call({ skill: "plain" }, ctx());
    expect(r.content).toContain("Just instructions.");
    expect(r.content).not.toContain("(fork)");
  });
});

describe("SkillTool — project-scope shell gate (review fix)", () => {
  const shellSkill = {
    name: "planted",
    description: "d",
    source: "disk" as const,
    diskScope: "project" as const,
    hasShellDirectives: true,
    getPromptForCommand: async () => "expanded body",
  };

  it("fails closed when no approval channel exists (headless)", async () => {
    registerSkill(shellSkill);
    const r = await SkillTool.call({ skill: "planted" }, ctx({ askUser: undefined }));
    expect(r.error).toContain("shell directives");
    expect(r.content).toBe("");
  });

  it("runs when the user approves via askUser", async () => {
    registerSkill(shellSkill);
    const r = await SkillTool.call({ skill: "planted" }, ctx({ askUser: async () => true }));
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("expanded body");
  });

  it("denies when askUser says no", async () => {
    registerSkill(shellSkill);
    const r = await SkillTool.call({ skill: "planted" }, ctx({ askUser: async () => false }));
    expect(r.error).toContain("shell directives");
  });

  it("user-scope and builtin skills are NOT gated", async () => {
    registerSkill({ ...shellSkill, name: "mine", diskScope: "user" });
    registerSkill({ name: "b", description: "d", prompt: "static body" });
    expect((await SkillTool.call({ skill: "mine" }, ctx())).error).toBeUndefined();
    expect((await SkillTool.call({ skill: "b" }, ctx())).error).toBeUndefined();
  });
});
