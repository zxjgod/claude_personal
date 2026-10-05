import * as path from "node:path";
import chalk from "chalk";
import { countTokensAnthropic } from "../anthropic-adapter.js";
import { modelContextWindow } from "../model-metadata.js";
import { listSkills, renderSkillCatalog } from "../skills.js";
import { DYNAMIC_BOUNDARY } from "../system-prompt.js";
import { estimateTokens } from "../token-estimator.js";
import { sanitizeTerminalText, terminalColumns, visualWidth } from "../tui/terminal-width.js";
import { palette } from "../tui/theme.js";
import type { CommandContext, SlashCommand } from "./types.js";

function textTokens(text: string): number {
  return estimateTokens([{ role: "system", content: text }]);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function contextWindow(ctx: CommandContext): { tokens: number; estimated: boolean } {
  const configured = ctx.contextWindow ?? ctx.modelConfig.options?.contextWindow;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return { tokens: configured, estimated: false };
  }
  const suffix = ctx.modelConfig.model.match(/\[(\d+(?:\.\d+)?)([km])\]/i);
  if (suffix && Number(suffix[1]) > 0) {
    return {
      tokens: Number(suffix[1]) * (suffix[2].toLowerCase() === "m" ? 1e6 : 1e3),
      estimated: false,
    };
  }
  const known = modelContextWindow(ctx.modelConfig.model);
  return { tokens: known ?? 200_000, estimated: known === null };
}

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show context usage, category grid, memory files, and skills",
  run: async (args, ctx): Promise<undefined> => {
    try {
      const window = contextWindow(ctx);
      const modelWindow = modelContextWindow(ctx.modelConfig.model);
      const threshold = modelWindow !== null ? Math.floor(modelWindow * 0.85) : 150_000;
      const systemMessages = ctx.messages.filter((message) => message.role === "system");
      let prompt =
        ctx.systemPrompt ?? systemMessages.map((message) => message.content).join("\n\n");
      const originalPrompt = prompt;
      const memoryFiles = ctx.contextMemoryFiles ?? [];
      const loadedMemory: Array<{ path: string; tokens: number }> = [];
      for (const file of memoryFiles) {
        const section = `[PROJECT CONTEXT from CLAUDE.md]\n${file.content}`;
        if (file.content && prompt.includes(section)) {
          loadedMemory.push({ path: file.path, tokens: textTokens(section) });
          prompt = prompt.replace(section, "");
        }
      }
      if (memoryFiles.length === 0) {
        const section = prompt.match(
          /\[PROJECT CONTEXT from CLAUDE\.md\]\n[\s\S]*?(?=\n\n\[(?:GIT STATUS|LANGUAGE PREFERENCE|MCP SERVERS|SCRATCHPAD|SESSION GOAL)\]|$)/,
        )?.[0];
        if (section) {
          loadedMemory.push({
            path: path.join(ctx.workspaceRoot, "CLAUDE.md"),
            tokens: textTokens(section),
          });
          prompt = prompt.replace(section, "");
        }
      }
      const catalog = renderSkillCatalog();
      const skillTokens =
        catalog.text && prompt.includes(catalog.text) ? textTokens(catalog.text) : 0;
      if (skillTokens) prompt = prompt.replace(catalog.text, "");
      const toolStart = prompt.indexOf("AVAILABLE TOOLS:");
      const toolEnd = prompt.indexOf(DYNAMIC_BOUNDARY, toolStart);
      const toolSection =
        toolStart >= 0 && toolEnd > toolStart ? prompt.slice(toolStart, toolEnd) : "";
      const schemaTokens = (ctx.tools ?? [])
        .filter(({ tool }) => tool.isEnabled())
        .reduce(
          (sum, { tool }) =>
            sum +
            textTokens(
              JSON.stringify({
                name: tool.name,
                description: tool.promptDescription,
                parameters: tool.inputSchema,
              }),
            ),
          0,
        );
      const memoryTokens = loadedMemory.reduce((sum, file) => sum + file.tokens, 0);
      const toolTokens = textTokens(toolSection) + schemaTokens;
      const messageTokens = estimateTokens(
        ctx.messages.filter(
          (message) =>
            message.role !== "system" ||
            (ctx.systemPrompt !== undefined && message.content !== ctx.systemPrompt),
        ),
      );
      const systemTokens = Math.max(
        0,
        textTokens(originalPrompt) - memoryTokens - skillTokens - textTokens(toolSection),
      );
      const estimatedTotal = systemTokens + toolTokens + memoryTokens + skillTokens + messageTokens;
      const apiCount = await countTokensAnthropic(
        ctx.modelConfig,
        originalPrompt,
        ctx.messages,
        (ctx.tools ?? []).map(({ tool }) => tool),
      );
      const total = apiCount ?? estimatedTotal;
      const primary = chalk.hex(palette.text);
      const secondary = chalk.hex(palette.secondary);
      const categories = [
        { label: "System prompt", tokens: systemTokens, color: secondary },
        { label: "System tools", tokens: toolTokens, color: secondary },
        { label: "Memory files", tokens: memoryTokens, color: chalk.hex("#cc785c") },
        { label: "Skills", tokens: skillTokens, color: chalk.yellow },
        { label: "Messages", tokens: messageTokens, color: chalk.hex("#8b80c7") },
        { label: "Free space", tokens: Math.max(0, window.tokens - total), color: secondary },
      ];
      if (apiCount !== null && estimatedTotal > 0) {
        let estimatedCumulative = 0;
        let calibratedCumulative = 0;
        for (const category of categories.slice(0, -1)) {
          estimatedCumulative += category.tokens;
          const calibrated = Math.round((estimatedCumulative / estimatedTotal) * apiCount);
          category.tokens = calibrated - calibratedCumulative;
          calibratedCumulative = calibrated;
        }
      }
      const legend = [
        secondary(ctx.modelConfig.model),
        secondary(
          `${formatTokens(total)}/${formatTokens(window.tokens)} tokens (${Math.round((total / window.tokens) * 100)}%)`,
        ),
        "",
        secondary.italic("Estimated usage by category"),
        ...categories.map(
          (category) =>
            `${category.color(category.label === "Free space" ? "⛶" : "⛁")} ${primary(`${category.label}:`)} ${secondary(`${formatTokens(category.tokens)}${category.label === "Free space" ? "" : " tokens"} (${((category.tokens / window.tokens) * 100).toFixed(1)}%)`)}`,
        ),
      ];
      const columns = terminalColumns();
      const indent = "     ";
      const gridColumns = Math.max(1, Math.min(20, Math.floor((columns - 7) / 2)));
      const cellCount = gridColumns * 10;
      const cells: string[] = [];
      for (const category of categories.slice(0, -1)) {
        const count = Math.min(
          cellCount - cells.length,
          Math.ceil((category.tokens / window.tokens) * cellCount),
        );
        for (let index = 0; index < count; index++) cells.push(category.color("⛁"));
      }
      while (cells.length < cellCount) cells.push(secondary("⛶"));
      const grid = Array.from({ length: 10 }, (_, row) =>
        cells.slice(row * gridColumns, (row + 1) * gridColumns).join(" "),
      );
      const gridWidth = visualWidth(grid[0]);
      const sideBySide = gridWidth + 8 + Math.max(...legend.map(visualWidth)) <= columns;

      console.log("");
      console.log(chalk.bold("  └ Context Usage"));
      if (sideBySide) {
        for (let row = 0; row < Math.max(grid.length, legend.length); row++) {
          console.log(`${indent}${grid[row] ?? " ".repeat(gridWidth)}   ${legend[row] ?? ""}`);
        }
      } else {
        for (const line of legend) console.log(`${indent}${line}`);
        console.log("");
        for (const line of grid) console.log(`${indent}${line}`);
      }
      console.log("");
      console.log(`${indent}${primary("Memory files")} ${secondary("· /memory")}`);
      if (loadedMemory.length === 0) console.log(secondary(`${indent}└ No memory files loaded`));
      loadedMemory.forEach((file, index) => {
        // Path comes from memory-file discovery (project/user dirs) — sanitize
        // the display of the discovered path.
        console.log(
          `${indent}${secondary(index === loadedMemory.length - 1 ? "└" : "├")} ${primary(`${sanitizeTerminalText(file.path)}:`)} ${secondary(`${formatTokens(file.tokens)} tokens`)}`,
        );
      });
      console.log("");
      console.log(`${indent}${primary("Skills")} ${secondary("· /skills")}`);
      const skills = listSkills();
      for (const [label, source] of [
        ["User", "disk"],
        ["Built-in", "builtin"],
        ["MCP", "mcp"],
      ] as const) {
        const group = skills.filter((skill) => (skill.source ?? "builtin") === source);
        if (group.length === 0) continue;
        console.log("");
        console.log(secondary(`${indent}${label}`));
        group.forEach((skill, index) => {
          const line = `- ${skill.name}: ${skill.description.length > 100 ? `${skill.description.slice(0, 97)}...` : skill.description}${skill.whenToUse ? ` — use when: ${skill.whenToUse}` : ""}`;
          // name is SKILL.md frontmatter — project/user file content.
          console.log(
            `${indent}${secondary(index === group.length - 1 ? "└" : "├")} ${primary(`${sanitizeTerminalText(skill.name)}:`)} ${secondary(`~${formatTokens(textTokens(line))} tokens`)}`,
          );
        });
      }
      const showDetails = args.trim() === "--details";
      if (showDetails || window.estimated || total > window.tokens) console.log("");
      if (window.estimated)
        console.log(
          chalk.gray("    Unknown model context window; using an estimated 200k capacity."),
        );
      if (total > window.tokens)
        console.log(chalk.yellow("    Context capacity exceeded. Run /compact to free space."));
      if (!showDetails) return;
      console.log(
        secondary(`${indent}Skill entries estimate discovery metadata, not unloaded skill bodies.`),
      );
      console.log(
        chalk.gray(
          apiCount !== null
            ? `    Total: ${formatTokens(total)} tokens (count_tokens API ground truth; category split estimated).`
            : `    Total: ~${formatTokens(total)} tokens (estimated, not provider-reported).`,
        ),
      );
      console.log(chalk.gray(`    Compaction window: ${threshold.toLocaleString()} tokens`));
      const conversationTokens = apiCount ?? estimateTokens(ctx.messages);
      console.log(
        conversationTokens > threshold
          ? chalk.yellow(
              "    Over the threshold — the next turn will auto-compact. Run /compact to preview.",
            )
          : chalk.gray(
              `    ${(threshold - conversationTokens).toLocaleString()} tokens of headroom before auto-compaction.`,
            ),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`  Failed to estimate tokens: ${detail}`));
    }
  },
};

export default contextCommand;
