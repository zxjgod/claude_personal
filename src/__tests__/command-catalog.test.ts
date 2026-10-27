import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";
import {
  getAvailableCommands,
  handleSlashCommand,
  registerCustomCommand,
  resetCustomCommands,
} from "../commands.js";
import { registerSkill, resetSkills } from "../skills.js";

beforeEach(() => {
  resetCustomCommands();
  resetSkills();
});

afterEach(() => {
  resetCustomCommands();
  resetSkills();
  vi.restoreAllMocks();
});

describe("live slash command catalog", () => {
  it("deduplicates case-insensitively in dispatch order and preserves display names", () => {
    registerCustomCommand({ name: "HELP", description: "shadow", run: () => undefined });
    registerCustomCommand({ name: "MiXeD", description: "custom", run: () => undefined });
    registerSkill({ name: "mixed", description: "skill shadow", prompt: "no" });
    registerSkill({ name: "SkillCase", description: "skill", prompt: "yes" });
    registerSkill({
      name: "hidden",
      description: "hidden",
      userInvocable: false,
      prompt: "no",
    });

    const catalog = getAvailableCommands();
    expect(catalog.filter((entry) => entry.name.toLowerCase() === "help")).toHaveLength(1);
    expect(catalog.find((entry) => entry.name.toLowerCase() === "help")?.description).toBe(
      "Show available commands",
    );
    expect(catalog.find((entry) => entry.name.toLowerCase() === "mixed")).toEqual({
      name: "MiXeD",
      description: "custom",
    });
    expect(catalog).toContainEqual({ name: "SkillCase", description: "skill" });
    expect(catalog.some((entry) => entry.name === "hidden")).toBe(false);
  });

  it("dispatches mixed-case custom commands while built-ins keep precedence", async () => {
    const custom = vi.fn(() => undefined);
    const shadow = vi.fn(() => undefined);
    registerCustomCommand({ name: "MiXeD", description: "custom", run: custom });
    registerCustomCommand({ name: "HELP", description: "shadow", run: shadow });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = { workspaceRoot: ".", sessionId: "catalog" } as CommandContext;

    await handleSlashCommand("/MIXED", ctx);
    await handleSlashCommand("/HeLp", ctx);

    expect(custom).toHaveBeenCalledOnce();
    expect(shadow).not.toHaveBeenCalled();
  });
});
