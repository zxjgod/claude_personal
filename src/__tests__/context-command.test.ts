import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countTokensAnthropic } from "../anthropic-adapter.js";
import { contextCommand } from "../commands/context.js";
import type { CommandContext } from "../commands/types.js";
import { registerSkill, renderSkillCatalog, resetSkills } from "../skills.js";
import { buildSystemPrompt, renderSystemPrompt, resetSystemPromptCache } from "../system-prompt.js";
import { estimateTokens } from "../token-estimator.js";
import * as terminalWidth from "../tui/terminal-width.js";
import { palette } from "../tui/theme.js";
import type { Tool } from "../types.js";

vi.mock("../anthropic-adapter.js", () => ({ countTokensAnthropic: vi.fn(async () => null) }));

function makeContext(): CommandContext {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(40) }] }],
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "test" },
    callModel: async function* () {},
    workspaceRoot: "/workspace",
    sessionId: "test",
    systemPrompt: "y".repeat(80),
  };
}

async function output(ctx = makeContext(), args = ""): Promise<string> {
  await contextCommand.run(args, ctx);
  return vi.mocked(console.log).mock.calls.flat().join("\n");
}

beforeEach(() => {
  vi.mocked(countTokensAnthropic).mockResolvedValue(null);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(terminalWidth, "terminalColumns").mockReturnValue(120);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSkills();
  resetSystemPromptCache();
});

describe("/context usage display", () => {
  it("renders the grid alongside the model and six categories", async () => {
    const text = await output();
    expect(text).toContain("Context Usage");
    expect(text).toMatch(/⛁.*gpt-4o/);
    expect(text).toContain("35/128.0k tokens (0%)");
    expect(text).toContain("System prompt: 23 tokens");
    expect(text).toContain("Messages: 12 tokens");
    expect(text).toContain("System tools: 0 tokens");
    expect(text).toContain("Memory files: 0 tokens");
    expect(text).toContain("Skills: 0 tokens");
    expect(text).toContain("Free space:");
    expect(text).toContain("Memory files · /memory");
    expect(text).toContain("Skills · /skills");
    expect(text).toContain("Built-in");
    expect(text).toContain("deep-research: ~");
    expect(text).not.toContain("Compaction window");
    expect(text).not.toContain("Skill entries estimate");
  });

  it("does not subtract the system prompt from conversation tokens or count it twice", async () => {
    const ctx = makeContext();
    ctx.messages.unshift({ role: "system", content: ctx.systemPrompt ?? "" });
    const text = await output(ctx, "--details");
    expect(text).toContain("Total: ~35 tokens");
    expect(text).toContain("Messages: 12 tokens");
  });

  it("uses system messages when a separate prompt is not available", async () => {
    const ctx = makeContext();
    ctx.systemPrompt = undefined;
    ctx.messages.unshift({ role: "system", content: "y".repeat(80) });
    expect(await output(ctx, "--details")).toContain("Total: ~35 tokens");
  });

  it("counts injected system reminders as conversation rather than dropping them", async () => {
    const ctx = makeContext();
    ctx.messages.push({ role: "system", content: "z".repeat(35) });
    const text = await output(ctx, "--details");
    expect(text).toContain("Total: ~45 tokens");
    expect(text).toContain("Messages: 22 tokens");
  });

  it("lists only loaded memory and splits it out without adding it again", async () => {
    const ctx = makeContext();
    const content = "Project memory";
    ctx.contextMemoryFiles = [{ path: "/workspace/CLAUDE.md", content }];
    ctx.systemPrompt = renderSystemPrompt(
      buildSystemPrompt({
        workspaceRoot: ctx.workspaceRoot,
        tools: [],
        claudeMdContent: content,
      }),
    );
    const total = estimateTokens([{ role: "system", content: ctx.systemPrompt }, ...ctx.messages]);
    const text = await output(ctx, "--details");
    expect(text).toContain("/workspace/CLAUDE.md:");
    const reported = text.match(/Total: ~([\d.]+)(k?) tokens/);
    expect(reported).not.toBeNull();
    if (!reported) throw new Error("Missing token total");
    const reportedTokens = Number(reported[1]) * (reported[2] ? 1000 : 1);
    expect(Math.abs(reportedTokens - total)).toBeLessThan(51);
    vi.mocked(console.log).mockClear();
    ctx.systemPrompt = "No memory loaded";
    expect(await output(ctx)).toContain("No memory files loaded");
  });

  it("groups disk and MCP skills without loading their bodies", async () => {
    const body = vi.fn(async () => "expensive body");
    registerSkill({
      name: "user-template",
      description: "User skill",
      source: "disk",
      getPromptForCommand: body,
    });
    registerSkill({
      name: "remote-template",
      description: "Remote skill",
      source: "mcp",
      getPromptForCommand: body,
    });
    const text = await output();
    expect(text).toContain("User\n");
    expect(text).toContain("user-template: ~");
    expect(text).toContain("MCP\n");
    expect(text).toContain("remote-template: ~");
    expect(body).not.toHaveBeenCalled();
  });

  it("counts a skill catalog only when it is actually included in the prompt", async () => {
    const ctx = makeContext();
    ctx.systemPrompt += `\n\n${renderSkillCatalog().text}`;
    expect(await output(ctx)).toMatch(/Skills: [1-9][\d.]*[k]? tokens/);
  });

  it("counts enabled tool schemas but not disabled ones", async () => {
    const ctx = makeContext();
    const tool = {
      name: "read",
      promptDescription: "Read a file",
      inputSchema: { type: "object", properties: {}, required: [] },
      isEnabled: () => true,
    } as unknown as Tool;
    ctx.tools = [
      { tool, source: "core" },
      { tool: { ...tool, isEnabled: () => false }, source: "core" },
    ];
    const tokens = estimateTokens([
      {
        role: "system",
        content: JSON.stringify({
          name: tool.name,
          description: tool.promptDescription,
          parameters: tool.inputSchema,
        }),
      },
    ]);
    expect(await output(ctx)).toContain(`System tools: ${tokens} tokens`);
  });

  it("supports model window suffixes and explicit overrides", async () => {
    const ctx = makeContext();
    ctx.modelConfig.model = "custom-model[1m]";
    expect(await output(ctx)).toContain("35/1m tokens");
    vi.mocked(console.log).mockClear();
    ctx.contextWindow = 64_000;
    expect(await output(ctx)).toContain("35/64.0k tokens");
  });

  it("marks unknown capacity estimates and ignores invalid overrides", async () => {
    const ctx = makeContext();
    ctx.modelConfig.model = "unknown-model";
    ctx.contextWindow = Number.NaN;
    expect(await output(ctx)).toContain("using an estimated 200k capacity");
  });

  it("stacks the legend and grid on narrow terminals", async () => {
    vi.mocked(terminalWidth.terminalColumns).mockReturnValue(50);
    const text = await output();
    expect(text).not.toMatch(/⛁.*gpt-4o/);
    const rows = text.split("\n").filter((line) => /^\s+[⛁⛶](?: [⛁⛶])+$/.test(line));
    expect(rows).toHaveLength(10);
    expect(rows.every((line) => terminalWidth.visualWidth(line) <= 50)).toBe(true);
  });

  it("clamps free space at zero and warns when capacity is exceeded", async () => {
    const ctx = makeContext();
    ctx.contextWindow = 10;
    const text = await output(ctx);
    expect(text).toContain("Free space: 0 (0.0%)");
    expect(text).toContain("capacity exceeded");
  });

  it("keeps the auto-compaction warning separate from model capacity", async () => {
    const ctx = makeContext();
    ctx.messages = [{ role: "user", content: [{ type: "text", text: "x".repeat(600_000) }] }];
    ctx.contextWindow = 1_000_000;
    expect(await output(ctx, "--details")).toContain("next turn will auto-compact");
  });

  it("colors only category glyphs and keeps labels neutral with secondary values", async () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const text = await output();
      expect(text).toContain(
        `${chalk.yellow("⛁")} ${chalk.hex(palette.text)("Skills:")} ${chalk.hex(palette.secondary)("0 tokens (0.0%)")}`,
      );
      expect(text).toContain(
        `${chalk.hex(palette.secondary)("⛁")} ${chalk.hex(palette.text)("System prompt:")} ${chalk.hex(palette.secondary)("23 tokens (0.0%)")}`,
      );
    } finally {
      chalk.level = previousLevel;
    }
  });

  it("aligns section headings with the grid and leaves a row between sections", async () => {
    const text = await output();
    expect(text).toContain("\n\n     Memory files · /memory\n");
    expect(text).toContain("No memory files loaded\n\n     Skills · /skills\n\n     Built-in\n");
    expect(text).toContain("     └ verify: ~");
  });

  it("keeps estimates and compaction headroom available via --details", async () => {
    const text = await output(makeContext(), "--details");
    expect(text).toContain("Total: ~35 tokens");
    expect(text).toContain("Compaction window");
    expect(text).toContain("headroom");
  });

  it("preserves provider token calibration after integrating remote main", async () => {
    vi.mocked(countTokensAnthropic).mockResolvedValue(70);
    const text = await output(makeContext(), "--details");
    expect(text).toContain("70/128.0k tokens");
    expect(text).toContain("Total: 70 tokens (count_tokens API ground truth");
    expect(text).toContain("System prompt: 46 tokens");
    expect(text).toContain("Messages: 24 tokens");
  });

  it("uses the same model-derived compaction threshold as the remote agent loop", async () => {
    const text = await output(makeContext(), "--details");
    expect(text).toContain("Compaction window: 108,800 tokens");
  });
});
