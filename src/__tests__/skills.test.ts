// ============================================================
// Tests: Skill model — rich SkillDefinition, lazy body, discovery budget (M37)
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_DISCOVERY_WINDOW,
  getSkill,
  listSkills,
  registerSkill,
  renderSkillCatalog,
  resetSkills,
  resolveSkillPrompt,
} from "../skills.js";

beforeEach(() => resetSkills());
afterEach(() => resetSkills());

describe("skill registry — back-compat", () => {
  it("accepts the legacy { prompt } shape and resolves it", async () => {
    registerSkill({ name: "legacy", description: "old shape", prompt: "Do the thing." });
    const skill = getSkill("legacy")!;
    expect(skill).toBeDefined();
    expect(skill.source).toBe("builtin");
    expect(await resolveSkillPrompt(skill)).toBe("Do the thing.");
  });

  it("appends an Arguments line when args are present", async () => {
    registerSkill({ name: "legacy", description: "d", prompt: "Body." });
    const out = await resolveSkillPrompt(getSkill("legacy")!, { args: "foo bar" });
    expect(out).toContain("Body.");
    expect(out).toContain("Arguments: foo bar");
  });

  it("seeds built-in skills with whenToUse for matching", () => {
    const all = listSkills();
    const research = all.find((s) => s.name === "deep-research");
    expect(research?.whenToUse).toBeTruthy();
  });
});

describe("skill registry — rich definition", () => {
  it("loads the body lazily — getPromptForCommand isn't called at discovery", () => {
    let calls = 0;
    registerSkill({
      name: "lazy",
      description: "lazy body",
      getPromptForCommand: async () => {
        calls++;
        return "expensive body";
      },
    });
    // Discovery (listSkills) must NOT trigger the body.
    listSkills();
    expect(calls).toBe(0);
  });

  it("invokes getPromptForCommand exactly once at resolution", async () => {
    let calls = 0;
    registerSkill({
      name: "lazy",
      description: "lazy body",
      getPromptForCommand: async (ctx) => {
        calls++;
        return `body for ${ctx.args ?? ""}`;
      },
    });
    const out = await resolveSkillPrompt(getSkill("lazy")!, { args: "X" });
    expect(calls).toBe(1);
    expect(out).toContain("body for X");
  });

  it("carries context/agent/allowedTools through registration", () => {
    registerSkill({
      name: "forked",
      description: "fork skill",
      context: "fork",
      agent: "code-explorer",
      allowedTools: ["read", "grep"],
      getPromptForCommand: async () => "go",
    });
    const skill = getSkill("forked")!;
    expect(skill.context).toBe("fork");
    expect(skill.agent).toBe("code-explorer");
    expect(skill.allowedTools).toEqual(["read", "grep"]);
  });
});

describe("discovery budget (~1% of context window)", () => {
  it("caps the catalog to the budget and reports an overflow count", () => {
    // Register many skills with long descriptions; a tiny window forces overflow.
    for (let i = 0; i < 50; i++) {
      registerSkill({
        name: `skill-${i}`,
        description: "x".repeat(80),
        getPromptForCommand: async () => "b",
      });
    }
    // 2000-token window → 1% × 4 chars ≈ 80 chars budget → only a couple fit.
    const { shown, omitted, text } = renderSkillCatalog(2000);
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(omitted).toBeGreaterThan(0);
    expect(shown + omitted).toBe(listSkills().length);
    expect(text).toContain("and");
    expect(text).toContain("more");
  });

  it("shows every skill when the budget is ample", () => {
    registerSkill({ name: "a", description: "short", getPromptForCommand: async () => "1" });
    registerSkill({ name: "b", description: "short", getPromptForCommand: async () => "2" });
    const { omitted } = renderSkillCatalog(DEFAULT_SKILL_DISCOVERY_WINDOW);
    expect(omitted).toBe(0);
  });

  it("always emits at least one line even under a starvation budget", () => {
    registerSkill({
      name: "only",
      description: "x".repeat(500),
      getPromptForCommand: async () => "1",
    });
    const { shown } = renderSkillCatalog(1);
    expect(shown).toBe(1);
  });
});
